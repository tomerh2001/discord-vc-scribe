import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {setImmediate} from 'node:timers/promises';
import test from 'node:test';
import {VoiceConnectionStatus, type VoiceConnection} from '@discordjs/voice';
import type {Client, VoiceState} from 'discord.js';
import {SessionSelectionChangedError, TranscriberSession} from '../src/session.js';
import type {Transcription} from '../src/stt.js';

const route = {guildId: 'guild', voiceChannelId: 'voice-a', logChannelId: 'text-a'};
const spoken: Transcription = {text: 'A useful sentence with enough words.', language: 'en', noSpeechProb: 0, avgLogprob: 0};
const pcm = Buffer.alloc(48_000 * 4 * 2);
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return {promise, resolve};
};

function fixture(dependencies: ConstructorParameters<typeof TranscriberSession>[2] = {}) {
	const sent: Array<{channelId: string; content: string}> = [];
	const destinations = new Map(['text-a', 'text-b'].map(id => [id, {
		id, isTextBased: () => true,
		send: async ({content}: {content: string}) => { sent.push({channelId: id, content}); },
		sendTyping: async () => undefined,
	}]));
	const payloads: unknown[] = [];
	const guild: any = {
		id: 'guild', members: {fetchMe: async () => ({voice: {channelId: null, deaf: false}})},
		voiceAdapterCreator: () => ({sendPayload: (payload: unknown) => { payloads.push(payload); return true; }, destroy: () => undefined}),
	};
	const channel = {id: 'voice-a', guild, isVoiceBased: () => true};
	guild.channels = {fetch: async () => channel};
	const client = {
		user: {id: 'bot'}, guilds: {fetch: async () => guild},
		channels: {fetch: async (id: string) => destinations.get(id)},
		users: {fetch: async (id: string) => ({id, bot: false})},
	} as unknown as Client;
	const speaking = Object.assign(new EventEmitter(), {users: new Map<string, number>()});
	const streams: PassThrough[] = [];
	const disconnects: boolean[] = [];
	const connection = Object.assign(new EventEmitter(), {
		state: {status: VoiceConnectionStatus.Connecting}, destroyed: false,
		receiver: {speaking, subscribe: () => { const stream = new PassThrough(); streams.push(stream); return stream; }},
		destroy(disconnect = true) { disconnects.push(disconnect); this.destroyed = true; this.state = {status: VoiceConnectionStatus.Destroyed}; },
	}) as unknown as VoiceConnection & {destroyed: boolean};
	let joins = 0;
	const session = new TranscriberSession(client, route, {
		join: () => { joins++; return connection; },
		waitForReady: async () => { connection.state = {status: VoiceConnectionStatus.Ready} as any; },
		createDecoder: () => new PassThrough(),
		transcribe: async () => spoken,
		...dependencies,
	});
	return {session, client, guild, channel, connection, speaking, streams, destinations, sent, payloads, disconnects, joins: () => joins};
}

type SessionInternals = {
	finishSegment: (userId: string, pcm: Buffer, epoch: number) => Promise<void>;
	captureUser: (userId: string, connection: VoiceConnection) => Promise<void>;
	log: (content: string, epoch?: number) => void;
	sendQueue: Promise<void>;
};
const internals = (session: TranscriberSession) => session as unknown as SessionInternals;
const voiceState = (channelId: string | null, deaf = false) => ({id: 'bot', channelId, deaf}) as VoiceState;

async function beginCapture(f: ReturnType<typeof fixture>) {
	await f.session.start(false);
	f.speaking.users.set('human', Date.now());
	f.speaking.emit('start', 'human');
	await setImmediate();
	assert.equal(f.streams.length, 1);
	f.streams[0].write(pcm);
}

test('start connects the manager-selected room and waits for Ready without selecting by occupancy', async t => {
	const ready = deferred<void>();
	const f = fixture({waitForReady: () => ready.promise});
	t.after(() => f.session.stop(false));
	let complete = false;
	const start = f.session.start(false).then(() => { complete = true; });
	await setImmediate();
	assert.equal(f.joins(), 1);
	assert.equal(complete, false);
	f.connection.state = {status: VoiceConnectionStatus.Ready} as any;
	ready.resolve();
	await start;
	assert.equal(f.session.state, 'listening');
});

test('stop during channel lookup prevents a late connection', async () => {
	const f = fixture();
	const lookup = deferred<typeof f.channel>();
	f.guild.channels.fetch = () => lookup.promise;
	const start = f.session.start(false);
	const cancelled = assert.rejects(start, SessionSelectionChangedError);
	await setImmediate();
	await f.session.stop(false);
	lookup.resolve(f.channel);
	await cancelled;
	assert.equal(f.joins(), 0);
});

test('a stopped startup cannot become active when selection returns to the same room', async () => {
	let selected = true;
	const f = fixture({isSelected: () => selected});
	const lookup = deferred<any>();
	f.guild.members.fetchMe = () => lookup.promise;
	const start = f.session.start(true);
	const cancelled = assert.rejects(start, SessionSelectionChangedError);
	await setImmediate();
	selected = false;
	await f.session.stop(false, {disconnect: false});
	selected = true;
	lookup.resolve({voice: {channelId: null, deaf: false}});
	await cancelled;
	assert.equal(f.joins(), 0);
	assert.equal(f.session.state, 'stopped');
	assert.deepEqual(f.sent, []);
});

for (const lookupKind of ['channel', 'member'] as const) {
	test(`a selection change during ${lookupKind} lookup cancels the obsolete join`, async () => {
		let selected = true;
		const f = fixture({isSelected: () => selected});
		const lookup = deferred<any>();
		if (lookupKind === 'channel') f.guild.channels.fetch = () => lookup.promise;
		else f.guild.members.fetchMe = () => lookup.promise;
		const start = f.session.start(true);
		const cancelled = assert.rejects(start, SessionSelectionChangedError);
		await setImmediate();
		selected = false;
		lookup.resolve(lookupKind === 'channel' ? f.channel : {voice: {channelId: null, deaf: false}});
		await cancelled;
		assert.equal(f.joins(), 0);
		assert.deepEqual(f.sent, []);
		await f.session.stop(false);
	});
}

test('selection changes during Ready suppress capture and leave handoff control with the manager', async () => {
	let selected = true;
	const ready = deferred<void>();
	const f = fixture({isSelected: () => selected, waitForReady: () => ready.promise});
	const start = f.session.start(true);
	const cancelled = assert.rejects(start, SessionSelectionChangedError);
	await setImmediate();
	selected = false;
	f.speaking.emit('start', 'human');
	await setImmediate();
	assert.equal(f.streams.length, 0);
	f.connection.state = {status: VoiceConnectionStatus.Ready} as any;
	ready.resolve();
	await cancelled;
	assert.equal(f.connection.destroyed, false);
	assert.deepEqual(f.sent, []);
	await f.session.stop(false, {disconnect: false});
	assert.deepEqual(f.disconnects, [false]);
});

test('duplicate speaking events share one user lookup and stop prevents a late subscription', async () => {
	const f = fixture();
	const lookup = deferred<any>();
	let lookups = 0;
	f.client.users.fetch = (() => { lookups++; return lookup.promise; }) as any;
	await f.session.start(false);
	const first = internals(f.session).captureUser('human', f.connection);
	const second = internals(f.session).captureUser('human', f.connection);
	assert.equal(lookups, 1);
	await f.session.stop(false);
	lookup.resolve({id: 'human', bot: false});
	await Promise.all([first, second]);
	assert.equal(f.streams.length, 0);
});

test('a stale departure from the previous room cannot stop the selected connection', async t => {
	let lost = 0;
	const f = fixture({onConnectionLost: () => { lost++; }});
	t.after(() => f.session.stop(false));
	await f.session.start(false);
	f.session.onVoiceStateUpdate(voiceState('voice-b'), voiceState(null));
	assert.equal(f.connection.destroyed, false);
	assert.equal(lost, 0);
	f.session.onVoiceStateUpdate(voiceState('voice-a'), voiceState('voice-b'));
	assert.equal(f.connection.destroyed, true);
	assert.equal(lost, 1);
	f.connection.emit(VoiceConnectionStatus.Disconnected);
	assert.equal(lost, 1);
	assert.equal(f.joins(), 1);
});

test('the adapter blocks automatic library rejoins while allowing the initial join and leave', async t => {
	let adapter: any;
	let group: string | undefined;
	const f = fixture({join: options => {
		group = options.group;
		adapter = options.adapterCreator({onVoiceServerUpdate: () => undefined, onVoiceStateUpdate: () => undefined, destroy: () => undefined});
		return f.connection;
	}});
	t.after(() => f.session.stop(false));
	await f.session.start(false);
	const join = {op: 4, d: {guild_id: 'guild', channel_id: 'voice-a', self_deaf: false, self_mute: true}};
	assert.equal(group, 'bot');
	assert.equal(adapter.sendPayload(join), true);
	assert.equal(adapter.sendPayload(join), false);
	assert.equal(adapter.sendPayload({...join, d: {...join.d, channel_id: null}}), true);
	assert.equal(f.payloads.length, 2);
});

test('natural last-person departure flushes the captured ending to its original destination', async () => {
	const result = deferred<Transcription>();
	let transcriptions = 0;
	let selected = true;
	const f = fixture({isSelected: () => selected, transcribe: () => { transcriptions++; return result.promise; }});
	await beginCapture(f);
	// The old room stops being selected as its final human leaves, but its
	// already captured final words still belong to the completed call.
	selected = false;
	const stop = f.session.stop(false, {flushFinalAudio: true});
	assert.equal(f.connection.destroyed, true);
	assert.equal(transcriptions, 1);
	// Discord's acknowledgement of our intentional leave must not discard the ending.
	f.session.onVoiceStateUpdate(voiceState('voice-a'), voiceState(null));
	result.resolve(spoken);
	await stop;
	assert.deepEqual(f.sent, [{channelId: 'text-a', content: `<@human> ${spoken.text}`}]);
	assert.equal(f.session.state, 'stopped');
});

test('forced handoff discards unfinished capture without submitting it for transcription', async () => {
	let transcriptions = 0;
	const f = fixture({transcribe: async () => { transcriptions++; return spoken; }});
	await beginCapture(f);
	await f.session.stop(false);
	assert.equal(f.streams[0].destroyed, true);
	assert.equal(transcriptions, 0);
	assert.deepEqual(f.sent, []);
});

test('direct handoff closes local audio without sending a Discord leave and preserves final flush', async () => {
	const result = deferred<Transcription>();
	const f = fixture({transcribe: () => result.promise});
	await beginCapture(f);
	const stop = f.session.stop(false, {flushFinalAudio: true, disconnect: false});
	assert.deepEqual(f.disconnects, [false]);
	assert.equal(f.connection.destroyed, true);
	result.resolve(spoken);
	await stop;
	assert.deepEqual(f.sent, [{channelId: 'text-a', content: `<@human> ${spoken.text}`}]);
});

test('normal stop still leaves Discord voice', async () => {
	const f = fixture();
	await f.session.start(false);
	await f.session.stop(false);
	assert.deepEqual(f.disconnects, [true]);
});

test('slow final transcription has a bounded drain and cannot publish after stop', async () => {
	const result = deferred<Transcription>();
	const f = fixture({transcribe: () => result.promise, flushTimeoutMs: 15});
	await beginCapture(f);
	await f.session.stop(false, {flushFinalAudio: true});
	assert.equal(f.session.state, 'stopped');
	result.resolve(spoken);
	await setImmediate();
	assert.deepEqual(f.sent, []);
});

test('a forced stop interrupts an already draining natural ending', async () => {
	const result = deferred<Transcription>();
	const f = fixture({transcribe: () => result.promise});
	await beginCapture(f);
	const natural = f.session.stop(false, {flushFinalAudio: true});
	await f.session.stop(false);
	await natural;
	result.resolve(spoken);
	await setImmediate();
	assert.deepEqual(f.sent, []);
});

for (const action of ['stop', 'deafen-undeafen', 'destination-change'] as const) {
	test(`late transcription is discarded after ${action}`, async () => {
		const result = deferred<Transcription>();
		const f = fixture({transcribe: () => result.promise});
		const pending = internals(f.session).finishSegment('human', pcm, 0);
		await setImmediate();
		if (action === 'stop') await f.session.stop(false);
		else if (action === 'destination-change') f.session.updateDestination('text-b');
		else for (const deaf of [true, false]) f.session.onVoiceStateUpdate(voiceState('voice-a'), voiceState('voice-a', deaf));
		result.resolve(spoken);
		await pending;
		await internals(f.session).sendQueue;
		assert.equal(f.sent.some(message => message.content.includes(spoken.text)), false);
		await f.session.stop(false);
	});
}

test('destination changes cancel queued transcripts even after destination lookup started', async () => {
	const f = fixture();
	const lookup = deferred<any>();
	f.client.channels.fetch = (() => lookup.promise) as any;
	internals(f.session).log('Old transcript', 0);
	await setImmediate();
	f.session.updateDestination('text-b');
	lookup.resolve(f.destinations.get('text-a'));
	await internals(f.session).sendQueue;
	assert.deepEqual(f.sent, []);
	await f.session.stop(false);
});

test('stop waits for an already submitted Discord send before allowing worker reuse', async () => {
	const f = fixture();
	const send = deferred<void>();
	f.destinations.get('text-a')!.send = () => send.promise;
	internals(f.session).log('Already submitted', 0);
	await setImmediate();
	let stopped = false;
	const stop = f.session.stop(false).then(() => { stopped = true; });
	await setImmediate();
	assert.equal(stopped, false);
	send.resolve();
	await stop;
});

test('deafening during final drain invalidates the pending ending', async () => {
	const result = deferred<Transcription>();
	const f = fixture({transcribe: () => result.promise});
	await beginCapture(f);
	const stop = f.session.stop(false, {flushFinalAudio: true});
	f.session.onVoiceStateUpdate(voiceState('voice-a'), voiceState('voice-a', true));
	await stop;
	result.resolve(spoken);
	await setImmediate();
	assert.deepEqual(f.sent, []);
});

test('shared destinations label the source without exceeding Discord message length', async () => {
	for (const shared of [false, true]) {
		const f = fixture({labelSource: () => shared});
		await internals(f.session).finishSegment('human', pcm, 0);
		await internals(f.session).sendQueue;
		assert.equal(f.sent[0].content, `${shared ? '<#voice-a> ' : ''}<@human> ${spoken.text}`);
		await f.session.stop(false);
	}
	const f = fixture({labelSource: () => true, transcribe: async () => ({...spoken, text: 'x'.repeat(2500)})});
	await internals(f.session).finishSegment('human', pcm, 0);
	await internals(f.session).sendQueue;
	assert.equal(f.sent[0].content.length, 2000);
	await f.session.stop(false);
});

test('successful sends clear destination errors and missing destinations remain visible', async () => {
	const f = fixture();
	const destination = f.destinations.get('text-a')!;
	const send = destination.send;
	destination.send = async () => { throw new Error('Missing Permissions'); };
	await f.session.start(true);
	assert.match(f.session.error!, /Could not send/);
	destination.send = send;
	await f.session.announceAssignment();
	assert.equal(f.session.state, 'listening');
	assert.equal(f.session.error, undefined);
	f.client.channels.fetch = (async () => null) as any;
	await f.session.announceAssignment();
	assert.match(f.session.error!, /Could not send/);
	await f.session.stop(false);
});
