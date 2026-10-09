import assert from 'node:assert/strict';
import {closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test, type TestContext} from 'node:test';

process.env.DISCORD_TOKEN = 'state-test-primary';
process.env.DISCORD_WORKER_TOKENS = '[]';

const {config} = await import('../src/config.js');
const {assignmentKey, loadAssignments, saveAssignments, upsertAssignment, removeAssignment} = await import('../src/state.js');
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

function readConfig(workerTokens?: string) {
	const env: NodeJS.ProcessEnv = {...process.env, DISCORD_TOKEN: 'primary-test-token', DOTENV_CONFIG_PATH: '/nonexistent/scribe-test.env'};
	delete env.DISCORD_WORKER_TOKENS;
	if (workerTokens !== undefined) {
		env.DISCORD_WORKER_TOKENS = workerTokens;
	}
	return spawnSync(process.execPath, [
		'--import', 'tsx', '--input-type=module', '--eval',
		"const {config} = await import('./src/config.ts'); console.log(JSON.stringify(config.workerTokens));",
	], {cwd: new URL('..', import.meta.url), env, encoding: 'utf8'});
}

test('worker token configuration defaults to empty and accepts distinct identities', () => {
	const empty = readConfig();
	assert.equal(empty.status, 0, empty.stderr);
	assert.deepEqual(JSON.parse(empty.stdout), []);
	const configured = readConfig('["worker-test-a","worker-test-b"]');
	assert.equal(configured.status, 0, configured.stderr);
	assert.deepEqual(JSON.parse(configured.stdout), ['worker-test-a', 'worker-test-b']);
});

test('invalid worker token configuration fails without exposing token values', () => {
	for (const input of [
		'not-json-secret',
		'{}',
		'[null]',
		'[""]',
		'[" worker-private-secret "]',
		'["worker-private-secret","worker-private-secret"]',
		'["primary-test-token"]',
	]) {
		const result = readConfig(input);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /DISCORD_WORKER_TOKENS/);
		assert.doesNotMatch(result.stderr, /not-json-secret|worker-private-secret|primary-test-token/);
		assert.equal(result.stdout, '');
	}
});
