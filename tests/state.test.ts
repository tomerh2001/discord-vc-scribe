import assert from 'node:assert/strict';
import {closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';

process.env.DISCORD_TOKEN = 'state-test-primary';

const {config} = await import('../src/config.js');
const {assignmentKey, loadAssignments, saveAssignments, upsertAssignment, removeAssignment, loadGuildSettings, saveGuildSettings, upsertGuildSettings} = await import('../src/state.js');
type Assignment = import('../src/state.js').Assignment;

const first: Assignment = {
	guildId: '100000000000000001',
	voiceChannelId: '200000000000000001',
	logChannelId: '300000000000000001',
};
const second: Assignment = {...first, voiceChannelId: '200000000000000002'};
const otherGuild: Assignment = {...first, guildId: '100000000000000002'};

function useDataDir(t: TestContext): string {
	const previous = config.dataDir;
	const directory = mkdtempSync(join(tmpdir(), 'scribe-state-test-'));
	config.dataDir = directory;
	t.after(() => {
		config.dataDir = previous;
		rmSync(directory, {recursive: true, force: true});
	});
	return join(directory, 'assignments.json');
}

test('missing state is empty and existing assignment arrays load unchanged', t => {
	const path = useDataDir(t);
	assert.deepEqual(loadAssignments(), []);
	writeFileSync(path, JSON.stringify([first]));
	assert.deepEqual(loadAssignments(), [first]);
});

test('upsert and removal affect only the selected guild and voice channel pair', t => {
	useDataDir(t);
	upsertAssignment(first);
	upsertAssignment(second);
	upsertAssignment(otherGuild);
	assert.deepEqual(loadAssignments(), [first, second, otherGuild]);
	assert.notEqual(assignmentKey(first.guildId, first.voiceChannelId), assignmentKey(second.guildId, second.voiceChannelId));
	assert.notEqual(assignmentKey(first.guildId, first.voiceChannelId), assignmentKey(otherGuild.guildId, otherGuild.voiceChannelId));

	const rerouted = {...first, logChannelId: '300000000000000002'};
	upsertAssignment(rerouted);
	assert.deepEqual(loadAssignments(), [second, otherGuild, rerouted]);
	removeAssignment(first.guildId, first.voiceChannelId);
	assert.deepEqual(loadAssignments(), [second, otherGuild]);
	removeAssignment(first.guildId, first.voiceChannelId);
	assert.deepEqual(loadAssignments(), [second, otherGuild]);
});

test('corrupt JSON fails loudly and cannot be overwritten by an upsert', t => {
	const path = useDataDir(t);
	const corrupt = '[{"guildId":';
	writeFileSync(path, corrupt);
	assert.throws(() => loadAssignments(), /Invalid assignments\.json/);
	assert.throws(() => upsertAssignment(second), /Invalid assignments\.json/);
	assert.throws(() => removeAssignment(first.guildId, first.voiceChannelId), /Invalid assignments\.json/);
	assert.equal(readFileSync(path, 'utf8'), corrupt);
});

test('invalid assignment shapes, IDs and duplicate routes are rejected', t => {
	const path = useDataDir(t);
	const invalid: unknown[] = [
		null,
		{},
		[null],
		[[]],
		[{}],
		[{...first, guildId: 100}],
		[{...first, voiceChannelId: ''}],
		[{...first, voiceChannelId: '0'}],
		[{...first, voiceChannelId: '0123'}],
		[{...first, voiceChannelId: '123 456'}],
		[{...first, logChannelId: '-123'}],
		[{...first, logChannelId: '18446744073709551616'}],
		[first, {...first, logChannelId: second.logChannelId}],
	];
	for (const value of invalid) {
		writeFileSync(path, JSON.stringify(value));
		assert.throws(() => loadAssignments(), /Invalid assignment/);
	}

	saveAssignments([first]);
	for (const value of invalid) {
		assert.throws(() => saveAssignments(value as Assignment[]), /Invalid assignment/);
		assert.deepEqual(loadAssignments(), [first]);
	}
});

test('read failures other than ENOENT are propagated', t => {
	const path = useDataDir(t);
	mkdirSync(path);
	assert.throws(() => loadAssignments(), {code: 'EISDIR'});
});

test('saving atomically replaces state with owner-only permissions', t => {
	const path = useDataDir(t);
	saveAssignments([first]);
	const oldFile = openSync(path, 'r');
	try {
		const oldInode = fstatSync(oldFile).ino;
		saveAssignments([first, second]);
		assert.notEqual(statSync(path).ino, oldInode);
		assert.deepEqual(JSON.parse(readFileSync(oldFile, 'utf8')), [first]);
		assert.deepEqual(loadAssignments(), [first, second]);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.deepEqual(readdirSync(config.dataDir), ['assignments.json']);
	} finally {
		closeSync(oldFile);
	}
});

test('failed atomic replacement removes temporary state files', t => {
	const path = useDataDir(t);
	mkdirSync(path);
	assert.throws(() => saveAssignments([first]));
	assert.ok(statSync(path).isDirectory());
	assert.deepEqual(readdirSync(config.dataDir), ['assignments.json']);
});

test('follow settings default off, survive reload, and disable without changing other guilds or routes', t => {
	useDataDir(t);
	assert.deepEqual(loadGuildSettings(), []);
	saveAssignments([first, second]);
	upsertGuildSettings({guildId: first.guildId, followUserId: '400000000000000001'});
	upsertGuildSettings({guildId: otherGuild.guildId, followUserId: '400000000000000002'});
	assert.equal(loadGuildSettings().find(s => s.guildId === first.guildId)?.followUserId, '400000000000000001');
	upsertGuildSettings({guildId: first.guildId});
	assert.deepEqual(loadGuildSettings(), [
		{guildId: otherGuild.guildId, followUserId: '400000000000000002'},
		{guildId: first.guildId},
	]);
	assert.deepEqual(loadAssignments(), [first, second]);
	assert.equal(statSync(join(config.dataDir, 'settings.json')).mode & 0o777, 0o600);
});

test('corrupt or invalid follow settings are rejected before replacing saved state', t => {
	useDataDir(t);
	const path = join(config.dataDir, 'settings.json');
	writeFileSync(path, '{invalid');
	assert.throws(() => upsertGuildSettings({guildId: first.guildId}), /Invalid settings.json/);
	assert.equal(readFileSync(path, 'utf8'), '{invalid');
	for (const value of [null, {}, [null], [{guildId: first.guildId, followUserId: null}],
		[{guildId: first.guildId, followUserId: 'not-an-id'}],
		[{guildId: first.guildId}, {guildId: first.guildId}]]) {
		writeFileSync(path, JSON.stringify(value));
		assert.throws(() => loadGuildSettings(), /Invalid settings/);
	}
	saveGuildSettings([{guildId: first.guildId}]);
	assert.throws(() => upsertGuildSettings({guildId: first.guildId, followUserId: '0'}), /Invalid settings/);
	assert.deepEqual(loadGuildSettings(), [{guildId: first.guildId}]);
});
