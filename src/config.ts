import 'dotenv/config';

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}

	return value;
}

export const config = {
	token: required('DISCORD_TOKEN'),
	/** Base URL of an OpenAI-compatible transcription server (speaches, faster-whisper-server, etc.). */
	sttUrl: process.env.STT_URL ?? 'http://localhost:8000',
	sttModel: process.env.STT_MODEL ?? 'Systran/faster-whisper-small',
	/** Optional ISO 639-1 language hint (e.g. "en", "he"). Leave unset for auto-detect. */
	sttLanguage: process.env.STT_LANGUAGE || undefined,
	/** Segments shorter than this are discarded as noise. */
	minSpeechMs: Number(process.env.MIN_SPEECH_MS ?? 600),
	/** How long a pause ends a speech segment. */
	silenceMs: Number(process.env.SILENCE_MS ?? 1200),
	/** Continuous speech is flushed to the transcriber in chunks of at most this length. */
	maxSegmentMs: Number(process.env.MAX_SEGMENT_MS ?? 45_000),
	dataDir: process.env.DATA_DIR ?? './data',
};
