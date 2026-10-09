import {randomUUID} from 'node:crypto';
import {closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {config} from './config.js';

export type Assignment = {
	guildId: string;
	voiceChannelId: string;
	logChannelId: string;
};

const filePath = () => join(config.dataDir, 'assignments.json');

export function assignmentKey(guildId: string, voiceChannelId: string): string {
	return `${guildId}:${voiceChannelId}`;
}

function isSnowflake(value: unknown): value is string {
	return typeof value === 'string'
		&& /^[1-9]\d{0,19}$/.test(value)
		&& BigInt(value) <= 18_446_744_073_709_551_615n;
}

function validateAssignments(value: unknown): asserts value is Assignment[] {
	if (!Array.isArray(value)) {
		throw new Error('Invalid assignments: expected an array.');
	}

	const seen = new Set<string>();
	for (const [index, entry] of value.entries()) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)
			|| !isSnowflake(entry.guildId)
			|| !isSnowflake(entry.voiceChannelId)
			|| !isSnowflake(entry.logChannelId)) {
			throw new Error(`Invalid assignment at index ${index}: guildId, voiceChannelId and logChannelId must be snowflake strings.`);
		}

		const key = assignmentKey(entry.guildId, entry.voiceChannelId);
		if (seen.has(key)) {
			throw new Error(`Invalid assignments: duplicate guild and voice channel at index ${index}.`);
		}

		seen.add(key);
	}
}

export function loadAssignments(): Assignment[] {
	let contents: string;
	try {
		contents = readFileSync(filePath(), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}

		throw error;
	}

	let assignments: unknown;
	try {
		assignments = JSON.parse(contents);
	} catch {
		throw new Error('Invalid assignments.json: expected valid JSON. Repair the file before starting the bot.');
	}

	validateAssignments(assignments);
	return assignments;
}

export function saveAssignments(assignments: Assignment[]): void {
	validateAssignments(assignments);
	mkdirSync(config.dataDir, {recursive: true});
	const temporaryPath = join(config.dataDir, `.assignments-${randomUUID()}.tmp`);
	let file: number | undefined;
	try {
		file = openSync(temporaryPath, 'wx', 0o600);
		writeFileSync(file, `${JSON.stringify(assignments, null, 2)}\n`, 'utf8');
		fsyncSync(file);
		closeSync(file);
		file = undefined;
		renameSync(temporaryPath, filePath());

		// Persist the rename as well as the file contents before reporting success.
		const directory = openSync(config.dataDir, 'r');
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	} finally {
		if (file !== undefined) {
			closeSync(file);
		}
		rmSync(temporaryPath, {force: true});
	}
}

export function upsertAssignment(assignment: Assignment): void {
	validateAssignments([assignment]);
	const key = assignmentKey(assignment.guildId, assignment.voiceChannelId);
	const rest = loadAssignments().filter(a => assignmentKey(a.guildId, a.voiceChannelId) !== key);
	saveAssignments([...rest, assignment]);
}

export function removeAssignment(guildId: string, voiceChannelId: string): void {
	const key = assignmentKey(guildId, voiceChannelId);
	saveAssignments(loadAssignments().filter(a => assignmentKey(a.guildId, a.voiceChannelId) !== key));
}
