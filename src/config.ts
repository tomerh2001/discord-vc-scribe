import 'dotenv/config';

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}

	return value;
}

const token = required('DISCORD_TOKEN');

function workerTokens(): string[] {
	let value: unknown;
	try {
		value = JSON.parse(process.env.DISCORD_WORKER_TOKENS ?? '[]');
	} catch {
		throw new Error('DISCORD_WORKER_TOKENS must be a JSON array of bot tokens.');
	}

	if (!Array.isArray(value)
		|| value.some(item => typeof item !== 'string' || !item.trim() || item !== item.trim())) {
		throw new Error('DISCORD_WORKER_TOKENS must be a JSON array of non-empty bot tokens without surrounding whitespace.');
	}

	const tokens = value as string[];
	if (new Set([token, ...tokens]).size !== tokens.length + 1) {
		throw new Error('DISCORD_WORKER_TOKENS must contain distinct bot tokens and must not include DISCORD_TOKEN.');
	}

	return tokens;
}

export const config = {
	token,
	/** Additional bot identities, each providing one more concurrent voice channel per guild. */
	workerTokens: workerTokens(),
	/** Base URL of an OpenAI-compatible transcription server (speaches, faster-whisper-server, etc.). */
	sttUrl: process.env.STT_URL ?? 'http://localhost:8000',
	sttModel: process.env.STT_MODEL ?? 'Systran/faster-whisper-small',
	/** Optional ISO 639-1 language hint (e.g. "en", "he"). Leave unset for auto-detect. */
	sttLanguage: process.env.STT_LANGUAGE || undefined,
	/** Comma-separated ISO 639-1 codes; segments detected as any other language are dropped. Empty = keep all. */
	sttLanguages: (process.env.STT_LANGUAGES ?? '')
		.split(',')
		.map(code => code.trim().toLowerCase())
		.filter(Boolean),
	/** Ask the STT server to run voice-activity detection before transcribing. */
	sttVad: ['1', 'true', 'yes'].includes((process.env.STT_VAD ?? '').toLowerCase()),
	/** Comma-separated guild IDs allowed to use the bot; it leaves any other guild. Empty = allow all. */
	allowedGuildIds: (process.env.ALLOWED_GUILD_IDS ?? '')
		.split(',')
		.map(id => id.trim())
		.filter(Boolean),
	/** Segments shorter than this are discarded as noise. */
	minSpeechMs: Number(process.env.MIN_SPEECH_MS ?? 600),
	/** How long a pause ends a speech segment. */
	silenceMs: Number(process.env.SILENCE_MS ?? 1200),
	/** Continuous speech is flushed to the transcriber in chunks of at most this length. */
	maxSegmentMs: Number(process.env.MAX_SEGMENT_MS ?? 45_000),
	dataDir: process.env.DATA_DIR ?? './data',
};
