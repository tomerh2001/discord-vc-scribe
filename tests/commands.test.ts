import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ChannelType, MessageFlags, PermissionFlagsBits, type Interaction} from 'discord.js';
import {commandData, handleInteraction} from '../src/commands.js';
import {config} from '../src/config.js';
import {AssignmentError, type AssignmentStatus} from '../src/session-manager.js';
import type {Assignment} from '../src/state.js';

type CommandSessions = Parameters<typeof handleInteraction>[1];
type Response = {method: string; content?: string; flags?: number; allowedMentions?: {parse: string[]}};

function interaction(command: string, options: {
	manage?: boolean; voiceId?: string; voiceType?: ChannelType; logType?: ChannelType; hidden?: string;
	threadMember?: boolean; manageThreads?: boolean;
	targetId?: string; targetBot?: boolean; targetMissing?: boolean;
} = {}) {
	const messages: Response[] = [];
	const instance = {
		commandName: 'scribe', guildId: 'guild', deferred: false, replied: false,
		user: {id: 'admin'},
		isChatInputCommand: () => true,
		inGuild: () => true,
		memberPermissions: {has: (permission: bigint) => permission === PermissionFlagsBits.ManageGuild && options.manage !== false},
		guild: {
			members: {fetch: async (id: string) => {
				if (id !== 'admin' && options.targetMissing) throw new Error('Unknown member');
				return {id, user: {id, bot: options.targetBot ?? false}};
			}},
			channels: {fetch: async (id: string) => ({
				type: id === 'log' ? options.logType ?? ChannelType.GuildText : options.voiceType ?? ChannelType.GuildVoice,
				permissionsFor: () => ({has: (permission: bigint) => id !== options.hidden
					&& (permission !== PermissionFlagsBits.ManageThreads || options.manageThreads === true)}),
				members: {fetch: async () => options.threadMember === false ? null : {id: 'admin'}},
			})},
		},
		options: {
			getSubcommand: () => command,
			getUser: () => ({id: options.targetId ?? 'person', bot: options.targetBot ?? false}),
			getChannel: (name: string) => name === 'voice_channel'
				? {id: options.voiceId ?? 'voice', type: options.voiceType ?? ChannelType.GuildVoice}
				: {id: 'log', type: options.logType ?? ChannelType.GuildText},
		},
		async reply(payload: Omit<Response, 'method'>) {this.replied = true; messages.push({method: 'reply', ...payload});},
		async deferReply(payload: Omit<Response, 'method'>) {this.deferred = true; messages.push({method: 'defer', ...payload});},
		async editReply(payload: string | Omit<Response, 'method'>) {
			messages.push({method: 'edit', ...(typeof payload === 'string' ? {content: payload} : payload)});
		},
		async followUp(payload: Omit<Response, 'method'>) {messages.push({method: 'followUp', ...payload});},
	};
	return {value: instance as unknown as Interaction, messages};
}

function sessions(initial: AssignmentStatus[] = [], initialFollow?: string) {
	let records = [...initial];
	const assigned: Assignment[] = [];
	const removed: [string, string][] = [];
	const followUpdates: [string, string | undefined][] = [];
	const followed = new Map(initialFollow ? [['guild', initialFollow]] : []);
	const manager: CommandSessions = {
		async assign(assignment) {
			assigned.push(assignment);
			records.push({assignment, state: 'idle', isDeafened: false});
		},
		async unassign(guildId, voiceId) {
			removed.push([guildId, voiceId]);
			const count = records.length;
			records = records.filter(row => row.assignment.guildId !== guildId || row.assignment.voiceChannelId !== voiceId);
			return records.length !== count;
		},
		list(guildId) {return records.filter(row => row.assignment.guildId === guildId);},
		async setFollow(guildId, userId) {
			followUpdates.push([guildId, userId]);
			if (userId) followed.set(guildId, userId);
			else followed.delete(guildId);
		},
		getFollow(guildId) {return followed.get(guildId);},
	};
	return {manager, assigned, removed, followUpdates};
}

function record(voice: string, extra: Partial<AssignmentStatus> = {}): AssignmentStatus {
	return {assignment: {guildId: 'guild', voiceChannelId: voice, logChannelId: 'log'}, state: 'active', isDeafened: false, botId: 'bot', ...extra};
}

test('commands require an explicit voice channel for unassign and expose voice chat and thread destinations', () => {
	const options = commandData[0].options as Array<{name: string; options?: Array<{name: string; required?: boolean; channel_types?: number[]}>}>;
	const unassign = options.find(option => option.name === 'unassign')!;
	assert.equal(unassign.options?.find(option => option.name === 'voice_channel')?.required, true);
	assert.equal(options.find(option => option.name === 'follow')?.options?.find(option => option.name === 'user')?.required, true);
	assert.ok(options.some(option => option.name === 'unfollow'));
	const destination = options.find(option => option.name === 'assign')?.options?.find(option => option.name === 'log_channel');
	for (const type of [ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.GuildAnnouncement]) {
		assert.ok(destination?.channel_types?.includes(type));
	}
});

test('Manage Server is enforced at runtime for every command', async () => {
	for (const command of ['assign', 'unassign', 'follow', 'unfollow', 'status']) {
		const fake = interaction(command, {manage: false});
		const state = sessions();
		await handleInteraction(fake.value, state.manager);
		assert.match(fake.messages[0].content!, /Manage Server/);
		assert.equal(fake.messages[0].flags, MessageFlags.Ephemeral);
		assert.equal(state.assigned.length, 0);
		assert.equal(state.removed.length, 0);
		assert.equal(state.followUpdates.length, 0);
	}
});

test('the guild allowlist also rejects interactions at runtime', async () => {
	const previous = [...config.allowedGuildIds];
	config.allowedGuildIds.splice(0, config.allowedGuildIds.length, 'another-guild');
	try {
		for (const command of ['assign', 'unassign', 'follow', 'unfollow', 'status']) {
			const fake = interaction(command);
			const state = sessions();
			await handleInteraction(fake.value, state.manager);
			assert.match(fake.messages[0].content!, /not enabled/);
			assert.equal(state.assigned.length, 0);
			assert.equal(state.removed.length, 0);
			assert.equal(state.followUpdates.length, 0);
		}
	} finally {
		config.allowedGuildIds.splice(0, config.allowedGuildIds.length, ...previous);
	}
});

test('assign accepts every supported transcript destination without replacing other voice channels', async () => {
	const state = sessions([record('existing')]);
	for (const type of [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]) {
		const fake = interaction('assign', {voiceId: `voice-${type}`, logType: type});
		await handleInteraction(fake.value, state.manager);
		assert.equal(fake.messages[0].flags, MessageFlags.Ephemeral);
		assert.match(fake.messages.at(-1)!.content!, /idle/);
	}
	assert.equal(state.assigned.length, 7);
	assert.ok(state.manager.list('guild').some(row => row.assignment.voiceChannelId === 'existing'));
});

test('assign rejects inaccessible source and destination channels', async t => {
	t.mock.method(console, 'error', () => undefined);
	for (const hidden of ['voice', 'log']) {
		const fake = interaction('assign', {hidden});
		const state = sessions();
		await handleInteraction(fake.value, state.manager);
		assert.equal(state.assigned.length, 0);
		assert.match(fake.messages.at(-1)!.content!, /view both/);
	}
});

test('assign rejects categories and forum containers before changing assignments', async t => {
	t.mock.method(console, 'error', () => undefined);
	for (const options of [{voiceType: ChannelType.GuildCategory}, {logType: ChannelType.GuildForum}]) {
		const fake = interaction('assign', options);
		const state = sessions();
		await handleInteraction(fake.value, state.manager);
		assert.equal(state.assigned.length, 0);
		assert.match(fake.messages.at(-1)!.content!, /Choose/);
	}
});

test('private-thread destinations require caller membership or Manage Threads permission', async t => {
	t.mock.method(console, 'error', () => undefined);
	for (const manageThreads of [false, true]) {
		const fake = interaction('assign', {logType: ChannelType.PrivateThread, threadMember: false, manageThreads});
		const state = sessions();
		await handleInteraction(fake.value, state.manager);
		assert.equal(state.assigned.length, manageThreads ? 1 : 0);
		if (!manageThreads) assert.match(fake.messages.at(-1)!.content!, /Join the private destination thread/);
	}
});

test('unassign removes only the selected voice channel', async () => {
	const fake = interaction('unassign', {voiceId: 'second'});
	const state = sessions([record('first'), record('second')]);
	await handleInteraction(fake.value, state.manager);
	assert.deepEqual(state.removed, [['guild', 'second']]);
	assert.deepEqual(state.manager.list('guild').map(row => row.assignment.voiceChannelId), ['first']);
	assert.match(fake.messages.at(-1)!.content!, /Removed.*second/);
});

test('status reports active, waiting, idle, and paused mappings with following off by default', async () => {
	const fake = interaction('status');
	const state = sessions([
		record('current', {state: 'listening'}), record('empty', {state: 'idle'}),
		record('queued', {state: 'waiting'}), record('paused', {isDeafened: true}),
	]);
	await handleInteraction(fake.value, state.manager);
	assert.match(fake.messages[0].content!, /Follow: off/);
	assert.match(fake.messages[0].content!, /One call at a time/);
	assert.match(fake.messages[0].content!, /<#current>.*active/);
	assert.match(fake.messages[0].content!, /<#empty>.*idle/);
	assert.match(fake.messages[0].content!, /<#queued>.*waiting/);
	assert.match(fake.messages[0].content!, /<#paused>.*paused \(deafened\)/);
	assert.equal(fake.messages[0].flags, MessageFlags.Ephemeral);
});

test('follow selects a server member, shows the saved target, and keeps replies ephemeral', async () => {
	const fake = interaction('follow', {targetId: 'person'});
	const state = sessions([record('current')]);
	await handleInteraction(fake.value, state.manager);
	assert.deepEqual(state.followUpdates, [['guild', 'person']]);
	assert.match(fake.messages.at(-1)!.content!, /Following <@person>.*mapped channel takes priority/);
	assert.equal(fake.messages[0].flags, MessageFlags.Ephemeral);
	assert.deepEqual(fake.messages.at(-1)!.allowedMentions, {parse: []});
	const status = interaction('status');
	await handleInteraction(status.value, state.manager);
	assert.match(status.messages[0].content!, /Follow: <@person> \(watched channels only\)/);
});

test('follow rejects bot accounts and people outside this server without changing the saved target', async t => {
	t.mock.method(console, 'error', () => undefined);
	for (const options of [{targetBot: true}, {targetMissing: true}]) {
		const fake = interaction('follow', options);
		const state = sessions([], 'existing-person');
		await handleInteraction(fake.value, state.manager);
		assert.deepEqual(state.followUpdates, []);
		assert.equal(state.manager.getFollow('guild'), 'existing-person');
		assert.match(fake.messages.at(-1)!.content!, /Choose a person/);
	}
});

test('unfollow clears only the priority override and leaves mappings intact', async () => {
	const fake = interaction('unfollow');
	const rows = [record('current'), record('waiting', {state: 'waiting'})];
	const state = sessions(rows, 'person');
	await handleInteraction(fake.value, state.manager);
	assert.deepEqual(state.followUpdates, [['guild', undefined]]);
	assert.equal(state.manager.getFollow('guild'), undefined);
	assert.deepEqual(state.manager.list('guild'), rows);
	assert.deepEqual(state.removed, []);
	assert.deepEqual(state.assigned, []);
	assert.match(fake.messages.at(-1)!.content!, /stay with the current call/);
	assert.equal(fake.messages[0].flags, MessageFlags.Ephemeral);
});

test('large status lists retain all assignments and long errors across bounded ephemeral replies', async () => {
	const fake = interaction('status');
	const rows = Array.from({length: 75}, (_, i) => record(`voice-${i}`, i === 0 ? {error: 'e'.repeat(3000)} : {}));
	await handleInteraction(fake.value, sessions(rows).manager);
	assert.ok(fake.messages.length > 1);
	for (const response of fake.messages) {
		assert.ok(response.content!.length > 0 && response.content!.length <= 2000);
		assert.equal(response.flags, MessageFlags.Ephemeral);
		assert.deepEqual(response.allowedMentions, {parse: []});
	}
	const combined = fake.messages.map(message => message.content).join('\n');
	for (const row of rows) assert.ok(combined.includes(`<#${row.assignment.voiceChannelId}>`));
	assert.equal(combined.replaceAll(/[^e]/g, '').length >= 3000, true);
});

test('permission errors are actionable; unexpected errors never expose secrets', async t => {
	const logged: unknown[][] = [];
	t.mock.method(console, 'error', (...args: unknown[]) => logged.push(args));
	const safeMessage = 'The bot needs View Channel and Connect in the selected voice channel.';
	for (const error of [new AssignmentError(safeMessage), new Error('secret-token-response')]) {
		const fake = interaction('assign');
		const state = sessions();
		state.manager.assign = async () => {throw error;};
		await handleInteraction(fake.value, state.manager);
		if (error instanceof AssignmentError) assert.equal(fake.messages.at(-1)!.content, safeMessage);
		else assert.match(fake.messages.at(-1)!.content!, /could not complete/);
		assert.ok(!JSON.stringify(fake.messages).includes('secret-token-response'));
	}
	assert.ok(!JSON.stringify(logged).includes('secret-token-response'));
});

test('long actionable errors are split without losing diagnostics', async t => {
	t.mock.method(console, 'error', () => undefined);
	const fake = interaction('assign');
	const state = sessions();
	const message = 'Permission denied for this bot. '.repeat(140);
	state.manager.assign = async () => {throw new AssignmentError(message);};
	await handleInteraction(fake.value, state.manager);
	const replies = fake.messages.filter(reply => reply.method !== 'defer');
	assert.equal(replies.map(reply => reply.content).join(''), message);
	assert.ok(replies.every(reply => reply.content!.length <= 2000));
	assert.ok(replies.filter(reply => reply.method === 'followUp').every(reply => reply.flags === MessageFlags.Ephemeral));
});
