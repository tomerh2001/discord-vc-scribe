import {ChannelType, PermissionFlagsBits, type Client, type VoiceState} from 'discord.js';
import {TranscriberSession} from './session.js';
import {config} from './config.js';
import {assignmentKey, loadAssignments, removeAssignment, upsertAssignment, type Assignment} from './state.js';

/** Only messages from this class are safe to show in command responses. */
export class AssignmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AssignmentError';
	}
}

type ManagedSession = Pick<TranscriberSession,
	'assignment' | 'start' | 'stop' | 'state' | 'isDeafened' | 'error' | 'onVoiceStateUpdate'
	| 'updateDestination' | 'announceAssignment'>;

type Dependencies = {
	createSession: (client: Client, assignment: Assignment, labelSource: (logChannelId: string) => boolean) => ManagedSession;
	loadAssignments: typeof loadAssignments;
	upsertAssignment: typeof upsertAssignment;
	removeAssignment: typeof removeAssignment;
};

type Entry = {assignment: Assignment; client?: Client; session?: ManagedSession; error?: string};

export type AssignmentStatus = {
	assignment: Assignment;
	botId?: string;
	state: string;
	isDeafened: boolean;
	error?: string;
};

const destinations = new Set([
	ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice,
	ChannelType.GuildStageVoice, ChannelType.PublicThread, ChannelType.PrivateThread,
	ChannelType.AnnouncementThread,
]);

export class SessionManager {
	private readonly entries = new Map<string, Entry>();
	private readonly mutations = new Map<string, Promise<unknown>>();
	private readonly dependencies: Dependencies;
	private stopping = false;

	constructor(private readonly clients: Client[], dependencies: Partial<Dependencies> = {}) {
		const botIds = clients.flatMap(client => client.user ? [client.user.id] : []);
		if (new Set(botIds).size !== botIds.length) {
			throw new Error('Each voice worker must use a different Discord bot account.');
		}

		this.dependencies = {
			createSession: (client, assignment, labelSource) => new TranscriberSession(client, assignment, {labelSource}),
			loadAssignments, upsertAssignment, removeAssignment, ...dependencies,
		};
	}

	list(guildId: string): AssignmentStatus[] {
		return [...this.entries.values()].filter(entry => entry.assignment.guildId === guildId)
			.map(entry => ({
				assignment: {...entry.assignment},
				botId: entry.client?.user?.id,
				state: entry.session?.state ?? 'error',
				isDeafened: entry.session?.isDeafened ?? false,
				error: entry.error ?? entry.session?.error,
			}));
	}

	capacity(guildId: string): {total: number; used: number} {
		return {
			total: this.guildClients(guildId).length,
			used: [...this.entries.values()].filter(entry => entry.assignment.guildId === guildId && entry.client).length,
		};
	}

	async restore(): Promise<void> {
		// A corrupt store must fail startup instead of appearing to be an empty store.
		for (const assignment of this.dependencies.loadAssignments()) {
			const key = assignmentKey(assignment.guildId, assignment.voiceChannelId);
			try {
				await this.assign(assignment, false);
			} catch (error) {
				this.entries.set(key, {
					assignment: {...assignment},
					error: error instanceof AssignmentError ? error.message : 'Could not restore this assignment. Check the service logs and retry /assign.',
				});
				console.error(`[restore:${key}]`, error);
			}
		}
	}

	async assign(assignment: Assignment, announce = true): Promise<void> {
		return this.serialize(assignment.guildId, async () => {
			if (this.stopping) {
				throw new AssignmentError('The transcription service is restarting. Try again shortly.');
			}
			if (config.allowedGuildIds.length > 0 && !config.allowedGuildIds.includes(assignment.guildId)) {
				throw new AssignmentError('This server is not allowed to use the transcription service.');
			}

			const key = assignmentKey(assignment.guildId, assignment.voiceChannelId);
			const existing = this.entries.get(key);
			if (existing?.session && existing.client) {
				await this.validate(existing.client, assignment);
				if (existing.assignment.logChannelId === assignment.logChannelId) {
					return;
				}

				// Persist before touching the live session so a disk failure preserves it.
				this.dependencies.upsertAssignment(assignment);
				existing.session.updateDestination(assignment.logChannelId);
				existing.assignment = {...assignment};
				if (announce) {
					await existing.session.announceAssignment();
				}
				return;
			}

			const candidates = this.guildClients(assignment.guildId).filter(client =>
				![...this.entries.values()].some(entry => entry.assignment.guildId === assignment.guildId && entry.client === client));
			if (candidates.length === 0) {
				throw new AssignmentError('No free voice bot is available in this server. Discord allows each bot in one voice channel per server. Add another bot token to DISCORD_WORKER_TOKENS and invite that bot here, or unassign an existing channel.');
			}

			let selected: Client | undefined;
			const problems: string[] = [];
			for (const client of candidates) {
				try {
					await this.validate(client, assignment);
					selected = client;
					break;
				} catch (error) {
					if (!(error instanceof AssignmentError)) {
						throw error;
					}
					problems.push(error.message);
				}
			}
			if (!selected) {
				throw new AssignmentError([...new Set(problems)].join('\n'));
			}

			const session = this.dependencies.createSession(selected, {...assignment}, logChannelId =>
				[...this.entries.values()].filter(entry => entry.assignment.guildId === assignment.guildId
					&& entry.assignment.logChannelId === logChannelId).length > 1);
			this.entries.set(key, {assignment: {...assignment}, client: selected, session});
			try {
				// Ready is awaited for occupied channels. Empty channels remain parked.
				await session.start(false);
				this.dependencies.upsertAssignment(assignment);
			} catch (error) {
				await session.stop(false);
				if (existing) this.entries.set(key, existing);
				else this.entries.delete(key);
				throw error;
			}
			if (announce) {
				await session.announceAssignment();
			}
		});
	}

	async unassign(guildId: string, voiceChannelId: string): Promise<boolean> {
		return this.serialize(guildId, async () => {
			const key = assignmentKey(guildId, voiceChannelId);
			const existing = this.entries.get(key);
			this.dependencies.removeAssignment(guildId, voiceChannelId);
			if (!existing) {
				return false;
			}
			await existing.session?.stop(true);
			this.entries.delete(key);
			return true;
		});
	}

	onVoiceStateUpdate(client: Client, oldState: VoiceState, newState: VoiceState): void {
		// Every client receives every guild event; only the assigned client's copy is routed.
		for (const entry of this.entries.values()) {
			if (entry.client === client && entry.assignment.guildId === newState.guild.id) {
				entry.session?.onVoiceStateUpdate(oldState, newState);
			}
		}
	}

	async stop(): Promise<void> {
		this.stopping = true;
		await Promise.allSettled(this.mutations.values());
		await Promise.all([...this.entries.values()].map(async entry => entry.session?.stop(false)));
		this.entries.clear();
	}

	private guildClients(guildId: string): Client[] {
		return this.clients.filter(client => client.isReady() && client.guilds.cache.has(guildId));
	}

	private async validate(client: Client, assignment: Assignment): Promise<void> {
		const guild = await client.guilds.fetch(assignment.guildId).catch(() => null);
		if (!guild) throw new AssignmentError(`Bot <@${client.user!.id}> cannot access this server.`);
		const [voice, destination, me] = await Promise.all([
			guild.channels.fetch(assignment.voiceChannelId).catch(() => null),
			guild.channels.fetch(assignment.logChannelId).catch(() => null),
			guild.members.fetchMe().catch(() => null),
		]);
		if (!voice || !destination || !me) {
			throw new AssignmentError(`Bot <@${client.user!.id}> cannot access the selected channels. Check that they exist and grant the bot View Channel.`);
		}
		if (!voice || !voice.isVoiceBased() || voice.guild.id !== guild.id) {
			throw new AssignmentError('Choose a voice or Stage channel in this server.');
		}
		if (!destination || !destinations.has(destination.type) || !destination.isTextBased()
			|| !('send' in destination) || destination.guild.id !== guild.id) {
			throw new AssignmentError('Choose a text channel, voice-channel chat, or thread in this server.');
		}
		if (!voice.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
			throw new AssignmentError(`Bot <@${client.user!.id}> needs View Channel and Connect in <#${voice.id}>.`);
		}
		const sendPermission = destination.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
		if (!destination.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, sendPermission])) {
			throw new AssignmentError(`Bot <@${client.user!.id}> needs View Channel and ${destination.isThread() ? 'Send Messages in Threads' : 'Send Messages'} in <#${destination.id}>.`);
		}
		if (destination.isThread() && (destination.archived || destination.locked)) {
			throw new AssignmentError('The destination thread must be open and unlocked.');
		}
		if (destination.type === ChannelType.PrivateThread && !destination.permissionsFor(me)?.has(PermissionFlagsBits.ManageThreads)) {
			const member = await destination.members.fetchMe().catch(() => null);
			if (!member) {
				throw new AssignmentError(`Add bot <@${client.user!.id}> to the private destination thread first.`);
			}
		}
	}

	private async serialize<T>(guildId: string, work: () => Promise<T>): Promise<T> {
		const pending = (this.mutations.get(guildId) ?? Promise.resolve()).catch(() => undefined).then(work);
		this.mutations.set(guildId, pending);
		try {
			return await pending;
		} finally {
			if (this.mutations.get(guildId) === pending) {
				this.mutations.delete(guildId);
			}
		}
	}
}
