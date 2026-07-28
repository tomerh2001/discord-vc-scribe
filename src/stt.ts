import {config} from './config.js';

export type Transcription = {
	text: string;
	/** ISO 639-1 code as reported by the model, normalized (e.g. "english" -> "en"). */
	language: string;
	/** Lowest per-segment no-speech probability — high values mean the clip is likely noise. */
	noSpeechProb: number;
	/** Mean per-segment average log-probability — very negative means low confidence. */
	avgLogprob: number;
};

type VerboseSegment = {avg_logprob?: number; no_speech_prob?: number};
type VerboseResponse = {text?: string; language?: string; segments?: VerboseSegment[]};

const LANGUAGE_ALIASES: Record<string, string> = {english: 'en', hebrew: 'he', iw: 'he'};

/**
 * Send a WAV buffer to an OpenAI-compatible `/v1/audio/transcriptions`
 * endpoint (speaches, faster-whisper-server, or the real OpenAI API).
 */
export async function transcribe(wav: Buffer): Promise<Transcription> {
	const form = new FormData();
	form.append('file', new Blob([new Uint8Array(wav)], {type: 'audio/wav'}), 'audio.wav');
	form.append('model', config.sttModel);
	form.append('response_format', 'verbose_json');
	if (config.sttLanguage) {
		form.append('language', config.sttLanguage);
	}

	if (config.sttVad) {
		form.append('vad_filter', 'true');
	}

	const response = await fetch(new URL('/v1/audio/transcriptions', config.sttUrl), {
		method: 'POST',
		body: form,
		// A wedged STT server must fail fast — otherwise requests pile up and
		// the bot "types" forever without posting anything.
		signal: AbortSignal.timeout(90_000),
	});

	if (!response.ok) {
		throw new Error(`STT server returned ${response.status}: ${await response.text()}`);
	}

	const result = await response.json() as VerboseResponse;
	const segments = result.segments ?? [];
	const rawLanguage = (result.language ?? 'unknown').toLowerCase();

	return {
		text: (result.text ?? '').trim(),
		language: LANGUAGE_ALIASES[rawLanguage] ?? rawLanguage,
		noSpeechProb: segments.length > 0 ? Math.min(...segments.map(s => s.no_speech_prob ?? 0)) : 0,
		avgLogprob: segments.length > 0
			? segments.reduce((sum, s) => sum + (s.avg_logprob ?? 0), 0) / segments.length
			: 0,
	};
}
