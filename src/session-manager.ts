import {ChannelType, PermissionFlagsBits, type Client, type VoiceState} from 'discord.js';
import {SessionSelectionChangedError, TranscriberSession} from './session.js';
import {config} from './config.js';
import {assignmentKey, loadAssignments, removeAssignment, upsertAssignment, loadGuildSettings, upsertGuildSettings, type Assignment} from './state.js';

/** Only messages from this class are safe to show in command responses. */
export class AssignmentError extends Error {
	constructor(message: string) { super(message); this.name = 'AssignmentError'; }
}

type ManagedSession = Pick<TranscriberSession, 'assignment' | 'start' | 'stop' | 'state' | 'isDeafened' | 'error' | 'onVoiceStateUpdate' | 'updateDestination' | 'announceAssignment'>;
type Dependencies = {
	createSession: (client: Client, assignment: Assignment, labelSource: (logChannelId: string) => boolean, onConnectionLost: () => void, isSelected: () => boolean) => ManagedSession;
	loadAssignments: typeof loadAssignments;
	upsertAssignment: typeof upsertAssignment;
	removeAssignment: typeof removeAssignment;
	loadGuildSettings: typeof loadGuildSettings;
	upsertGuildSettings: typeof upsertGuildSettings;
	retryDelayMs: number;
	leaveVoice: (guildId: string) => void | Promise<void>;
};
type Entry = {assignment: Assignment; error?: string; retryAt?: number};
type Active = {key: string; session: ManagedSession; lost: boolean; starting: boolean; retryAt?: number};
export type AssignmentStatus = {assignment: Assignment; botId?: string; state: string; isDeafened: boolean; error?: string};
const destinations = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);

/** Saved mappings are unlimited; this bot selects one occupied channel per guild. */
export class SessionManager {
	private readonly entries = new Map<string, Entry>();
	private readonly active = new Map<string, Active>();
	private readonly draining = new Map<string, Active>();
	private readonly follow = new Map<string, string>();
	private readonly waitingOrder = new Map<string, number>();
	private nextWaitingOrder = 0;
	private readonly mutations = new Map<string, Promise<unknown>>();
	private readonly queuedReconciles = new Map<string, Promise<void>>();
	private readonly revisions = new Map<string, number>();
	private readonly retryTimers = new Map<string, NodeJS.Timeout>();
	private readonly pendingMoves = new Set<string>();
	private readonly dependencies: Dependencies;
	private stopping = false;
	private restoring = false;

	constructor(private readonly client: Client, dependencies: Partial<Dependencies> = {}) {
		this.dependencies = {
			createSession: (client, assignment, labelSource, onConnectionLost, isSelected) => new TranscriberSession(client, assignment, {labelSource, onConnectionLost, isSelected}),
			loadAssignments, upsertAssignment, removeAssignment, loadGuildSettings, upsertGuildSettings,
			retryDelayMs: 5000,
			leaveVoice: guildId => {
				const guild = this.client.guilds.cache.get(guildId);
				if (!guild) throw new Error('Cannot leave voice while the guild is unavailable.');
				guild.shard.send({op: 4, d: {guild_id: guildId, channel_id: null, self_mute: true, self_deaf: false}});
			},
			...dependencies,
		};
	}

	list(guildId: string): AssignmentStatus[] {
		const current = this.active.get(guildId);
		const humans = this.humanChannels(guildId);
		return this.guildEntries(guildId).map(([key, entry]) => {
			const selected = current?.key === key ? current : undefined;
			return {
				assignment: {...entry.assignment}, botId: selected ? this.client.user?.id : undefined,
				state: selected?.lost ? 'error' : selected?.session.state ?? (entry.error ? 'error' : humans.has(entry.assignment.voiceChannelId) ? 'waiting' : 'idle'),
				isDeafened: selected?.session.isDeafened ?? false,
				error: selected?.lost ? 'Voice connection interrupted. Retrying shortly.' : entry.error ?? selected?.session.error,
			};
		});
	}

	getFollow(guildId: string): string | undefined { return this.follow.get(guildId); }

	async setFollow(guildId: string, userId: string | undefined): Promise<void> {
		await this.serialize(guildId, async () => {
			this.assertAvailable(guildId);
			if (userId) {
				const member = await this.client.guilds.cache.get(guildId)!.members.fetch(userId).catch(() => null);
				if (!member || member.user.bot) throw new AssignmentError('Choose a human member of this server to follow.');
			}
			this.assertAvailable(guildId);
			this.dependencies.upsertGuildSettings(userId ? {guildId, followUserId: userId} : {guildId});
			if (userId) this.follow.set(guildId, userId); else this.follow.delete(guildId);
			await this.reconcileGuild(guildId);
		});
	}

	async restore(): Promise<void> {
		// Read both stores first. Corrupt data must fail startup.
		const assignments = this.dependencies.loadAssignments();
		const settings = this.dependencies.loadGuildSettings();
		this.restoring = true;
		try {
			for (const setting of settings) if (setting.followUserId) this.follow.set(setting.guildId, setting.followUserId);
			for (const assignment of assignments) this.entries.set(assignmentKey(assignment.guildId, assignment.voiceChannelId), {assignment: {...assignment}});
			// Load every route before choosing, so the saved follow target wins on boot.
			for (const guildId of new Set(assignments.map(assignment => assignment.guildId))) {
				await this.serialize(guildId, async () => {
					for (const [, entry] of this.guildEntries(guildId)) {
						try { this.assertAvailable(guildId); await this.validate(this.client, entry.assignment); }
						catch (error) {
							entry.error = this.publicError(error, 'Could not restore this mapping. Check permissions and retry /scribe assign.');
							console.error(`[restore:${guildId}:${entry.assignment.voiceChannelId}]`, error);
						}
					}
					await this.reconcileGuild(guildId, false);
				});
			}
		} finally {
			this.restoring = false;
			for (const guildId of new Set(assignments.map(assignment => assignment.guildId))) {
				if (this.revisions.has(guildId)) this.queueReconcile(guildId);
			}
		}
		await Promise.all(this.queuedReconciles.values());
	}

	async assign(assignment: Assignment, announce = true): Promise<void> {
		await this.serialize(assignment.guildId, async () => {
			this.assertAvailable(assignment.guildId);
			await this.validate(this.client, assignment);
			this.assertAvailable(assignment.guildId);
			const key = assignmentKey(assignment.guildId, assignment.voiceChannelId);
			const previous = this.entries.get(key);
			const destinationChanged = previous?.assignment.logChannelId !== assignment.logChannelId;
			// A failed write must leave an existing call and destination untouched.
			this.dependencies.upsertAssignment(assignment);
			this.entries.set(key, {assignment: {...assignment}});
			const current = this.active.get(assignment.guildId);
			if (current?.key === key && destinationChanged) {
				current.session.updateDestination(assignment.logChannelId);
				if (announce) await current.session.announceAssignment();
			}
			await this.reconcileGuild(assignment.guildId, announce);
		});
	}

	async unassign(guildId: string, voiceChannelId: string): Promise<boolean> {
		return this.serialize(guildId, async () => {
			if (this.stopping) throw new AssignmentError('The transcription service is restarting. Try again shortly.');
			const key = assignmentKey(guildId, voiceChannelId);
			const existed = this.entries.has(key);
			this.dependencies.removeAssignment(guildId, voiceChannelId);
			this.entries.delete(key); this.waitingOrder.delete(key);
			const current = this.active.get(guildId);
			if (current?.key === key) {
				this.active.delete(guildId); this.clearRetry(guildId);
				await current.session.stop(true);
			}
			await this.reconcileGuild(guildId);
			return existed;
		});
	}

	onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
		if (this.stopping) return;
		const guildId = newState.guild.id;
		const current = this.active.get(guildId);
		if (newState.id === this.client.user?.id) {
			// A delayed leave from A must not tear down the new connection to B.
			const channel = current?.session.assignment.voiceChannelId;
			if (channel && (oldState.channelId === channel || newState.channelId === channel)) current?.session.onVoiceStateUpdate(oldState, newState);
			const draining = this.draining.get(guildId);
			if (draining && (newState.deaf || oldState.channelId === draining.session.assignment.voiceChannelId || newState.channelId === draining.session.assignment.voiceChannelId)) {
				draining.session.onVoiceStateUpdate(oldState, newState);
			}
			return;
		}
		if (newState.member?.user.bot ?? oldState.member?.user.bot) return;
		current?.session.onVoiceStateUpdate(oldState, newState);
		if (newState.channelId !== oldState.channelId) {
			if (current?.starting && this.choose(guildId)?.[0] !== current.key) {
				this.pendingMoves.add(guildId);
				void current.session.stop(false, {disconnect: false}).catch(error => console.error(`[cancel-join:${guildId}]`, error));
			}
			this.queueReconcile(guildId);
		}
	}

	async stop(): Promise<void> {
		this.stopping = true;
		for (const guildId of this.retryTimers.keys()) this.clearRetry(guildId);
		// Interrupt pending joins/drains before waiting for serialized mutations.
		await Promise.allSettled([...this.active.values(), ...this.draining.values()].map(current => current.session.stop(false)));
		await Promise.allSettled(this.mutations.values());
		await Promise.allSettled([...this.active.values()].map(current => current.session.stop(false)));
		this.active.clear();
		await Promise.allSettled([...this.pendingMoves].map(guildId => this.leavePendingMove(guildId)));
	}

	private guildEntries(guildId: string): Array<[string, Entry]> {
		return [...this.entries].filter(([, entry]) => entry.assignment.guildId === guildId);
	}

	private humanChannels(guildId: string): Map<string, Set<string>> {
		const channels = new Map<string, Set<string>>();
		for (const state of this.client.guilds.cache.get(guildId)?.voiceStates.cache.values() ?? []) {
			if (!state.channelId || state.id === this.client.user?.id) continue;
			const bot = state.member?.user.bot ?? this.client.users.cache.get(state.id)?.bot;
			if (bot !== false) continue;
			if (!channels.has(state.channelId)) channels.set(state.channelId, new Set());
			channels.get(state.channelId)!.add(state.id);
		}
		return channels;
	}

	private choose(guildId: string): [string, Entry] | undefined {
		const humans = this.humanChannels(guildId);
		const entries = this.guildEntries(guildId);
		for (const [key, entry] of entries) {
			if (humans.has(entry.assignment.voiceChannelId)) {
				if (!this.waitingOrder.has(key)) this.waitingOrder.set(key, this.nextWaitingOrder++);
			} else this.waitingOrder.delete(key);
		}
		const eligible = entries.filter(([, entry]) => humans.has(entry.assignment.voiceChannelId) && (!entry.error || (entry.retryAt !== undefined && entry.retryAt <= Date.now())));
		const followed = this.follow.get(guildId);
		const priority = followed && eligible.find(([, entry]) => humans.get(entry.assignment.voiceChannelId)?.has(followed));
		if (priority) return priority;
		const current = this.active.get(guildId);
		const existing = current && eligible.find(([key]) => key === current.key);
		if (existing) return existing;
		return eligible.sort(([left], [right]) => this.waitingOrder.get(left)! - this.waitingOrder.get(right)!)[0];
	}

	private async reconcileGuild(guildId: string, announce = true): Promise<void> {
		while (!this.stopping) {
			const target = this.choose(guildId);
			const current = this.active.get(guildId);
			if (current && target?.[0] === current.key && (!current.lost || (current.retryAt ?? 0) > Date.now())) {
				this.scheduleNextRetry(guildId);
				return;
			}
			if (current) {
				if (target) {
					try { await this.validate(this.client, target[1].assignment); }
					catch (error) {
						target[1].error = this.publicError(error, 'Cannot access this mapping. Check permissions and retry /scribe assign.');
						target[1].retryAt = undefined;
						continue;
					}
					if (this.choose(guildId)?.[0] !== target[0]) continue;
				}
				if (this.stopping) return;
				this.active.delete(guildId); this.clearRetry(guildId);
				const empty = !this.humanChannels(guildId).has(current.session.assignment.voiceChannelId);
				if (target) this.pendingMoves.add(guildId);
				this.draining.set(guildId, current);
				try { await current.session.stop(false, {flushFinalAudio: empty && !current.lost, disconnect: !target}); }
				finally { if (this.draining.get(guildId) === current) this.draining.delete(guildId); }
				continue; // Re-read occupancy after the bounded final-audio drain.
			}
			if (!target) { await this.leavePendingMove(guildId); this.scheduleNextRetry(guildId); return; }
			const [key, entry] = target;
			try { this.assertAvailable(guildId); await this.validate(this.client, entry.assignment); }
			catch (error) {
				entry.error = this.publicError(error, 'Cannot access this mapping. Check permissions and retry /scribe assign.');
				entry.retryAt = undefined;
				console.error(`[select:${key}]`, error);
				continue;
			}
			if (this.stopping) return;
			if (this.choose(guildId)?.[0] !== key) continue;
			this.clearRetry(guildId);
			const session = this.dependencies.createSession(this.client, {...entry.assignment}, logChannelId =>
				this.guildEntries(guildId).filter(([, candidate]) => candidate.assignment.logChannelId === logChannelId).length > 1,
			() => this.connectionLost(guildId, session),
			() => !this.stopping && this.choose(guildId)?.[0] === key);
			const selected: Active = {key, session, lost: false, starting: true};
			this.active.set(guildId, selected);
			try {
				await session.start(announce);
				selected.starting = false;
				this.pendingMoves.delete(guildId);
				entry.error = undefined; entry.retryAt = undefined;
			} catch (error) {
				if (this.active.get(guildId) === selected) this.active.delete(guildId);
				if (!this.stopping && (error instanceof SessionSelectionChangedError || this.choose(guildId)?.[0] !== key)) {
					const next = this.choose(guildId);
					if (next) this.pendingMoves.add(guildId);
					await session.stop(false, {disconnect: !next});
					if (!next) await this.leavePendingMove(guildId);
					continue;
				}
				await session.stop(false);
				await this.leavePendingMove(guildId);
				if (this.stopping) return;
				entry.error = 'Could not connect to this voice channel. Retrying shortly.';
				entry.retryAt = Date.now() + this.dependencies.retryDelayMs;
				console.error(`[connect:${key}]`, error);
				this.scheduleNextRetry(guildId);
			}
			// Re-read current voice states after awaited Ready, never the old event.
		}
	}

	private async leavePendingMove(guildId: string): Promise<void> {
		if (!this.pendingMoves.has(guildId)) return;
		await this.dependencies.leaveVoice(guildId);
		this.pendingMoves.delete(guildId);
	}

	private connectionLost(guildId: string, session: ManagedSession): void {
		const current = this.active.get(guildId);
		if (this.stopping || current?.session !== session || current.lost) return;
		current.lost = true;
		current.retryAt = Date.now() + this.dependencies.retryDelayMs;
		this.scheduleNextRetry(guildId);
	}

	private scheduleNextRetry(guildId: string): void {
		if (this.stopping) return;
		const occupied = this.humanChannels(guildId);
		const current = this.active.get(guildId);
		const followed = this.follow.get(guildId);
		const times = this.guildEntries(guildId).flatMap(([key, entry]) => {
			if (entry.retryAt === undefined || !occupied.has(entry.assignment.voiceChannelId)) return [];
			if (current && !current.lost && current.key !== key && (!followed || !occupied.get(entry.assignment.voiceChannelId)?.has(followed))) return [];
			return [entry.retryAt];
		});
		const activeRetry = current?.retryAt;
		if (activeRetry !== undefined) times.push(activeRetry);
		this.clearRetry(guildId);
		if (times.length === 0) return;
		this.retryTimers.set(guildId, setTimeout(() => {
			this.retryTimers.delete(guildId); this.queueReconcile(guildId);
		}, Math.max(1, Math.min(...times) - Date.now())));
	}

	private clearRetry(guildId: string): void {
		const timer = this.retryTimers.get(guildId);
		if (timer) clearTimeout(timer);
		this.retryTimers.delete(guildId);
	}

	private queueReconcile(guildId: string): void {
		this.revisions.set(guildId, (this.revisions.get(guildId) ?? 0) + 1);
		if (this.stopping || this.restoring || this.queuedReconciles.has(guildId)) return;
		let processedRevision: number | undefined;
		const pending = this.serialize(guildId, async () => {
			do {
				processedRevision = this.revisions.get(guildId);
				await this.reconcileGuild(guildId);
			} while (!this.stopping && processedRevision !== this.revisions.get(guildId));
		}).catch(error => console.error(`[route:${guildId}]`, error));
		this.queuedReconciles.set(guildId, pending);
		void pending.finally(() => {
			if (this.queuedReconciles.get(guildId) === pending) this.queuedReconciles.delete(guildId);
			if (!this.stopping && processedRevision !== this.revisions.get(guildId)) this.queueReconcile(guildId);
		});
	}

	private assertAvailable(guildId: string): void {
		if (this.stopping) throw new AssignmentError('The transcription service is restarting. Try again shortly.');
		if (config.allowedGuildIds.length > 0 && !config.allowedGuildIds.includes(guildId)) throw new AssignmentError('This server is not allowed to use the transcription service.');
		if (!this.client.isReady() || !this.client.guilds.cache.has(guildId)) throw new AssignmentError('The bot is not ready in this server. Try again shortly.');
	}

	private publicError(error: unknown, fallback: string): string { return error instanceof AssignmentError ? error.message : fallback; }

	private async serialize<T>(guildId: string, work: () => Promise<T>): Promise<T> {
		const pending = (this.mutations.get(guildId) ?? Promise.resolve()).catch(() => undefined).then(work);
		this.mutations.set(guildId, pending);
		try { return await pending; }
		finally { if (this.mutations.get(guildId) === pending) this.mutations.delete(guildId); }
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

}
