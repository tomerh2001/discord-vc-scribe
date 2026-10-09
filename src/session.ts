import {
	EndBehaviorType,
	entersState,
	joinVoiceChannel,
	VoiceConnectionStatus,
	type VoiceConnection,
} from '@discordjs/voice';
import type {Client, VoiceBasedChannel, VoiceState} from 'discord.js';
import type {Transform} from 'node:stream';
import prism from 'prism-media';
import {pcmDurationMs, pcmToWavMono} from './audio.js';
import {config} from './config.js';
import type {Assignment} from './state.js';
import {transcribe} from './stt.js';

const TYPING_REFRESH_MS = 8000;

/** Selection changed during an asynchronous lookup or connection handshake. */
export class SessionSelectionChangedError extends Error {
	constructor() {
		super('The selected voice channel changed before its connection was ready.');
		this.name = 'SessionSelectionChangedError';
	}
}

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

type SessionDependencies = {
	join: typeof joinVoiceChannel;
	waitForReady: (connection: VoiceConnection) => Promise<unknown>;
	transcribe: typeof transcribe;
	labelSource: (logChannelId: string) => boolean;
	onConnectionLost: () => void;
	isSelected: () => boolean;
	createDecoder: () => Transform;
	flushTimeoutMs: number;
};

export class TranscriberSession {
	private connection: VoiceConnection | undefined;
	private readonly capturing = new Map<string, number>();
	private readonly activeCaptures = new Set<(publish: boolean) => void>();
	private readonly dependencies: SessionDependencies;
	private deafened = false;
	private destroyed = false;
	private stopping = false;
	private connecting = false;
	private problem: string | undefined;
	private logProblem: string | undefined;
	private epoch = 0;
	private sendQueue: Promise<void> = Promise.resolve();
	private lifecycle: Promise<void> = Promise.resolve();
	private readonly pendingSegments = new Set<Promise<void>>();
	private stopPromise: Promise<void> | undefined;
	private cancelDrain: (() => void) | undefined;
	private activeWork = 0;
	private typingTimer: NodeJS.Timeout | undefined;
	readonly assignment: Assignment;

	constructor(
		private readonly client: Client,
		assignment: Assignment,
		dependencies: Partial<SessionDependencies> = {},
	) {
		this.assignment = {...assignment};
		this.dependencies = {
			join: joinVoiceChannel,
			waitForReady: async connection => entersState(connection, VoiceConnectionStatus.Ready, 30_000),
			transcribe,
			labelSource: () => false,
			onConnectionLost: () => undefined,
			isSelected: () => true,
			createDecoder: () => new prism.opus.Decoder({rate: 48_000, channels: 2, frameSize: 960}),
			flushTimeoutMs: 3000,
			...dependencies,
		};
	}

	get state(): string {
		if (this.destroyed) return 'stopped';
		if (this.stopping) return 'stopping';
		if (this.error) return 'error';
		if (this.connecting || !this.connection || this.connection.state.status !== VoiceConnectionStatus.Ready) return 'connecting';
		return this.deafened ? 'paused' : 'listening';
	}

	get error(): string | undefined {
		return this.problem ?? this.logProblem;
	}

	get isDeafened(): boolean {
		return this.deafened;
	}

	async start(announce: boolean): Promise<void> {
		try {
			await this.reconcile();
		} catch (error) {
			if (this.destroyed || this.stopping) throw new SessionSelectionChangedError();
			throw error;
		}
		// A manager stop can interrupt an awaited lookup before join() is reached.
		// Reporting success here would make that stopped worker appear active and
		// could drop the manager's pending direct-move cleanup obligation.
		if (this.destroyed || this.stopping || !this.connection || !this.dependencies.isSelected()) {
			this.stopping = true;
			this.invalidateAudio();
			throw new SessionSelectionChangedError();
		}
		if (announce) await this.announceAssignment();
	}

	async announceAssignment(): Promise<void> {
		const suffix = this.deafened ? ' I am currently deafened, so transcription is paused.' : '';
		this.log(`📌 Assigned to <#${this.assignment.voiceChannelId}>. Logging this call here.${suffix}`);
		await this.sendQueue;
	}

	updateDestination(logChannelId: string): void {
		if (logChannelId === this.assignment.logChannelId) return;
		// Audio recorded for the previous destination must never be published here.
		this.invalidateAudio();
		this.assignment.logChannelId = logChannelId;
	}

	async stop(
		announce: boolean,
		{flushFinalAudio = false, disconnect = true}: {flushFinalAudio?: boolean; disconnect?: boolean} = {},
	): Promise<void> {
		if (this.stopPromise) {
			if (!flushFinalAudio) {
				this.destroyed = true;
				this.invalidateAudio();
				this.cancelDrain?.();
			}
			await this.stopPromise;
			return;
		}
		this.stopping = true;
		if (flushFinalAudio && !this.deafened) {
			// Seal each buffer while its original connection and destination are valid.
			for (const finish of [...this.activeCaptures]) finish(true);
		} else {
			this.destroyed = true;
			this.invalidateAudio();
		}
		this.destroyConnection(disconnect);
		this.stopPromise = (async () => {
			if (!this.destroyed && this.pendingSegments.size > 0) {
				let timer: NodeJS.Timeout | undefined;
				try {
					await Promise.race([
						Promise.allSettled([...this.pendingSegments]),
						new Promise<void>(resolve => {
							this.cancelDrain = resolve;
							timer = setTimeout(resolve, Math.max(0, Math.min(3000, this.dependencies.flushTimeoutMs)));
						}),
					]);
				} finally {
					clearTimeout(timer);
					this.cancelDrain = undefined;
				}
			}
			// Flush queued final transcripts before invalidating their epoch. Once the
			// deadline expires, unfinished STT is discarded and can never publish later.
			if (this.pendingSegments.size === 0 && !this.destroyed) await this.sendQueue;
			this.destroyed = true;
			this.invalidateAudio();
			if (announce) this.log('👋 Unassigned. Leaving the call.', undefined, true);
			// A send already handed to Discord finishes before this worker is reused.
			await this.sendQueue;
		})();
		await this.stopPromise;
	}

	onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
		if (this.destroyed) return;
		if (newState.id === this.client.user?.id) {
			this.onOwnVoiceStateUpdate(oldState, newState);
			return;
		}
		if (this.stopping) return;
		if (newState.member?.user.bot ?? oldState.member?.user.bot) return;
		const vcId = this.assignment.voiceChannelId;
		const joined = newState.channelId === vcId && oldState.channelId !== vcId;
		const left = oldState.channelId === vcId && newState.channelId !== vcId;
		if (joined) this.log(`➡️ <@${newState.id}> joined the call.`);
		if (left) this.log(`⬅️ <@${newState.id}> left the call.`);
	}

	private onOwnVoiceStateUpdate(oldState: VoiceState, state: VoiceState): void {
		if (this.stopping) {
			if (state.channelId === this.assignment.voiceChannelId && state.deaf) {
				this.deafened = true;
				this.invalidateAudio();
				this.cancelDrain?.();
			}
			return;
		}
		if (state.channelId && state.channelId !== this.assignment.voiceChannelId) {
			if (oldState.channelId !== this.assignment.voiceChannelId) return;
			// A manual move is not authorization to record a different room.
			this.connectionLost();
			return;
		}
		if (!state.channelId) {
			if (oldState.channelId === this.assignment.voiceChannelId) this.connectionLost();
			return;
		}
		const isDeaf = Boolean(state.deaf);
		if (isDeaf !== this.deafened) {
			this.deafened = isDeaf;
			this.invalidateAudio();
			this.log(isDeaf
				? '🔇 Deafened. Transcription paused. Undeafen me to resume.'
				: '🎙️ Undeafened. Transcription resumed.');
		}
	}

	private async fetchVoiceChannel(): Promise<VoiceBasedChannel> {
		const guild = await this.client.guilds.fetch(this.assignment.guildId);
		const channel = await guild.channels.fetch(this.assignment.voiceChannelId);
		if (!channel?.isVoiceBased()) throw new Error('The assigned voice channel is unavailable.');
		return channel;
	}

	private connectionLost(): void {
		if (this.destroyed || this.stopping || !this.connection) return;
		this.invalidateAudio();
		this.destroyConnection();
		this.problem = 'Voice connection lost. Waiting to reconnect.';
		this.dependencies.onConnectionLost();
	}

	private async reconcile(): Promise<void> {
		const pending = this.lifecycle.catch(() => undefined).then(async () => {
			if (this.destroyed || this.stopping) return;
			const channel = await this.fetchVoiceChannel();
			if (this.destroyed || this.stopping) return;
			const me = await channel.guild.members.fetchMe();
			if (this.destroyed || this.stopping) return;
			const nextDeafened = Boolean(me.voice.channelId === channel.id && me.voice.deaf);
			if (nextDeafened !== this.deafened) this.invalidateAudio();
			this.deafened = nextDeafened;
			if (!this.connection) await this.join(channel);
			this.problem = undefined;
		});
		this.lifecycle = pending;
		await pending;
	}

	private async join(channel: VoiceBasedChannel): Promise<void> {
		if (this.destroyed || this.stopping || this.connection) return;
		// Channel and member fetches above can outlive a follow/occupancy change.
		// Nothing asynchronous may intervene between this check and the join.
		if (!this.dependencies.isSelected()) throw new SessionSelectionChangedError();
		this.connecting = true;
		let connection: VoiceConnection;
		try {
			connection = this.dependencies.join({
				channelId: channel.id,
				guildId: channel.guild.id,
				adapterCreator: methods => {
					const adapter = channel.guild.voiceAdapterCreator(methods);
					let joined = false;
					return {
						...adapter,
						sendPayload: payload => {
							if (payload.d.channel_id !== null) {
								// @discordjs/voice otherwise retries joins internally. The
								// manager must choose whether this room is still eligible.
								if (joined || this.stopping || this.destroyed) return false;
								joined = true;
							}
							return adapter.sendPayload(payload);
						},
					};
				},
				// Keep this client's connection isolated from other clients in this process.
				group: this.client.user!.id,
				selfDeaf: false,
				selfMute: true,
			});
		} catch (error) {
			this.connecting = false;
			throw error;
		}
		this.connection = connection;
		connection.receiver.speaking.on('start', userId => {
			if (this.connection === connection) void this.captureUser(userId, connection);
		});
		connection.on('stateChange', (oldState, newState) => {
			console.log(`[voice:${this.assignment.guildId}:${this.assignment.voiceChannelId}] ${oldState.status} -> ${newState.status}`);
		});
		if (process.env.VOICE_DEBUG) {
			connection.on('debug', message => console.log(`[voice-debug:${this.assignment.guildId}] ${message}`));
		}
		connection.on('error', error => {
			console.error(`[voice:${this.assignment.guildId}:${this.assignment.voiceChannelId}]`, error);
		});
		connection.on(VoiceConnectionStatus.Disconnected, () => {
			if (this.connection === connection) this.connectionLost();
		});
		try {
			await this.dependencies.waitForReady(connection);
			if (this.destroyed || this.connection !== connection) throw new Error('Voice connection was interrupted.');
			if (!this.dependencies.isSelected()) {
				this.stopping = true;
				this.invalidateAudio();
				throw new SessionSelectionChangedError();
			}
			this.problem = undefined;
		} catch (error) {
			// The manager decides whether cancellation needs a direct move or leave.
			if (!(error instanceof SessionSelectionChangedError) && this.connection === connection) this.destroyConnection();
			throw error;
		} finally {
			if (this.connection === connection || !this.connection) this.connecting = false;
		}
	}

	private destroyConnection(disconnect = true): void {
		const connection = this.connection;
		this.connection = undefined;
		this.connecting = false;
		try {
			// A handoff closes local audio without leaving the old room first. The
			// replacement session's join then moves this account directly to its room.
			connection?.destroy(disconnect);
		} catch {
			// Already destroyed.
		}
	}

	private invalidateAudio(): void {
		this.epoch++;
		for (const finish of [...this.activeCaptures]) finish(false);
		this.capturing.clear();
		if (this.typingTimer) clearInterval(this.typingTimer);
		this.typingTimer = undefined;
	}

	private audioIsCurrent(epoch: number, connection?: VoiceConnection): boolean {
		return !this.destroyed && !this.deafened && epoch === this.epoch
			&& (!connection || this.connection === connection);
	}

	private async captureUser(userId: string, connection: VoiceConnection): Promise<void> {
		const epoch = this.epoch;
		if (this.stopping || !this.dependencies.isSelected() || !this.audioIsCurrent(epoch, connection) || this.capturing.has(userId)) return;
		// Reserve before fetching the user: duplicate speaking events can overlap the fetch.
		this.capturing.set(userId, epoch);
		try {
			const user = await this.client.users.fetch(userId).catch(() => null);
			if (!user || user.bot || !this.audioIsCurrent(epoch, connection)) return;
			while (!this.stopping && this.dependencies.isSelected() && this.audioIsCurrent(epoch, connection)) {
				await this.captureSegment(userId, epoch, connection);
				if (!connection.receiver.speaking.users.has(userId)) break;
			}
		} catch (error) {
			console.error(`[capture:${userId}]`, error);
		} finally {
			if (this.capturing.get(userId) === epoch) this.capturing.delete(userId);
		}
	}

	private beginWork(): void {
		this.activeWork++;
		if (!this.typingTimer) {
			void this.sendTyping();
			this.typingTimer = setInterval(() => void this.sendTyping(), TYPING_REFRESH_MS);
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
		const epoch = this.epoch;
		if (!this.audioIsCurrent(epoch)) return;
		const channel = await this.client.channels.fetch(this.assignment.logChannelId).catch(() => null);
		if (this.audioIsCurrent(epoch) && channel?.isTextBased() && 'sendTyping' in channel) {
			await channel.sendTyping().catch(() => undefined);
		}
	}

	private async captureSegment(userId: string, epoch: number, connection: VoiceConnection): Promise<void> {
		if (this.stopping || !this.dependencies.isSelected() || !this.audioIsCurrent(epoch, connection)) return;
		this.beginWork();
		try {
			await new Promise<void>((resolve, reject) => {
				const opusStream = connection.receiver.subscribe(userId, {
					end: {behavior: EndBehaviorType.AfterSilence, duration: config.silenceMs},
				});
				let decoder: Transform;
				try {
					decoder = this.dependencies.createDecoder();
				} catch (error) {
					opusStream.destroy();
					reject(error);
					return;
				}
				const chunks: Buffer[] = [];
				let bytes = 0;
				let done = false;
				const maxBytes = 48_000 * 4 * (config.maxSegmentMs / 1000);
				const finish = (publish = true) => {
					if (done) return;
					done = true;
					this.activeCaptures.delete(finish);
					decoder.destroy();
					opusStream.destroy();
					if (publish && this.audioIsCurrent(epoch, connection)) {
						// STT work outlives the capture stream; it retains the original epoch.
						void this.finishSegment(userId, Buffer.concat(chunks), epoch);
					} else {
						this.endWork();
					}
					resolve();
				};
				this.activeCaptures.add(finish);
				decoder.on('data', (chunk: Buffer) => {
					chunks.push(chunk);
					bytes += chunk.length;
					if (bytes >= maxBytes) finish();
				});
				decoder.once('end', () => finish());
				decoder.once('error', error => {
					console.error(`[decode:${userId}]`, error);
					finish(false);
				});
				opusStream.once('close', () => finish());
				opusStream.once('error', error => {
					console.error(`[opus:${userId}]`, error);
					finish(false);
				});
				opusStream.pipe(decoder);
			});
		} catch (error) {
			this.endWork();
			throw error;
		}
	}

	private async finishSegment(userId: string, pcm: Buffer, epoch: number): Promise<void> {
		const pending = this.transcribeSegment(userId, pcm, epoch);
		this.pendingSegments.add(pending);
		try {
			await pending;
		} finally {
			this.pendingSegments.delete(pending);
		}
	}

	private async transcribeSegment(userId: string, pcm: Buffer, epoch: number): Promise<void> {
		try {
			if (!this.audioIsCurrent(epoch)) return;
			const durationMs = Math.round(pcmDurationMs(pcm));
			if (durationMs < config.minSpeechMs) return;
			const {text, language, noSpeechProb, avgLogprob} = await this.dependencies.transcribe(pcmToWavMono(pcm));
			if (!this.audioIsCurrent(epoch)) return;
			if (!text || /^[\s.,!?\-–—'"«»()[\]]*$/.test(text)) return;
			if (config.sttLanguages.length > 0 && !config.sttLanguages.includes(language)) return;
			if (noSpeechProb > 0.6 && avgLogprob < -0.7) return;
			if (isLikelyHallucination(text, durationMs)) return;
			this.log(`<@${userId}> ${text}`.slice(0, 1990), epoch);
		} catch (error) {
			console.error(`[stt:${this.assignment.guildId}:${this.assignment.voiceChannelId}]`, error);
		} finally {
			this.endWork();
		}
	}

	private log(content: string, audioEpoch?: number, allowStopped = false): void {
		const destination = this.assignment.logChannelId;
		if (this.dependencies.labelSource(destination)) content = `<#${this.assignment.voiceChannelId}> ${content}`;
		content = content.slice(0, 2000);
		const canSend = () => (allowStopped || !this.destroyed)
			&& (audioEpoch === undefined || this.audioIsCurrent(audioEpoch));
		this.sendQueue = this.sendQueue.then(async () => {
			if (!canSend()) return;
			const channel = await this.client.channels.fetch(destination);
			if (!canSend()) return;
			if (!channel?.isTextBased() || !('send' in channel)) {
				throw new Error('The assigned destination no longer exists or cannot receive messages.');
			}
			await channel.send({content, allowedMentions: {parse: []}});
			this.logProblem = undefined;
		}).catch(error => {
			this.logProblem = 'Could not send messages to the assigned destination. Check channel permissions.';
			console.error(`[log:${this.assignment.guildId}:${destination}]`, error);
		});
	}
}
