import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {setImmediate} from 'node:timers/promises';
import test from 'node:test';
import {ChannelType, Collection, PermissionFlagsBits, PermissionsBitField, type Client, type VoiceState} from 'discord.js';
import {VoiceConnectionStatus, type VoiceConnection} from '@discordjs/voice';
import {SessionManager, AssignmentError} from '../src/session-manager.js';
import {TranscriberSession} from '../src/session.js';
import type {Assignment} from '../src/state.js';
import type {Transcription} from '../src/stt.js';
import {config} from '../src/config.js';

const route = (voiceChannelId = 'voice-a', logChannelId = 'text-a', guildId = 'guild-a'): Assignment => ({guildId, voiceChannelId, logChannelId});
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return {promise, resolve, reject};
};

function fakeClient(id: string, guildIds = ['guild-a']) {
	const sent: Array<{channelId: string; content: string}> = [];
	const channels = new Map<string, any>();
	const guilds = new Map<string, any>();
	for (const guildId of guildIds) {
		const me = {id, voice: {channelId: 'voice-a', deaf: false}};
		const guild: any = {
			id: guildId,
			members: {fetchMe: async () => me},
			voiceAdapterCreator: () => ({}),
			channels: {fetch: async (channelId: string) => channels.get(`${guildId}:${channelId}`) ?? null},
		};
		for (const channelId of ['voice-a', 'voice-b', 'text-a', 'text-b']) {
			const voice = channelId.startsWith('voice');
			channels.set(`${guildId}:${channelId}`, {
				id: channelId, guild, type: voice ? ChannelType.GuildVoice : ChannelType.GuildText,
				isVoiceBased: () => voice, isTextBased: () => true, isThread: () => false,
				members: new Collection(),
				permissionsFor: () => new PermissionsBitField([
					PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages,
				]),
				send: async ({content}: {content: string}) => { sent.push({channelId, content}); },
				sendTyping: async () => undefined,
			});
		}
		guilds.set(guildId, guild);
	}
	const client = {
		user: {id}, isReady: () => true,
		guilds: {cache: guilds, fetch: async (guildId: string) => guilds.get(guildId)},
		channels: {fetch: async (channelId: string) => [...channels.values()].find(channel => channel.id === channelId)},
		users: {fetch: async (userId: string) => ({id: userId, bot: false})},
	} as unknown as Client;
	return {client, channels, guilds, sent};
}

class FakeSession {
	state = 'parked';
	error = undefined;
	isDeafened = false;
	starts = 0;
	stops = 0;
	announcements = 0;
	events = 0;
	constructor(readonly client: Client, readonly assignment: Assignment, private readonly startHook?: () => Promise<void>) {}
	async start() { this.starts++; await this.startHook?.(); }
	async stop() { this.stops++; }
	async announceAssignment() { this.announcements++; }
	updateDestination(logChannelId: string) { this.assignment.logChannelId = logChannelId; }
	onVoiceStateUpdate() { this.events++; }
}

function managerFixture(clients: Client[], initial: Assignment[] = [], startHook?: () => Promise<void>) {
	let stored = structuredClone(initial);
	const created: FakeSession[] = [];
	const dependencies = {
		loadAssignments: () => structuredClone(stored),
		upsertAssignment: (assignment: Assignment) => {
			stored = stored.filter(a => a.guildId !== assignment.guildId || a.voiceChannelId !== assignment.voiceChannelId);
			stored.push({...assignment});
		},
		removeAssignment: (guildId: string, voiceChannelId: string) => {
			stored = stored.filter(a => a.guildId !== guildId || a.voiceChannelId !== voiceChannelId);
		},
		createSession: (client: Client, assignment: Assignment) => {
			const session = new FakeSession(client, assignment, startHook);
			created.push(session);
			return session;
		},
	};
	return {manager: new SessionManager(clients, dependencies), created, stored: () => stored, dependencies};
}

test('independent routes use different bots in a guild and route each event once', async () => {
	const a = fakeClient('bot-a').client;
	const b = fakeClient('bot-b').client;
	const {manager, created, stored} = managerFixture([a, b]);
	await manager.assign(route());
	await manager.assign(route('voice-b', 'text-b'));
	assert.equal(created[0].client, a);
	assert.equal(created[1].client, b);
	assert.deepEqual(manager.capacity('guild-a'), {total: 2, used: 2});
	const event = {guild: {id: 'guild-a'}} as VoiceState;
	manager.onVoiceStateUpdate(a, event, event);
	manager.onVoiceStateUpdate(b, event, event);
	assert.deepEqual(created.map(session => session.events), [1, 1]);
	assert.equal(stored().length, 2);
	assert.equal(await manager.unassign('guild-a', 'voice-a'), true);
	assert.deepEqual(stored(), [route('voice-b', 'text-b')]);
	assert.deepEqual(created.map(session => session.stops), [1, 0]);
});

test('one bot can serve separate guilds concurrently', async () => {
	const {client} = fakeClient('bot-a', ['guild-a', 'guild-b']);
	const {manager, created} = managerFixture([client]);
	await manager.assign(route());
	await manager.assign(route('voice-a', 'text-a', 'guild-b'));
	assert.equal(created.length, 2);
	assert.deepEqual(manager.capacity('guild-a'), {total: 1, used: 1});
	assert.deepEqual(manager.capacity('guild-b'), {total: 1, used: 1});
});

test('capacity exhaustion and concurrent assigns cannot replace an existing room', async () => {
	const gate = deferred<void>();
	const {manager, created, stored} = managerFixture([fakeClient('bot-a').client], [], () => gate.promise);
	const first = manager.assign(route());
	const second = manager.assign(route('voice-b', 'text-b'));
	const denied = assert.rejects(second, error => error instanceof AssignmentError && /DISCORD_WORKER_TOKENS/.test(error.message));
	await setImmediate();
	assert.equal(created.length, 1);
	gate.resolve();
	await first;
	await denied;
	assert.deepEqual(stored(), [route()]);
	assert.equal(created[0].stops, 0);
});

test('an assignment being started receives voice events before Ready', async () => {
	const gate = deferred<void>();
	const {client} = fakeClient('bot-a');
	const {manager, created} = managerFixture([client], [], () => gate.promise);
	const pending = manager.assign(route());
	await setImmediate();
	const event = {guild: {id: 'guild-a'}} as VoiceState;
	manager.onVoiceStateUpdate(client, event, event);
	assert.equal(created[0].events, 1);
	gate.resolve();
	await pending;
});

test('repeated mapping is idempotent and destination changes preserve the worker', async () => {
	const {manager, created, stored} = managerFixture([fakeClient('bot-a').client]);
	await manager.assign(route());
	await manager.assign(route());
	await manager.assign(route('voice-a', 'text-b'));
	assert.equal(created.length, 1);
	assert.equal(created[0].starts, 1);
	assert.equal(created[0].stops, 0);
	assert.equal(created[0].assignment.logChannelId, 'text-b');
	assert.deepEqual(stored(), [route('voice-a', 'text-b')]);
});

test('invalid channels and missing permissions are rejected before changing a live assignment', async () => {
	const fake = fakeClient('bot-a');
	const {manager, created, stored} = managerFixture([fake.client]);
	await manager.assign(route());
	const destination = fake.channels.get('guild-a:text-b');
	destination.permissionsFor = () => new PermissionsBitField(PermissionFlagsBits.ViewChannel);
	await assert.rejects(manager.assign(route('voice-a', 'text-b')), AssignmentError);
	await assert.rejects(manager.assign(route('text-a', 'text-a')), AssignmentError);
	assert.deepEqual(stored(), [route()]);
	assert.equal(created[0].assignment.logChannelId, 'text-a');
	assert.equal(created[0].stops, 0);
});

test('a permitted free worker is selected when another lacks channel access', async () => {
	const a = fakeClient('bot-a');
	const b = fakeClient('bot-b');
	a.channels.get('guild-a:voice-a').permissionsFor = () => new PermissionsBitField();
	const {manager, created} = managerFixture([a.client, b.client]);
	await manager.assign(route());
	assert.equal(created[0].client, b.client);
});

test('a missing-access channel fetch does not prevent another worker from serving it', async () => {
	const a = fakeClient('bot-a');
	const b = fakeClient('bot-b');
	a.guilds.get('guild-a').channels.fetch = async () => { throw new Error('Missing Access'); };
	const {manager, created} = managerFixture([a.client, b.client]);
	await manager.assign(route());
	assert.equal(created[0].client, b.client);
});

test('saved assignments in disallowed guilds cannot start even if leaving the guild failed', async () => {
	const allowed = config.allowedGuildIds;
	try {
		config.allowedGuildIds = ['allowed-guild'];
		const {manager, created, stored} = managerFixture([fakeClient('bot-a').client], [route()]);
		await manager.restore();
		assert.equal(created.length, 0);
		assert.match(manager.list('guild-a')[0].error!, /not allowed/);
		assert.deepEqual(stored(), [route()]);
	} finally {
		config.allowedGuildIds = allowed;
	}
});

test('restore failures remain stored and visible without removing restored routes', async () => {
	const {manager, stored} = managerFixture([fakeClient('bot-a').client], [route(), route('voice-b', 'text-b')]);
	await manager.restore();
	const statuses = manager.list('guild-a');
	assert.equal(statuses.length, 2);
	assert.equal(statuses[0].state, 'parked');
	assert.equal(statuses[1].state, 'error');
	assert.match(statuses[1].error!, /No free voice bot/);
	assert.equal(stored().length, 2);
});

test('start failure releases the worker without persisting a new assignment', async () => {
	let fail = true;
	const {manager, created, stored} = managerFixture([fakeClient('bot-a').client], [], async () => {
		if (fail) throw new Error('connection timed out');
	});
	await assert.rejects(manager.assign(route()), /timed out/);
	assert.equal(created[0].stops, 1);
	assert.deepEqual(manager.capacity('guild-a'), {total: 1, used: 0});
	assert.deepEqual(stored(), []);
	fail = false;
	await manager.assign(route('voice-b', 'text-b'));
	assert.equal(manager.list('guild-a').length, 1);
});

test('a persistence failure leaves the previous destination and live session unchanged', async () => {
	const fixture = managerFixture([fakeClient('bot-a').client]);
	let writes = 0;
	const manager = new SessionManager([fakeClient('bot-a').client], {
		...fixture.dependencies,
		upsertAssignment: assignment => {
			if (++writes > 1) throw new Error('disk full');
			fixture.dependencies.upsertAssignment(assignment);
		},
	});
	await manager.assign(route());
	await assert.rejects(manager.assign(route('voice-a', 'text-b')), /disk full/);
	assert.equal(fixture.created[0].assignment.logChannelId, 'text-a');
	assert.deepEqual(fixture.stored(), [route()]);
});

test('shutdown stops sessions and leaves assignments stored for restart', async () => {
	const {manager, created, stored} = managerFixture([fakeClient('bot-a').client]);
	await manager.assign(route());
	await manager.stop();
	assert.equal(created[0].stops, 1);
	assert.deepEqual(stored(), [route()]);
	await assert.rejects(manager.assign(route()), /restarting/);
});

test('duplicate bot identities cannot increase capacity', () => {
	assert.throws(() => new SessionManager([fakeClient('same-bot').client, fakeClient('same-bot').client]), /different Discord bot/);
});

function fakeConnection() {
	const connection: any = new EventEmitter();
	const speaking: any = new EventEmitter();
	speaking.users = new Map();
	connection.receiver = {speaking, subscribe: () => { throw new Error('Unexpected audio subscription'); }};
	connection.state = {status: VoiceConnectionStatus.Connecting};
	connection.destroyed = false;
	connection.destroy = () => { connection.destroyed = true; connection.state.status = VoiceConnectionStatus.Destroyed; };
	return connection as VoiceConnection & {destroyed: boolean};
}

type SessionInternals = {
	finishSegment: (userId: string, pcm: Buffer, epoch: number) => Promise<void>;
	captureUser: (userId: string, connection: VoiceConnection) => Promise<void>;
	log: (content: string, epoch?: number) => void;
	sendQueue: Promise<void>;
};
const internals = (session: TranscriberSession) => session as unknown as SessionInternals;
const spoken: Transcription = {text: 'A useful sentence with enough words.', language: 'en', noSpeechProb: 0, avgLogprob: 0};
const pcm = Buffer.alloc(48_000 * 4 * 2);

test('occupied sessions use a per-bot connection group and await voice readiness', async () => {
	const fake = fakeClient('bot-a');
	fake.channels.get('guild-a:voice-a').members.set('human', {user: {bot: false}});
	const ready = deferred<void>();
	const connection = fakeConnection();
	let group: string | undefined;
	const session = new TranscriberSession(fake.client, route(), {
		join: options => { group = options.group; return connection; },
		waitForReady: () => ready.promise,
	});
	let complete = false;
	const start = session.start(false).then(() => { complete = true; });
	await setImmediate();
	assert.equal(complete, false);
	assert.equal(group, 'bot-a');
	connection.state = {status: VoiceConnectionStatus.Ready} as any;
	ready.resolve();
	await start;
	assert.equal(session.state, 'listening');
	await session.stop(false);
	assert.equal(connection.destroyed, true);
});

test('empty assigned channels park without opening a voice connection', async () => {
	const fake = fakeClient('bot-a');
	const session = new TranscriberSession(fake.client, route(), {join: () => { throw new Error('must remain parked'); }});
	await session.start(false);
	assert.equal(session.state, 'parked');
	await session.stop(false);
});

test('stop during channel lookup cannot create a connection later', async () => {
	const fake = fakeClient('bot-a');
	const channel = fake.channels.get('guild-a:voice-a');
	channel.members.set('human', {user: {bot: false}});
	const pendingChannel = deferred<any>();
	fake.guilds.get('guild-a').channels.fetch = () => pendingChannel.promise;
	let joins = 0;
	const session = new TranscriberSession(fake.client, route(), {join: () => { joins++; return fakeConnection(); }});
	const start = session.start(false);
	await setImmediate();
	await session.stop(false);
	pendingChannel.resolve(channel);
	await start;
	assert.equal(joins, 0);
});

for (const action of ['stop', 'deafen-undeafen', 'destination-change'] as const) {
	test(`late transcription is discarded after ${action}`, async () => {
		const fake = fakeClient('bot-a');
		const result = deferred<Transcription>();
		const session = new TranscriberSession(fake.client, route(), {transcribe: () => result.promise});
		const pending = internals(session).finishSegment('human', pcm, 0);
		await setImmediate();
		if (action === 'stop') {
			await session.stop(false);
		} else if (action === 'destination-change') {
			session.updateDestination('text-b');
		} else {
			for (const deaf of [true, false]) {
				const state = {id: 'bot-a', channelId: 'voice-a', deaf} as VoiceState;
				session.onVoiceStateUpdate(state, state);
			}
		}
		result.resolve(spoken);
		await pending;
		await internals(session).sendQueue;
		assert.equal(fake.sent.some(message => message.content.includes(spoken.text)), false);
		await session.stop(false);
	});
}

test('queued transcript rechecks cancellation after destination lookup', async () => {
	const fake = fakeClient('bot-a');
	const destination = fake.channels.get('guild-a:text-a');
	const lookup = deferred<any>();
	fake.client.channels.fetch = (() => lookup.promise) as any;
	const session = new TranscriberSession(fake.client, route());
	internals(session).log('Old transcript', 0);
	await setImmediate();
	session.updateDestination('text-b');
	lookup.resolve(destination);
	await internals(session).sendQueue;
	assert.deepEqual(fake.sent, []);
	await session.stop(false);
});

test('manual bot moves keep the assigned room pinned', async () => {
	const fake = fakeClient('bot-a');
	const session = new TranscriberSession(fake.client, route());
	const moved = {id: 'bot-a', channelId: 'voice-b', deaf: false} as VoiceState;
	session.onVoiceStateUpdate(moved, moved);
	await setImmediate();
	assert.equal(session.assignment.voiceChannelId, 'voice-a');
	assert.equal(session.state, 'parked');
	await session.stop(false);
});

test('source labels distinguish shared destinations while solo transcripts retain their format', async () => {
	for (const shared of [false, true]) {
		const fake = fakeClient('bot-a');
		const session = new TranscriberSession(fake.client, route(), {labelSource: () => shared, transcribe: async () => spoken});
		await internals(session).finishSegment('human', pcm, 0);
		await internals(session).sendQueue;
		assert.equal(fake.sent[0].content, `${shared ? '<#voice-a> ' : ''}<@human> ${spoken.text}`);
		await session.stop(false);
	}
});

test('parking and its own disconnect event preserve the final in-flight transcript', async () => {
	const fake = fakeClient('bot-a');
	const result = deferred<Transcription>();
	const session = new TranscriberSession(fake.client, route(), {transcribe: () => result.promise});
	const pending = internals(session).finishSegment('human', pcm, 0);
	await session.start(false);
	assert.equal(session.state, 'parked');
	const disconnected = {id: 'bot-a', channelId: null, deaf: false} as VoiceState;
	session.onVoiceStateUpdate(disconnected, disconnected);
	result.resolve(spoken);
	await pending;
	await internals(session).sendQueue;
	assert.equal(fake.sent[0].content, `<@human> ${spoken.text}`);
	await session.stop(false);
});

test('source labels cannot push long transcript messages beyond the Discord limit', async () => {
	const fake = fakeClient('bot-a');
	const session = new TranscriberSession(fake.client, route('12345678901234567890'), {
		labelSource: () => true,
		transcribe: async () => ({...spoken, text: 'x'.repeat(2500)}),
	});
	await internals(session).finishSegment('human', pcm, 0);
	await internals(session).sendQueue;
	assert.equal(fake.sent[0].content.length, 2000);
	assert.ok(fake.sent[0].content.startsWith('<#12345678901234567890> <@human>'));
	await session.stop(false);
});
