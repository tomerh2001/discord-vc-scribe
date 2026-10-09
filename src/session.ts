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
import type {Assignment} from './state.js';
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

type SessionDependencies = {
	join: typeof joinVoiceChannel;
	waitForReady: (connection: VoiceConnection) => Promise<unknown>;
	transcribe: typeof transcribe;
	labelSource: (logChannelId: string) => boolean;
};

export class TranscriberSession {
	private connection: VoiceConnection | undefined;
	private readonly capturing = new Map<string, number>();
	private readonly activeCaptures = new Set<(publish: boolean) => void>();
	private readonly dependencies: SessionDependencies;
	private deafened = false;
	private destroyed = false;
	private parked = false;
	private connecting = false;
	private problem: string | undefined;
	private logProblem: string | undefined;
	private epoch = 0;
	private sendQueue: Promise<void> = Promise.resolve();
	private lifecycle: Promise<void> = Promise.resolve();
	private activeWork = 0;
	private typingTimer: NodeJS.Timeout | undefined;
	private rejoinTimer: NodeJS.Timeout | undefined;
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
			...dependencies,
		};
	}

	get state(): string {
		if (this.destroyed) return 'stopped';
		if (this.error) return 'error';
		if (this.parked) return 'parked';
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
		await this.reconcile();
		if (announce) await this.announceAssignment();
	}

	async announceAssignment(): Promise<void> {
		const suffix = this.parked
			? ' The channel is empty, so I will join when someone arrives.'
			: (this.deafened ? ' I am currently deafened, so transcription is paused.' : '');
		this.log(`📌 Assigned to <#${this.assignment.voiceChannelId}>. Logging this call here.${suffix}`);
		await this.sendQueue;
	}

	updateDestination(logChannelId: string): void {
		if (logChannelId === this.assignment.logChannelId) return;
		// Audio recorded for the previous destination must never be published here.
		this.invalidateAudio();
		this.assignment.logChannelId = logChannelId;
	}

	async stop(announce: boolean): Promise<void> {
		if (this.destroyed) {
			await this.sendQueue;
			return;
		}
		this.destroyed = true;
		this.invalidateAudio();
		this.destroyConnection();
		this.clearRetry();
		if (announce) this.log('👋 Unassigned. Leaving the call.', undefined, true);
		// Any send already handed to Discord finishes before this worker is reused.
		await this.sendQueue;
	}

	onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
		if (this.destroyed) return;
		if (newState.id === this.client.user?.id) {
			this.onOwnVoiceStateUpdate(newState);
			return;
		}
		if (newState.member?.user.bot ?? oldState.member?.user.bot) return;
		const vcId = this.assignment.voiceChannelId;
		const joined = newState.channelId === vcId && oldState.channelId !== vcId;
		const left = oldState.channelId === vcId && newState.channelId !== vcId;
		if (joined) this.log(`➡️ <@${newState.id}> joined the call.`);
		if (left) this.log(`⬅️ <@${newState.id}> left the call.`);
		if (joined || left) this.scheduleReconcile();
	}

	private onOwnVoiceStateUpdate(state: VoiceState): void {
		if (state.channelId && state.channelId !== this.assignment.voiceChannelId) {
			// A manual move is not authorization to record a different room.
			this.invalidateAudio();
			this.destroyConnection();
			this.log(`📌 Assigned to <#${this.assignment.voiceChannelId}>. Returning to that channel.`);
			this.scheduleReconcile();
			return;
		}
		if (!state.channelId) {
			if (!this.parked) {
				this.invalidateAudio();
				this.destroyConnection();
				this.scheduleRetry();
			}
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

	private scheduleReconcile(): void {
		void this.reconcile().catch(error => {
			console.error(`[voice:${this.assignment.guildId}:${this.assignment.voiceChannelId}]`, error);
			if (!this.destroyed) {
				this.problem = 'Could not connect to the assigned voice channel. Retrying automatically.';
				this.scheduleRetry();
			}
		});
	}

	private async reconcile(): Promise<void> {
		const pending = this.lifecycle.catch(() => undefined).then(async () => {
			if (this.destroyed) return;
			const channel = await this.fetchVoiceChannel();
			if (this.destroyed) return;
			if (!channel.members.some(member => !member.user.bot)) {
				const wasConnected = Boolean(this.connection);
				this.parked = true;
				this.problem = undefined;
				// Finish the last words of the call even if the last speaker has left.
				for (const finish of [...this.activeCaptures]) finish(true);
				this.destroyConnection();
				this.clearRetry();
				if (wasConnected) this.log('💤 Everyone left. Waiting until someone joins.');
				return;
			}
			this.parked = false;
			const me = await channel.guild.members.fetchMe();
			if (this.destroyed) return;
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
		if (this.destroyed || this.connection) return;
		this.clearRetry();
		this.connecting = true;
		let connection: VoiceConnection;
		try {
			connection = this.dependencies.join({
				channelId: channel.id,
				guildId: channel.guild.id,
				adapterCreator: channel.guild.voiceAdapterCreator,
				// The library otherwise shares one connection across all clients in a guild.
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
			if (this.connection !== connection || this.destroyed) return;
			this.invalidateAudio();
			void Promise.race([
				entersState(connection, VoiceConnectionStatus.Signalling, 5000),
				entersState(connection, VoiceConnectionStatus.Connecting, 5000),
			]).catch(() => {
				if (this.connection !== connection || this.destroyed) return;
				this.destroyConnection();
				this.scheduleRetry();
			});
		});
		try {
			await this.dependencies.waitForReady(connection);
			if (this.destroyed || this.connection !== connection) throw new Error('Voice connection was interrupted.');
			this.problem = undefined;
		} catch (error) {
			if (this.connection === connection) this.destroyConnection();
			throw error;
		} finally {
			if (this.connection === connection || !this.connection) this.connecting = false;
		}
	}

	private destroyConnection(): void {
		const connection = this.connection;
		this.connection = undefined;
		this.connecting = false;
		try {
			connection?.destroy();
		} catch {
			// Already destroyed.
		}
	}

	private clearRetry(): void {
		if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
		this.rejoinTimer = undefined;
	}

	private scheduleRetry(): void {
		if (this.destroyed || this.parked || this.rejoinTimer) return;
		this.rejoinTimer = setTimeout(() => {
			this.rejoinTimer = undefined;
			this.scheduleReconcile();
		}, REJOIN_DELAY_MS);
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
		if (!this.audioIsCurrent(epoch, connection) || this.capturing.has(userId)) return;
		// Reserve before fetching the user: duplicate speaking events can overlap the fetch.
		this.capturing.set(userId, epoch);
		try {
			const user = await this.client.users.fetch(userId).catch(() => null);
			if (!user || user.bot || !this.audioIsCurrent(epoch, connection)) return;
			while (this.audioIsCurrent(epoch, connection)) {
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
		if (!this.audioIsCurrent(epoch, connection)) return;
		this.beginWork();
		try {
			await new Promise<void>((resolve, reject) => {
				const opusStream = connection.receiver.subscribe(userId, {
					end: {behavior: EndBehaviorType.AfterSilence, duration: config.silenceMs},
				});
				let decoder: prism.opus.Decoder;
				try {
					decoder = new prism.opus.Decoder({rate: 48_000, channels: 2, frameSize: 960});
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
