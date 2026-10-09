import {
	ChannelType,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
	type ChatInputCommandInteraction,
	type Interaction,
} from 'discord.js';
import {config} from './config.js';
import {AssignmentError, type SessionManager} from './session-manager.js';

const voiceTypes = [ChannelType.GuildVoice, ChannelType.GuildStageVoice] as const;
const logTypes = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
	ChannelType.GuildVoice,
	ChannelType.GuildStageVoice,
	ChannelType.PublicThread,
	ChannelType.PrivateThread,
	ChannelType.AnnouncementThread,
] as const;

type CommandSessions = Pick<SessionManager, 'assign' | 'unassign' | 'list' | 'setFollow' | 'getFollow'>;

export const commandData = [
	new SlashCommandBuilder()
		.setName('scribe')
		.setDescription('Voice-channel transcription')
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild)
		.addSubcommand(sub => sub
			.setName('assign')
			.setDescription('Watch a voice channel and save its transcript destination')
			.addChannelOption(option => option
				.setName('voice_channel')
				.setDescription('Voice channel to watch for an active call')
				.addChannelTypes(...voiceTypes)
				.setRequired(true))
			.addChannelOption(option => option
				.setName('log_channel')
				.setDescription('Text channel, voice-channel chat, or thread for the transcript')
				.addChannelTypes(...logTypes)
				.setRequired(true)))
		.addSubcommand(sub => sub
			.setName('unassign')
			.setDescription('Remove one voice-channel assignment')
			.addChannelOption(option => option
				.setName('voice_channel')
				.setDescription('Voice channel to stop transcribing')
				.addChannelTypes(...voiceTypes)
				.setRequired(true)))
		.addSubcommand(sub => sub
			.setName('follow')
			.setDescription('Give one person priority when choosing a watched voice channel')
			.addUserOption(option => option
				.setName('user')
				.setDescription('Person to follow between watched voice channels')
				.setRequired(true)))
		.addSubcommand(sub => sub
			.setName('unfollow')
			.setDescription('Turn off following without interrupting the current call'))
		.addSubcommand(sub => sub
			.setName('status')
			.setDescription('Show watched channels, their current state, and the follow target'))
		.toJSON(),
];

export async function handleInteraction(interaction: Interaction, sessions: CommandSessions): Promise<void> {
	if (!interaction.isChatInputCommand() || interaction.commandName !== 'scribe' || !interaction.inGuild()) {
		return;
	}

	try {
		if (config.allowedGuildIds.length > 0 && !config.allowedGuildIds.includes(interaction.guildId)) {
			await interaction.reply({content: 'This server is not enabled for Scribe. Ask the bot owner to update ALLOWED_GUILD_IDS.', flags: MessageFlags.Ephemeral});
			return;
		}

		if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
			await interaction.reply({content: 'You need the Manage Server permission to use `/scribe`.', flags: MessageFlags.Ephemeral});
			return;
		}

		switch (interaction.options.getSubcommand()) {
			case 'assign': {
				await handleAssign(interaction, sessions);
				break;
			}

			case 'unassign': {
				await interaction.deferReply({flags: MessageFlags.Ephemeral});
				const voice = interaction.options.getChannel('voice_channel', true);
				if (!voiceTypes.some(type => type === voice.type)) {
					throw new AssignmentError('Choose a voice or stage channel to unassign.');
				}

				const removed = await sessions.unassign(interaction.guildId, voice.id);
				await interaction.editReply(removed
					? `Removed the assignment for <#${voice.id}>.`
					: `<#${voice.id}> has no assignment.`);
				break;
			}

			case 'follow': {
				await interaction.deferReply({flags: MessageFlags.Ephemeral});
				const user = interaction.options.getUser('user', true);
				const guild = interaction.guild ?? await interaction.client.guilds.fetch(interaction.guildId);
				const member = await guild.members.fetch(user.id).catch(() => null);
				if (!member) {
					throw new AssignmentError('Choose a person who is a member of this server.');
				}
				if (user.bot || member.user.bot) {
					throw new AssignmentError('Choose a person to follow. Bot accounts cannot be follow targets.');
				}
				await sessions.setFollow(interaction.guildId, member.id);
				await interaction.editReply({
					content: `Following <@${member.id}> within watched voice channels. Their mapped channel takes priority. Use \`/scribe unfollow\` to turn this off.`,
					allowedMentions: {parse: []},
				});
				break;
			}

			case 'unfollow': {
				await interaction.deferReply({flags: MessageFlags.Ephemeral});
				await sessions.setFollow(interaction.guildId, undefined);
				await interaction.editReply('Follow is off. The bot will stay with the current call while people remain.');
				break;
			}

			case 'status': {
				const followed = sessions.getFollow(interaction.guildId);
				const assignments = sessions.list(interaction.guildId);
				const lines = [
					`Follow: ${followed ? `<@${followed}> (watched channels only)` : 'off'}.`,
					`Watching ${assignments.length} voice channel${assignments.length === 1 ? '' : 's'}. One call at a time in this server.`,
				];
				if (assignments.length === 0) {
					lines.push('Use `/scribe assign` to watch a voice channel and choose its transcript destination.');
				}

				for (const session of assignments) {
					const {assignment, state, isDeafened, error} = session;
					lines.push(
						`<#${assignment.voiceChannelId}> → <#${assignment.logChannelId}>: ${describeState(state, isDeafened)}`
						+ (error ? `\n${error}` : ''),
					);
				}

				const messages = splitMessages(lines);
				await interaction.reply({content: messages[0], flags: MessageFlags.Ephemeral, allowedMentions: {parse: []}});
				for (const content of messages.slice(1)) {
					await interaction.followUp({content, flags: MessageFlags.Ephemeral, allowedMentions: {parse: []}});
				}

				break;
			}

			default:
				await interaction.reply({content: 'Unknown Scribe command. Reload Discord to refresh the available commands.', flags: MessageFlags.Ephemeral});
		}
	} catch (error) {
		const message = error instanceof AssignmentError
			? error.message
			: 'Scribe could not complete that command. Ask the bot owner to check its connection and server permissions, then try again.';
		console.error('[command]', error instanceof AssignmentError ? error.message : 'Unexpected command failure.');
		const messages = splitMessages([message]);
		if (interaction.deferred || interaction.replied) {
			await interaction.editReply({content: messages[0], allowedMentions: {parse: []}}).catch(() => undefined);
		} else {
			await interaction.reply({content: messages[0], flags: MessageFlags.Ephemeral, allowedMentions: {parse: []}}).catch(() => undefined);
		}
		for (const content of messages.slice(1)) {
			await interaction.followUp({content, flags: MessageFlags.Ephemeral, allowedMentions: {parse: []}}).catch(() => undefined);
		}
	}
}

async function handleAssign(interaction: ChatInputCommandInteraction<'cached' | 'raw'>, sessions: CommandSessions): Promise<void> {
	await interaction.deferReply({flags: MessageFlags.Ephemeral});
	const voice = interaction.options.getChannel('voice_channel', true);
	const log = interaction.options.getChannel('log_channel', true);
	if (!voiceTypes.some(type => type === voice.type)) {
		throw new AssignmentError('Choose a voice or stage channel to transcribe.');
	}

	if (!logTypes.some(type => type === log.type)) {
		throw new AssignmentError('Choose a text channel, announcement channel, voice-channel chat, or open thread for the transcript.');
	}

	const guild = interaction.guild ?? await interaction.client.guilds.fetch(interaction.guildId);
	const member = await guild.members.fetch(interaction.user.id);
	for (const channelId of new Set([voice.id, log.id])) {
		const channel = await guild.channels.fetch(channelId).catch(() => null);
		if (!channel || !channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
			throw new AssignmentError('You must be able to view both the voice channel and transcript destination. Choose channels you can access.');
		}
		if (channel.type === ChannelType.PrivateThread
			&& !channel.permissionsFor(member)?.has(PermissionFlagsBits.ManageThreads)
			&& !await channel.members.fetch(member.id).catch(() => null)) {
			throw new AssignmentError('Join the private destination thread before assigning transcripts to it.');
		}
	}

	await sessions.assign({
		guildId: interaction.guildId,
		voiceChannelId: voice.id,
		logChannelId: log.id,
	});

	const session = sessions.list(interaction.guildId).find(item => item.assignment.voiceChannelId === voice.id);
	await interaction.editReply({
		content: `Watching <#${voice.id}> → <#${log.id}>.`
			+ (session ? ` Status: ${describeState(session.state, session.isDeafened)}.` : '')
			+ `\nThe bot joins an occupied watched channel when idle. Server-deafen it to pause. Use \`/scribe unassign voice_channel:\` with <#${voice.id}> to remove this mapping.`,
		allowedMentions: {parse: []},
	});
}

function describeState(state: string, isDeafened: boolean): string {
	return isDeafened ? 'paused (deafened)' : state === 'listening' ? 'active' : state;
}

/** Keep every status entry, including long validation errors, within Discord's message limit. */
function splitMessages(lines: string[]): string[] {
	const messages: string[] = [];
	let current = '';
	for (const line of lines) {
		for (let offset = 0; offset < line.length; offset += 1900) {
			const part = line.slice(offset, offset + 1900);
			if (current && current.length + part.length + 1 > 1900) {
				messages.push(current);
				current = '';
			}

			current += (current ? '\n' : '') + part;
		}
	}

	if (current) messages.push(current);
	return messages;
}
