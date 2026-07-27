import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {config} from './config.js';

export type Assignment = {
	guildId: string;
	voiceChannelId: string;
	logChannelId: string;
};

const filePath = () => join(config.dataDir, 'assignments.json');

export function loadAssignments(): Assignment[] {
	try {
		return JSON.parse(readFileSync(filePath(), 'utf8')) as Assignment[];
	} catch {
		return [];
	}
}

export function saveAssignments(assignments: Assignment[]): void {
	mkdirSync(config.dataDir, {recursive: true});
	writeFileSync(filePath(), JSON.stringify(assignments, null, 2));
}

export function upsertAssignment(assignment: Assignment): void {
	const rest = loadAssignments().filter(a => a.guildId !== assignment.guildId);
	saveAssignments([...rest, assignment]);
}

export function removeAssignment(guildId: string): void {
	saveAssignments(loadAssignments().filter(a => a.guildId !== guildId));
}
