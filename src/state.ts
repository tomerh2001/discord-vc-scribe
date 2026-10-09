import {randomUUID} from 'node:crypto';
import {closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {config} from './config.js';

export type Assignment = {
	guildId: string;
	voiceChannelId: string;
	logChannelId: string;
};

export type GuildSettings = {
	guildId: string;
	/** A selected person takes priority over the ordinary occupied-room queue. */
	followUserId?: string;
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
	writeState('assignments.json', assignments);
}

function writeState(fileName: string, value: unknown): void {
	mkdirSync(config.dataDir, {recursive: true});
	const temporaryPath = join(config.dataDir, `.${fileName}-${randomUUID()}.tmp`);
	let file: number | undefined;
	try {
		file = openSync(temporaryPath, 'wx', 0o600);
		writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
		fsyncSync(file);
		closeSync(file);
		file = undefined;
		renameSync(temporaryPath, join(config.dataDir, fileName));

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

function validateGuildSettings(value: unknown): asserts value is GuildSettings[] {
	if (!Array.isArray(value)) throw new Error('Invalid settings: expected an array.');
	const seen = new Set<string>();
	for (const [index, entry] of value.entries()) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)
			|| !isSnowflake(entry.guildId)
			|| (entry.followUserId !== undefined && !isSnowflake(entry.followUserId))) {
			throw new Error(`Invalid settings at index ${index}: guildId and optional followUserId must be snowflake strings.`);
		}
		if (seen.has(entry.guildId)) throw new Error(`Invalid settings: duplicate guild at index ${index}.`);
		seen.add(entry.guildId);
	}
}

export function loadGuildSettings(): GuildSettings[] {
	let contents: string;
	try {
		contents = readFileSync(join(config.dataDir, 'settings.json'), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	let settings: unknown;
	try {
		settings = JSON.parse(contents);
	} catch {
		throw new Error('Invalid settings.json: expected valid JSON. Repair the file before starting the bot.');
	}
	validateGuildSettings(settings);
	return settings;
}

export function saveGuildSettings(settings: GuildSettings[]): void {
	validateGuildSettings(settings);
	writeState('settings.json', settings);
}

export function upsertGuildSettings(settings: GuildSettings): void {
	validateGuildSettings([settings]);
	const existing = loadGuildSettings().filter(entry => entry.guildId !== settings.guildId);
	saveGuildSettings([...existing, settings]);
}
