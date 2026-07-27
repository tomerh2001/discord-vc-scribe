import {config} from './config.js';

/**
 * Send a WAV buffer to an OpenAI-compatible `/v1/audio/transcriptions`
 * endpoint (speaches, faster-whisper-server, or the real OpenAI API).
 */
export async function transcribe(wav: Buffer): Promise<string> {
	const form = new FormData();
	form.append('file', new Blob([new Uint8Array(wav)], {type: 'audio/wav'}), 'audio.wav');
	form.append('model', config.sttModel);
	form.append('response_format', 'json');
	if (config.sttLanguage) {
		form.append('language', config.sttLanguage);
	}

	const response = await fetch(new URL('/v1/audio/transcriptions', config.sttUrl), {
		method: 'POST',
		body: form,
	});

	if (!response.ok) {
		throw new Error(`STT server returned ${response.status}: ${await response.text()}`);
	}

	const result = await response.json() as {text?: string};
	return (result.text ?? '').trim();
}
