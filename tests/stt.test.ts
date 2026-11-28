import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test, {type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {config} from '../src/config.js';
import {transcribe} from '../src/stt.js';

function configure(t: TestContext, overrides: Partial<typeof config>) {
	const previous = {...config};
	Object.assign(config, overrides);
	t.after(() => { Object.assign(config, previous); });
}

test('translation is the default task and invalid tasks fail at startup', () => {
	for (const task of [undefined, 'translate', 'transcribe', 'unsupported']) {
		const env = {...process.env, DISCORD_TOKEN: 'test-token'};
		if (task === undefined) delete env.STT_TASK;
		else env.STT_TASK = task;
		const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
			"const {config} = await import('./src/config.ts'); process.stdout.write(config.sttTask);"], {
			cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8',
		});
		if (task === 'unsupported') {
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /STT_TASK must be "translate" or "transcribe"/);
		} else {
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout, task ?? 'translate');
		}
	}
});

test('translation uploads audio with auto-detection, verbose confidence and VAD', async t => {
	configure(t, {sttUrl: 'http://stt.example:8000', sttTask: 'translate', sttLanguage: 'he', sttVad: true});
	const wav = Buffer.from([82, 73, 70, 70]);
	t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
		assert.equal(input.href, 'http://stt.example:8000/v1/audio/translations');
		assert.equal(init.method, 'POST');
		assert.ok(init.signal instanceof AbortSignal);
		const form = init.body as FormData;
		assert.equal(form.get('model'), config.sttModel);
		assert.equal(form.get('response_format'), 'verbose_json');
		assert.equal(form.get('vad_filter'), 'true');
		assert.equal(form.has('language'), false);
		const file = form.get('file') as File;
		assert.equal(file.name, 'audio.wav');
		assert.equal(file.type, 'audio/wav');
		assert.deepEqual(Buffer.from(await file.arrayBuffer()), wav);
		return Response.json({text: '  This is English output.  ', language: 'Hebrew', segments: [
			{no_speech_prob: 0.4, avg_logprob: -0.2},
			{no_speech_prob: 0.1, avg_logprob: -0.6},
		]});
	});
	assert.deepEqual(await transcribe(wav), {
		text: 'This is English output.', language: 'he', noSpeechProb: 0.1, avgLogprob: -0.4,
	});
});

test('translation keeps English, other source languages and responses without language metadata', async t => {
	configure(t, {sttTask: 'translate', sttLanguage: 'en', sttLanguages: ['en', 'he'], sttVad: false});
	for (const [language, normalized] of [['English', 'en'], ['ru', 'ru'], [undefined, 'unknown']]) {
		t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
			assert.equal(input.pathname, '/v1/audio/translations');
			const form = init.body as FormData;
			assert.equal(form.has('language'), false);
			assert.equal(form.has('vad_filter'), false);
			return Response.json({text: 'The output is English.', language});
		});
		assert.deepEqual(await transcribe(Buffer.alloc(4)), {
			text: 'The output is English.', language: normalized, noSpeechProb: 0, avgLogprob: 0,
		});
		t.mock.restoreAll();
	}
});

test('source-language transcription uses its own endpoint and optional language hint', async t => {
	configure(t, {sttTask: 'transcribe', sttVad: false});
	for (const language of ['he', undefined]) {
		config.sttLanguage = language;
		t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
			assert.equal(input.pathname, '/v1/audio/transcriptions');
			const form = init.body as FormData;
			assert.equal(form.get('language'), language ?? null);
			assert.equal(form.get('response_format'), 'verbose_json');
			return Response.json({text: 'שלום', language: 'iw'});
		});
		const result = await transcribe(Buffer.alloc(4));
		assert.equal(result.text, 'שלום');
		assert.equal(result.language, 'he');
		t.mock.restoreAll();
	}
});

test('a failed translation reports the error without falling back to untranslated output', async t => {
	configure(t, {sttTask: 'translate'});
	const request = t.mock.method(globalThis, 'fetch', async (input: URL) => {
		assert.equal(input.pathname, '/v1/audio/translations');
		return new Response('Translation unavailable', {status: 503});
	});
	await assert.rejects(transcribe(Buffer.alloc(4)), /STT server returned 503: Translation unavailable/);
	assert.equal(request.mock.callCount(), 1);
});
