import assert from 'node:assert/strict';
import {setImmediate, setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {ChannelType, Collection, PermissionFlagsBits, PermissionsBitField, type Client, type VoiceState} from 'discord.js';
import {SessionManager, AssignmentError} from '../src/session-manager.js';
import {SessionSelectionChangedError} from '../src/session.js';
import {config} from '../src/config.js';
import type {Assignment, GuildSettings} from '../src/state.js';

const route = (voiceChannelId = 'a', logChannelId = 'text-a', guildId = 'guild'): Assignment => ({guildId, voiceChannelId, logChannelId});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return {promise, resolve}; };
type StopOptions = {flushFinalAudio?: boolean; disconnect?: boolean};
class FakeSession {
	state = 'connecting'; error: string | undefined; isDeafened = false;
	stops: Array<{announce: boolean; options: StopOptions}> = [];
	events: Array<[VoiceState, VoiceState]> = [];
	destinationChanges = 0;
	private cancelled = false;
	constructor(readonly assignment: Assignment, readonly onLost: () => void, readonly labelSource: (destination: string) => boolean, readonly isSelected: () => boolean,
		private readonly startHook: (session: FakeSession) => Promise<void>, private readonly stopHook: (session: FakeSession) => Promise<void>) {}
	async start() { await this.startHook(this); if (this.cancelled || !this.isSelected()) throw new SessionSelectionChangedError(); this.state = 'listening'; }
	async stop(announce: boolean, options: StopOptions = {}) { this.stops.push({announce, options}); this.cancelled = true; this.state = 'stopped'; await this.stopHook(this); }
	async announceAssignment() {}
	updateDestination(logChannelId: string) { this.assignment.logChannelId = logChannelId; this.destinationChanges++; }
	onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
		this.events.push([oldState, newState]);
		if (newState.id === 'bot' && newState.channelId === this.assignment.voiceChannelId) { this.isDeafened = Boolean(newState.deaf); this.state = this.isDeafened ? 'paused' : 'listening'; }
	}
	loseConnection() { this.state = 'error'; this.onLost(); }
}
function fixture(options: {initial?: Assignment[]; settings?: GuildSettings[]; guildIds?: string[]; start?: (session: FakeSession) => Promise<void>; stop?: (session: FakeSession) => Promise<void>; persist?: () => void; retryDelayMs?: number} = {}) {
	let stored = structuredClone(options.initial ?? []);
	let settings = structuredClone(options.settings ?? []);
	const guilds = new Collection<string, any>(); const channels = new Map<string, any>(); const users = new Collection<string, any>();
	const created: FakeSession[] = []; const leaves: string[] = [];
	for (const guildId of options.guildIds ?? ['guild']) {
		const guild: any = {id: guildId, voiceStates: {cache: new Collection()}, channels: {fetch: async (id: string) => channels.get(`${guildId}:${id}`) ?? null},
			members: {fetchMe: async () => ({id: 'bot'}), fetch: async (id: string) => ({user: users.get(id) ?? {id, bot: false}})}};
		for (const id of ['a', 'b', 'c', 'unmapped', 'text-a', 'text-b']) {
			const voice = !id.startsWith('text');
			channels.set(`${guildId}:${id}`, {id, guild, type: voice ? ChannelType.GuildVoice : ChannelType.GuildText, isVoiceBased: () => voice, isTextBased: () => true, isThread: () => false,
				permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages]), send: async () => undefined});
		}
		guilds.set(guildId, guild);
	}
	const client = {user: {id: 'bot'}, isReady: () => true, guilds: {cache: guilds, fetch: async (id: string) => guilds.get(id)}, users: {cache: users}} as unknown as Client;
	const manager = new SessionManager(client, {
		loadAssignments: () => structuredClone(stored),
		upsertAssignment: assignment => { options.persist?.(); stored = [...stored.filter(a => a.guildId !== assignment.guildId || a.voiceChannelId !== assignment.voiceChannelId), {...assignment}]; },
		removeAssignment: (guildId, voiceChannelId) => { options.persist?.(); stored = stored.filter(a => a.guildId !== guildId || a.voiceChannelId !== voiceChannelId); },
		loadGuildSettings: () => structuredClone(settings),
		upsertGuildSettings: entry => { options.persist?.(); settings = [...settings.filter(s => s.guildId !== entry.guildId), {...entry}]; },
		createSession: (_client, assignment, labelSource, onLost, isSelected) => { const session = new FakeSession(assignment, onLost, labelSource, isSelected, options.start ?? (async () => undefined), options.stop ?? (async () => undefined)); created.push(session); return session; },
		leaveVoice: guildId => { leaves.push(guildId); }, retryDelayMs: options.retryDelayMs ?? 30,
	});
	function move(id: string, channelId: string | null, {guildId = 'guild', bot = false, notify = true} = {}) {
		const guild = guilds.get(guildId); const user = {id, bot}; users.set(id, user);
		const previous = guild.voiceStates.cache.get(id) ?? {guild, id, channelId: null, member: {user}};
		const next = {guild, id, channelId, member: {user}};
		if (channelId) guild.voiceStates.cache.set(id, next); else guild.voiceStates.cache.delete(id);
		if (notify) manager.onVoiceStateUpdate(previous as VoiceState, next as VoiceState);
	}
	async function settle() {
		for (let count = 0; count < 30; count++) { await setImmediate(); if ((manager as any).mutations.size === 0) { await setImmediate(); return; } }
		throw new Error('Manager did not settle');
	}
	const active = (guildId = 'guild') => manager.list(guildId).find(entry => entry.botId)?.assignment.voiceChannelId;
	async function assign(...rooms: string[]) { for (const room of rooms) await manager.assign(route(room)); }
	return {manager, created, guilds, channels, users, leaves, move, settle, active, assign, stored: () => stored, settings: () => settings};
}

test('unlimited mappings wait idle and only human occupancy in assigned rooms wakes the bot', async () => {
	const f = fixture(); await f.assign('a', 'b', 'c');
	assert.deepEqual(f.manager.list('guild').map(entry => entry.state), ['idle', 'idle', 'idle']);
	f.move('music', 'a', {bot: true}); f.move('alice', 'unmapped'); await f.settle(); assert.equal(f.created.length, 0);
	f.move('alice', 'b'); await f.settle(); assert.equal(f.active(), 'b'); assert.equal(f.stored().length, 3); await f.manager.stop();
});
test('automatic routing stays in a busy room, then moves directly to a waiting occupied room', async () => {
	const f = fixture(); await f.assign('a', 'b');
	f.move('alice', 'a'); await f.settle(); f.move('bob', 'b'); await f.settle();
	assert.equal(f.active(), 'a'); assert.equal(f.manager.list('guild')[1].state, 'waiting');
	f.move('alice', null); await f.settle(); assert.equal(f.active(), 'b');
	assert.deepEqual(f.created[0].stops[0].options, {flushFinalAudio: true, disconnect: false}); assert.deepEqual(f.leaves, []);
	f.move('alice', 'a'); await f.settle(); assert.equal(f.active(), 'b'); await f.manager.stop();
});
test('the bot disconnects only when all mapped rooms are empty and wakes for the next call', async () => {
	const f = fixture(); await f.assign('a'); f.move('alice', 'a'); await f.settle(); f.move('alice', null); await f.settle();
	assert.equal(f.active(), undefined); assert.deepEqual(f.created[0].stops[0].options, {flushFinalAudio: true, disconnect: true});
	assert.equal(f.manager.list('guild')[0].state, 'idle'); f.move('alice', 'a'); await f.settle(); assert.equal(f.created.length, 2); await f.manager.stop();
});
test('one remaining human keeps the current call active', async () => {
	const f = fixture(); await f.assign('a', 'b'); f.move('alice', 'a'); f.move('bob', 'a'); await f.settle();
	f.move('carol', 'b'); f.move('alice', null); await f.settle(); assert.equal(f.active(), 'a'); assert.equal(f.created.length, 1); await f.manager.stop();
});
test('follow overrides a busy call and forced handoff cancels old audio', async () => {
	const f = fixture(); await f.assign('a', 'b'); f.move('alice', 'a'); f.move('target', 'b'); await f.settle();
	await f.manager.setFollow('guild', 'target'); assert.equal(f.active(), 'b');
	assert.deepEqual(f.created[0].stops[0].options, {flushFinalAudio: false, disconnect: false});
	assert.deepEqual(f.settings(), [{guildId: 'guild', followUserId: 'target'}]);
	f.move('target', 'a'); await f.settle(); assert.equal(f.active(), 'a'); await f.manager.stop();
});
test('follow never joins unmapped rooms; other speakers retain the call after the target leaves', async () => {
	const f = fixture(); await f.assign('a', 'b'); f.move('alice', 'a'); f.move('target', 'b'); f.move('bob', 'b'); await f.settle();
	await f.manager.setFollow('guild', 'target'); f.move('target', 'unmapped'); await f.settle(); assert.equal(f.active(), 'b');
	f.move('bob', null); await f.settle(); assert.equal(f.active(), 'a'); assert.ok(f.created.every(s => s.assignment.voiceChannelId !== 'unmapped')); await f.manager.stop();
});
test('turning follow off keeps the busy call and normal automatic fallback enabled', async () => {
	const f = fixture(); await f.assign('a', 'b'); f.move('alice', 'a'); f.move('target', 'b'); await f.settle(); await f.manager.setFollow('guild', 'target');
	await f.manager.setFollow('guild', undefined); assert.equal(f.active(), 'b'); assert.equal(f.manager.getFollow('guild'), undefined);
	assert.deepEqual(f.settings(), [{guildId: 'guild'}]); f.move('target', null); await f.settle(); assert.equal(f.active(), 'a'); await f.manager.stop();
});
test('an absent or unmapped follow target does not disable auto-join', async () => {
	const f = fixture(); await f.assign('a'); await f.manager.setFollow('guild', 'target'); f.move('target', 'unmapped'); f.move('alice', 'a'); await f.settle();
	assert.equal(f.active(), 'a'); await f.manager.stop();
});
test('restore loads all mappings and settings before choosing the saved follow target', async () => {
	const initial = [route(), route('b'), route('c')]; const f = fixture({initial, settings: [{guildId: 'guild', followUserId: 'target'}]});
	f.move('alice', 'a', {notify: false}); f.move('target', 'b', {notify: false}); await f.manager.restore();
	assert.equal(f.created.length, 1); assert.equal(f.active(), 'b'); assert.deepEqual(f.stored(), initial); await f.manager.stop();
});
test('repeated assignments and destination updates preserve the active voice session', async () => {
	const f = fixture(); f.move('alice', 'a', {notify: false}); await f.assign('a', 'a'); await f.manager.assign(route('a', 'text-b'));
	assert.equal(f.created.length, 1); assert.equal(f.created[0].destinationChanges, 1); assert.equal(f.created[0].assignment.logChannelId, 'text-b'); await f.manager.stop();
});
test('unassign removes only its mapping and serves an occupied waiting room', async () => {
	const f = fixture(); f.move('alice', 'a', {notify: false}); f.move('bob', 'b', {notify: false}); await f.assign('a', 'b');
	assert.equal(await f.manager.unassign('guild', 'a'), true); assert.equal(f.active(), 'b'); assert.deepEqual(f.stored(), [route('b')]); await f.manager.stop();
});
test('invalid permissions and failed persistence preserve the current mapping and call', async () => {
	let fail = false; const f = fixture({persist: () => { if (fail) throw new Error('disk full'); }});
	f.move('alice', 'a', {notify: false}); await f.assign('a'); f.channels.get('guild:text-b').permissionsFor = () => new PermissionsBitField();
	await assert.rejects(f.manager.assign(route('a', 'text-b')), AssignmentError); fail = true;
	await assert.rejects(f.manager.setFollow('guild', 'target'), /disk full/); assert.equal(f.manager.getFollow('guild'), undefined);
	await assert.rejects(f.manager.unassign('guild', 'a'), /disk full/); assert.equal(f.active(), 'a'); assert.equal(f.created[0].stops.length, 0); await f.manager.stop();
});
test('follow validates server membership and rejects bots', async () => {
	const f = fixture(); f.users.set('music', {id: 'music', bot: true}); await assert.rejects(f.manager.setFollow('guild', 'music'), AssignmentError);
	f.guilds.get('guild').members.fetch = async () => { throw new Error('missing'); }; await assert.rejects(f.manager.setFollow('guild', 'gone'), AssignmentError); assert.deepEqual(f.settings(), []); await f.manager.stop();
});
test('failed restore mappings remain visible and saved while valid mappings can run', async () => {
	const f = fixture({initial: [route(), route('b')]}); f.channels.get('guild:a').permissionsFor = () => new PermissionsBitField();
	f.move('alice', 'a', {notify: false}); f.move('bob', 'b', {notify: false}); await f.manager.restore();
	assert.equal(f.manager.list('guild')[0].state, 'error'); assert.equal(f.active(), 'b'); assert.equal(f.stored().length, 2); await f.manager.stop();
});
test('restored disallowed guilds cannot connect', async () => {
	const previous = config.allowedGuildIds;
	try { config.allowedGuildIds = ['other']; const f = fixture({initial: [route()]}); f.move('alice', 'a', {notify: false}); await f.manager.restore(); assert.equal(f.created.length, 0); assert.match(f.manager.list('guild')[0].error!, /not allowed/); await f.manager.stop(); }
	finally { config.allowedGuildIds = previous; }
});
test('one account chooses independently in different guilds', async () => {
	const f = fixture({guildIds: ['guild', 'other']}); f.move('alice', 'a', {notify: false}); f.move('bob', 'b', {guildId: 'other', notify: false});
	await Promise.all([f.manager.assign(route()), f.manager.assign(route('b', 'text-a', 'other'))]); assert.equal(f.active(), 'a'); assert.equal(f.active('other'), 'b'); await f.manager.stop();
});
test('deafening pauses the current call without hopping to another room', async () => {
	const f = fixture(); f.move('alice', 'a', {notify: false}); f.move('bob', 'b', {notify: false}); await f.assign('a', 'b');
	const state = {id: 'bot', guild: f.guilds.get('guild'), channelId: 'a', deaf: true} as VoiceState; f.manager.onVoiceStateUpdate(state, state); await f.settle();
	assert.equal(f.manager.list('guild')[0].state, 'paused'); assert.equal(f.active(), 'a'); await f.manager.stop();
});
test('late leave events and reconnect callbacks from A cannot affect replacement B', async () => {
	const f = fixture(); await f.assign('a', 'b'); f.move('alice', 'a'); f.move('target', 'b'); await f.settle(); await f.manager.setFollow('guild', 'target');
	const oldState = {id: 'bot', guild: f.guilds.get('guild'), channelId: 'a'} as VoiceState; const newState = {...oldState, channelId: null} as VoiceState;
	f.manager.onVoiceStateUpdate(oldState, newState); f.created[0].onLost(); await f.settle(); assert.equal(f.created[1].events.length, 0); assert.equal(f.active(), 'b'); assert.equal(f.created.length, 2); await f.manager.stop();
});
test('occupancy changes during awaited start cancel stale selection without marking it failed', async () => {
	const gate = deferred(); const f = fixture({start: async session => { if (session.assignment.voiceChannelId === 'a') await gate.promise; }});
	await f.assign('b'); f.move('alice', 'a', {notify: false}); const pending = f.manager.assign(route()); await setImmediate();
	f.move('bob', 'b'); f.move('alice', null); gate.resolve(); await pending; await f.settle();
	assert.equal(f.active(), 'b'); assert.equal(f.manager.list('guild').find(entry => entry.assignment.voiceChannelId === 'a')!.error, undefined); await f.manager.stop();
});
test('handoff reselects the latest follow location after the previous session finishes stopping', async () => {
	const gate = deferred(); let drain = true; const f = fixture({stop: async session => { if (drain && session.assignment.voiceChannelId === 'a') await gate.promise; }});
	await f.assign('a', 'b', 'c'); await f.manager.setFollow('guild', 'target'); f.move('alice', 'a'); await f.settle();
	f.move('target', 'b'); await setImmediate(); f.move('target', 'c'); drain = false; gate.resolve(); await f.settle();
	assert.deepEqual(f.created.map(session => session.assignment.voiceChannelId), ['a', 'c']); await f.manager.stop();
});
test('a direct-move destination becoming empty during drain triggers an explicit leave', async () => {
	const gate = deferred(); let drain = true; const f = fixture({stop: async () => { if (drain) await gate.promise; }});
	await f.assign('a', 'b'); f.move('alice', 'a'); f.move('bob', 'b'); await f.settle(); f.move('alice', null); await setImmediate();
	f.move('bob', null); drain = false; gate.resolve(); await f.settle(); assert.equal(f.active(), undefined); assert.deepEqual(f.leaves, ['guild']); await f.manager.stop();
});
test('deafen events still reach the old session during its final-audio drain', async () => {
	const gate = deferred(); let drain = true; const f = fixture({stop: async () => { if (drain) await gate.promise; }});
	await f.assign('a', 'b'); f.move('alice', 'a'); f.move('bob', 'b'); await f.settle(); f.move('alice', null); await setImmediate();
	const state = {id: 'bot', guild: f.guilds.get('guild'), channelId: 'a', deaf: true} as VoiceState; f.manager.onVoiceStateUpdate(state, state);
	assert.equal(f.created[0].events.at(-1)![1].deaf, true); drain = false; gate.resolve(); await f.settle(); await f.manager.stop();
});
test('failed replacement cleans up pending membership and retains its mapping for retry', async () => {
	const f = fixture({retryDelayMs: 1000, start: async session => { if (session.assignment.voiceChannelId === 'b') throw new Error('network failed'); }});
	await f.assign('a', 'b'); f.move('alice', 'a'); f.move('bob', 'b'); await f.settle(); f.move('alice', null); await f.settle();
	assert.deepEqual(f.leaves, ['guild']); assert.equal(f.manager.list('guild')[1].state, 'error'); assert.equal(f.stored().length, 2); await f.manager.stop();
});
test('cancelled replacement startup either leaves the old membership or restarts a newly occupied target', async () => {
	for (const returnsBeforeReady of [false, true]) {
		const gate = deferred(); let starts = 0;
		const f = fixture({start: async session => { if (session.assignment.voiceChannelId === 'b' && ++starts === 1) await gate.promise; }});
		await f.assign('a', 'b'); f.move('alice', 'a'); f.move('bob', 'b'); await f.settle();
		f.move('alice', null); await setImmediate();
		assert.equal(f.created[1].assignment.voiceChannelId, 'b');
		f.move('bob', null);
		if (returnsBeforeReady) f.move('bob', 'b');
		gate.resolve(); await f.settle();
		assert.equal(f.active(), returnsBeforeReady ? 'b' : undefined);
		assert.deepEqual(f.leaves, returnsBeforeReady ? [] : ['guild']);
		assert.ok(f.manager.list('guild').every(entry => entry.error === undefined));
		if (returnsBeforeReady) assert.equal(f.created.length, 3);
		await f.manager.stop();
	}
});
test('lost connections retry after the delay rather than immediately or repeatedly', async () => {
	const f = fixture(); f.move('alice', 'a', {notify: false}); await f.assign('a'); f.created[0].loseConnection(); f.created[0].onLost();
	await delay(5); assert.equal(f.created.length, 1); await delay(50); await f.settle(); assert.equal(f.created.length, 2); assert.equal(f.active(), 'a'); await f.manager.stop();
});
test('failed followed room retries without a new event while automatic fallback stays occupied', async () => {
	let failures = 1; const f = fixture({initial: [route(), route('b')], settings: [{guildId: 'guild', followUserId: 'target'}], start: async session => { if (session.assignment.voiceChannelId === 'b' && failures-- > 0) throw new Error('temporary'); }});
	f.move('alice', 'a', {notify: false}); f.move('target', 'b', {notify: false}); await f.manager.restore(); assert.equal(f.active(), 'a');
	await delay(50); await f.settle(); assert.equal(f.active(), 'b'); await f.manager.stop();
});
test('events in an already-restored guild are replayed after a later guild finishes restoring', async () => {
	const gate = deferred(); const f = fixture({guildIds: ['guild', 'other'], initial: [route(), route('b', 'text-a', 'other')], start: async session => { if (session.assignment.guildId === 'other') await gate.promise; }});
	f.move('alice', 'a', {notify: false}); f.move('bob', 'b', {guildId: 'other', notify: false}); const pending = f.manager.restore(); await setImmediate();
	assert.equal(f.active(), 'a'); f.move('alice', null); gate.resolve(); await pending; await f.settle(); assert.equal(f.active(), undefined); assert.equal(f.active('other'), 'b'); await f.manager.stop();
});
test('shared destinations gain source labels and shutdown preserves saved mappings', async () => {
	const f = fixture(); f.move('alice', 'a', {notify: false}); await f.assign('a'); assert.equal(f.created[0].labelSource('text-a'), false);
	await f.assign('b'); assert.equal(f.created[0].labelSource('text-a'), true); await f.manager.stop(); assert.equal(f.stored().length, 2);
	await assert.rejects(f.manager.assign(route()), /restarting/); f.move('bob', 'b'); await f.settle(); assert.equal(f.created.length, 1);
});
