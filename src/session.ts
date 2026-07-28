import {
	EndBehaviorType,
	entersState,
	joinVoiceChannel,
	VoiceConnectionStatus,
	type VoiceConnection,
} from '@discordjs/voice';
import type {Client, VoiceBasedChannel, VoiceState} from 'discord.js';
import prism from 'prism-media';
import {pcmDurationMs, pcmToWavMono} from './audio.js';
import {config} from './config.js';
import {
	loadAssignments,
	removeAssignment,
	upsertAssignment,
	type Assignment,
} from './state.js';
import {transcribe} from './stt.js';

const REJOIN_DELAY_MS = 5000;
const TYPING_REFRESH_MS = 8000;

// Whisper's stock hallucinations on breath/noise segments, normalized to
// lowercase without punctuation. Only applied to short segments.
const HALLUCINATIONS = new Set([
	'thank you',
	'thanks for watching',
	'thank you for watching',
	'thank you so much for watching',
	'please subscribe',
	'subtitles by the amaraorg community',
	'you',
	'תודה',
	'תודה רבה',
	'תודה שצפיתם',
]);

function isLikelyHallucination(text: string, durationMs: number): boolean {
	if (durationMs >= 3000) {
		return false;
	}

	const normalized = text.toLowerCase().replaceAll(/[^\p{L}\p{N} ]/gu, '').replaceAll(/\s+/g, ' ').trim();
	return HALLUCINATIONS.has(normalized);
}

export class TranscriberSession {
	private connection: VoiceConnection | undefined;
	private readonly capturing = new Set<string>();
	private deafened = false;
	private destroyed = false;
	/** True when the bot intentionally left because the channel is empty. */
	private parked = false;
	private sendQueue: Promise<unknown> = Promise.resolve();
	private activeWork = 0;
	private typingTimer: NodeJS.Timeout | undefined;

	constructor(
		private readonly client: Client,
		readonly assignment: Assignment,
	) {}

	async start(announce: boolean): Promise<void> {
		const channel = await this.fetchVoiceChannel();
		if (TranscriberSession.hasHumans(channel)) {
			this.join(channel);
		} else {
			this.parked = true;
		}

		const me = await channel.guild.members.fetchMe().catch(() => null);
		this.deafened = Boolean(me?.voice.deaf);

		if (announce) {
			const suffix = this.parked
				? ' The channel is empty, so I will hop in when someone joins.'
				: (this.deafened ? ' I am currently deafened, so transcription is paused.' : '');
			this.log(`📌 Assigned to <#${this.assignment.voiceChannelId}> — logging this call here.${suffix}`);
		}
	}

	private static hasHumans(channel: VoiceBasedChannel): boolean {
		return channel.members.some(member => !member.user.bot);
	}

	async stop(announce: boolean): Promise<void> {
		this.destroyed = true;
		if (announce) {
			this.log('👋 Unassigned — leaving the call.');
			await this.sendQueue.catch(() => undefined);
		}

		try {
			this.connection?.destroy();
		} catch {
			// Already destroyed.
		}

		this.connection = undefined;
		if (this.typingTimer) {
			clearInterval(this.typingTimer);
			this.typingTimer = undefined;
		}
	}

	get isDeafened(): boolean {
		return this.deafened;
	}

	/** Routes voice-state changes: member join/leave logging and the bot's own deafen/move handling. */
	onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
		if (this.destroyed) {
			return;
		}

		if (newState.id === this.client.user?.id) {
			this.onOwnVoiceStateUpdate(newState);
			return;
		}

		if (newState.member?.user.bot ?? oldState.member?.user.bot) {
			return;
		}

		const vcId = this.assignment.voiceChannelId;
		const joined = newState.channelId === vcId && oldState.channelId !== vcId;
		const left = oldState.channelId === vcId && newState.channelId !== vcId;

		if (joined) {
			this.log(`➡️ <@${newState.id}> joined the call.`);
			void this.unparkIfOccupied();
		} else if (left) {
			this.log(`⬅️ <@${newState.id}> left the call.`);
			void this.parkIfEmpty();
		}
	}

	/** Join the voice channel when parked and a human is present. */
	private async unparkIfOccupied(): Promise<void> {
		if (this.destroyed || this.connection) {
			return;
		}

		try {
			const channel = await this.fetchVoiceChannel();
			if (TranscriberSession.hasHumans(channel)) {
				this.parked = false;
				this.join(channel);
			}
		} catch (error) {
			console.error(`[unpark:${this.assignment.guildId}]`, error);
		}
	}

	/** Leave the voice channel (but stay assigned) when no humans remain. */
	private async parkIfEmpty(): Promise<void> {
		if (this.destroyed || !this.connection) {
			return;
		}

		const channel = await this.fetchVoiceChannel().catch(() => null);
		if (!channel || TranscriberSession.hasHumans(channel)) {
			return;
		}

		this.parked = true;
		try {
			this.connection.destroy();
		} catch {
			// Already destroyed.
		}

		this.connection = undefined;
		this.log('💤 Everyone left — parking until someone joins.');
	}

	private onOwnVoiceStateUpdate(state: VoiceState): void {
		// An admin dragged the bot to another channel — treat that as reassignment.
		if (state.channelId && state.channelId !== this.assignment.voiceChannelId) {
			this.assignment.voiceChannelId = state.channelId;
			upsertAssignment({...this.assignment});
			this.log(`📌 Moved — now logging <#${state.channelId}>.`);
		}

		const isDeaf = Boolean(state.deaf);
		if (isDeaf !== this.deafened) {
			this.deafened = isDeaf;
			this.log(isDeaf
				? '🔇 Deafened — transcription paused. Undeafen me to resume.'
				: '🎙️ Undeafened — transcription resumed.');
		}
	}

	private async fetchVoiceChannel(): Promise<VoiceBasedChannel> {
		const guild = await this.client.guilds.fetch(this.assignment.guildId);
		const channel = await guild.channels.fetch(this.assignment.voiceChannelId);
		if (!channel?.isVoiceBased()) {
			throw new Error(`Channel ${this.assignment.voiceChannelId} is not a voice channel.`);
		}

		return channel;
	}

	private join(channel: VoiceBasedChannel): void {
		const connection = joinVoiceChannel({
			channelId: channel.id,
			guildId: channel.guild.id,
			adapterCreator: channel.guild.voiceAdapterCreator,
			selfDeaf: false,
			selfMute: true,
		});
		this.connection = connection;

		connection.receiver.speaking.on('start', userId => {
			console.log(`[voice:${this.assignment.guildId}] speaking start: ${userId}`);
			void this.captureUser(userId);
		});

		connection.on('stateChange', (oldState, newState) => {
			console.log(`[voice:${this.assignment.guildId}] ${oldState.status} -> ${newState.status}`);
		});

		if (process.env.VOICE_DEBUG) {
			connection.on('debug', message => {
				console.log(`[voice-debug:${this.assignment.guildId}] ${message}`);
			});
		}

		connection.on('error', error => {
			console.error(`[voice:${this.assignment.guildId}]`, error);
		});

		// Standard discord.js reconnect dance: brief Disconnected states happen on
		// region changes etc. — only rejoin from scratch if it doesn't recover.
		connection.on(VoiceConnectionStatus.Disconnected, async () => {
			try {
				await Promise.race([
					entersState(connection, VoiceConnectionStatus.Signalling, 5000),
					entersState(connection, VoiceConnectionStatus.Connecting, 5000),
				]);
			} catch {
				try {
					connection.destroy();
				} catch {
					// Already destroyed.
				}

				if (!this.destroyed && !this.parked) {
					setTimeout(() => {
						void this.rejoin();
					}, REJOIN_DELAY_MS);
				}
			}
		});
	}

	private async rejoin(): Promise<void> {
		if (this.destroyed || this.parked) {
			return;
		}

		try {
			const channel = await this.fetchVoiceChannel();
			this.join(channel);
		} catch (error) {
			console.error(`[rejoin:${this.assignment.guildId}]`, error);
			setTimeout(() => {
				void this.rejoin();
			}, REJOIN_DELAY_MS * 3);
		}
	}

	private async captureUser(userId: string): Promise<void> {
		if (this.destroyed || this.deafened || this.capturing.has(userId)) {
			return;
		}

		const user = await this.client.users.fetch(userId).catch(() => null);
		if (!user || user.bot) {
			return;
		}

		this.capturing.add(userId);
		try {
			// Long monologues are flushed in maxSegmentMs chunks; keep capturing
			// until the user actually stops transmitting.
			while (!this.destroyed && !this.deafened && this.connection) {
				await this.captureSegment(userId);
				if (!this.connection.receiver.speaking.users.has(userId)) {
					break;
				}
			}
		} catch (error) {
			console.error(`[capture:${userId}]`, error);
		} finally {
			this.capturing.delete(userId);
		}
	}

	/** Shows "Bot is typing…" in the log channel while audio is being captured or transcribed. */
	private beginWork(): void {
		this.activeWork++;
		if (!this.typingTimer) {
			void this.sendTyping();
			this.typingTimer = setInterval(() => {
				void this.sendTyping();
			}, TYPING_REFRESH_MS);
		}
	}

	private endWork(): void {
		this.activeWork = Math.max(0, this.activeWork - 1);
		if (this.activeWork === 0 && this.typingTimer) {
			clearInterval(this.typingTimer);
			this.typingTimer = undefined;
		}
	}

	private async sendTyping(): Promise<void> {
		if (this.destroyed || this.deafened) {
			return;
		}

		const channel = await this.client.channels.fetch(this.assignment.logChannelId).catch(() => null);
		if (channel?.isTextBased() && 'sendTyping' in channel) {
			await channel.sendTyping().catch(() => undefined);
		}
	}

	private async captureSegment(userId: string): Promise<void> {
		const receiver = this.connection?.receiver;
		if (!receiver) {
			return;
		}

		this.beginWork();
		await new Promise<void>(resolve => {
			const opusStream = receiver.subscribe(userId, {
				end: {behavior: EndBehaviorType.AfterSilence, duration: config.silenceMs},
			});
			const decoder = new prism.opus.Decoder({rate: 48_000, channels: 2, frameSize: 960});
			const chunks: Buffer[] = [];
			let bytes = 0;
			const maxBytes = 48_000 * 4 * (config.maxSegmentMs / 1000);
			let done = false;

			const finish = () => {
				if (done) {
					return;
				}

				done = true;
				decoder.destroy();
				if (!opusStream.destroyed) {
					opusStream.destroy();
				}

				console.log(`[capture:${this.assignment.guildId}] ${userId}: ${bytes} PCM bytes collected`);
				void this.finishSegment(userId, Buffer.concat(chunks));
				resolve();
			};

			decoder.on('data', (chunk: Buffer) => {
				chunks.push(chunk);
				bytes += chunk.length;
				if (bytes >= maxBytes) {
					opusStream.destroy();
				}
			});

			decoder.once('end', finish);
			decoder.once('error', error => {
				console.error(`[decode:${userId}]`, error);
				finish();
			});
			opusStream.once('close', finish);
			opusStream.once('error', error => {
				console.error(`[opus:${userId}]`, error);
				finish();
			});

			opusStream.pipe(decoder);
		});
	}

	private async finishSegment(userId: string, pcm: Buffer): Promise<void> {
		try {
			if (this.destroyed || this.deafened) {
				return;
			}

			const durationMs = Math.round(pcmDurationMs(pcm));
			if (durationMs < config.minSpeechMs) {
				console.log(`[segment:${this.assignment.guildId}] ${userId}: ${durationMs}ms — too short, skipped`);
				return;
			}

			const startedAt = Date.now();
			const {text, language, noSpeechProb, avgLogprob} = await transcribe(pcmToWavMono(pcm));
			console.log(
				`[stt:${this.assignment.guildId}] ${userId}: ${durationMs}ms audio -> ${text.length} chars in `
				+ `${Date.now() - startedAt}ms (lang=${language} nsp=${noSpeechProb.toFixed(2)} alp=${avgLogprob.toFixed(2)})`,
			);
			// Whisper emits punctuation-only or bracketed noise for non-speech audio.
			if (!text || /^[\s.,!?\-–—'"«»()[\]]*$/.test(text)) {
				return;
			}

			if (config.sttLanguages.length > 0 && !config.sttLanguages.includes(language)) {
				console.log(`[stt:${this.assignment.guildId}] ${userId}: dropped ${language} segment (not in allowlist): "${text.slice(0, 60)}"`);
				return;
			}

			if (noSpeechProb > 0.6 && avgLogprob < -0.7) {
				console.log(`[stt:${this.assignment.guildId}] ${userId}: dropped low-confidence segment (nsp=${noSpeechProb.toFixed(2)} alp=${avgLogprob.toFixed(2)}): "${text.slice(0, 60)}"`);
				return;
			}

			if (isLikelyHallucination(text, durationMs)) {
				console.log(`[stt:${this.assignment.guildId}] ${userId}: dropped likely hallucination: "${text}"`);
				return;
			}

			this.log(`<@${userId}> ${text}`.slice(0, 1990));
		} catch (error) {
			console.error(`[stt:${this.assignment.guildId}]`, error);
		} finally {
			this.endWork();
		}
	}

	/** Sends are chained so transcript lines stay in completion order. */
	private log(content: string): void {
		this.sendQueue = this.sendQueue.then(async () => {
			const channel = await this.client.channels.fetch(this.assignment.logChannelId).catch(() => null);
			if (channel?.isTextBased() && 'send' in channel) {
				// Mentions render as @name but never ping anyone.
				await channel.send({content, allowedMentions: {parse: []}})
					.catch(error => {
						console.error(`[log:${this.assignment.guildId}]`, error);
					});
			}
		});
	}
}

export class SessionManager {
	private readonly sessions = new Map<string, TranscriberSession>();

	constructor(private readonly client: Client) {}

	get(guildId: string): TranscriberSession | undefined {
		return this.sessions.get(guildId);
	}

	async restore(): Promise<void> {
		for (const assignment of loadAssignments()) {
			try {
				await this.assign(assignment, false);
				console.log(`Restored session in guild ${assignment.guildId} (VC ${assignment.voiceChannelId})`);
			} catch (error) {
				console.error(`Failed to restore session in guild ${assignment.guildId}:`, error);
			}
		}
	}

	async assign(assignment: Assignment, announce = true): Promise<void> {
		const existing = this.sessions.get(assignment.guildId);
		if (existing) {
			await existing.stop(false);
			this.sessions.delete(assignment.guildId);
		}

		const session = new TranscriberSession(this.client, assignment);
		this.sessions.set(assignment.guildId, session);
		await session.start(announce);
		upsertAssignment(assignment);
	}

	async unassign(guildId: string): Promise<boolean> {
		removeAssignment(guildId);
		const session = this.sessions.get(guildId);
		if (!session) {
			return false;
		}

		await session.stop(true);
		this.sessions.delete(guildId);
		return true;
	}

	onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
		this.sessions.get(newState.guild.id)?.onVoiceStateUpdate(oldState, newState);
	}
}
