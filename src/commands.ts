import {
	ChannelType,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
	type ChatInputCommandInteraction,
	type Interaction,
} from 'discord.js';
import type {SessionManager} from './session.js';

export const commandData = [
	new SlashCommandBuilder()
		.setName('scribe')
		.setDescription('Voice-channel transcription')
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild)
		.addSubcommand(sub => sub
			.setName('assign')
			.setDescription('Assign the bot to a voice channel and start logging')
			.addChannelOption(option => option
				.setName('voice_channel')
				.setDescription('Voice channel the bot should sit in')
				.addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
				.setRequired(true))
			.addChannelOption(option => option
				.setName('log_channel')
				.setDescription('Text channel the transcript is written to')
				.addChannelTypes(ChannelType.GuildText)
				.setRequired(true)))
		.addSubcommand(sub => sub
			.setName('unassign')
			.setDescription('Remove the bot from its voice channel'))
		.addSubcommand(sub => sub
			.setName('status')
			.setDescription('Show what the bot is doing in this server'))
		.toJSON(),
];

export async function handleInteraction(interaction: Interaction, sessions: SessionManager): Promise<void> {
	if (!interaction.isChatInputCommand() || interaction.commandName !== 'scribe' || !interaction.inGuild()) {
		return;
	}

	try {
		switch (interaction.options.getSubcommand()) {
			case 'assign': {
				await handleAssign(interaction, sessions);
				break;
			}

			case 'unassign': {
				await interaction.deferReply({flags: MessageFlags.Ephemeral});
				const removed = await sessions.unassign(interaction.guildId);
				await interaction.editReply(removed
					? '👋 Unassigned — I left the voice channel.'
					: 'I am not assigned to any voice channel in this server.');
				break;
			}

			case 'status': {
				const session = sessions.get(interaction.guildId);
				const content = session
					? `📌 Sitting in <#${session.assignment.voiceChannelId}>, logging to <#${session.assignment.logChannelId}>.`
						+ (session.isDeafened ? '\n🔇 Currently deafened — transcription paused.' : '\n🎙️ Transcription active.')
					: 'Not assigned to any voice channel. Use `/scribe assign` to start.';
				await interaction.reply({content, flags: MessageFlags.Ephemeral});
				break;
			}

			default:
		}
	} catch (error) {
		console.error('[command]', error);
		const message = '⚠️ Something went wrong — check the bot logs.';
		if (interaction.deferred || interaction.replied) {
			await interaction.editReply(message).catch(() => undefined);
		} else {
			await interaction.reply({content: message, flags: MessageFlags.Ephemeral}).catch(() => undefined);
		}
	}
}

async function handleAssign(interaction: ChatInputCommandInteraction<'cached' | 'raw'>, sessions: SessionManager): Promise<void> {
	await interaction.deferReply({flags: MessageFlags.Ephemeral});
	const voiceChannel = interaction.options.getChannel('voice_channel', true);
	const logChannel = interaction.options.getChannel('log_channel', true);

	await sessions.assign({
		guildId: interaction.guildId,
		voiceChannelId: voiceChannel.id,
		logChannelId: logChannel.id,
	});

	await interaction.editReply(
		`📌 Assigned to <#${voiceChannel.id}>. Transcript goes to <#${logChannel.id}>.\n`
		+ 'Server-deafen me to pause transcription; `/scribe unassign` to remove me.',
	);
}
