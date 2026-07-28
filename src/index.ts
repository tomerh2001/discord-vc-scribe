import {Client, Events, GatewayIntentBits} from 'discord.js';
import {commandData, handleInteraction} from './commands.js';
import {config} from './config.js';
import {SessionManager} from './session.js';

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const sessions = new SessionManager(client);

function isGuildAllowed(guildId: string): boolean {
	return config.allowedGuildIds.length === 0 || config.allowedGuildIds.includes(guildId);
}

client.once(Events.ClientReady, async readyClient => {
	console.log(`Logged in as ${readyClient.user.tag}`);

	for (const guild of readyClient.guilds.cache.values()) {
		if (!isGuildAllowed(guild.id)) {
			console.warn(`Leaving disallowed guild ${guild.name} (${guild.id})`);
			await guild.leave().catch(error => console.error(`Failed to leave ${guild.id}:`, error));
			continue;
		}

		try {
			await guild.commands.set(commandData);
		} catch (error) {
			console.error(`Failed to register commands in ${guild.name}:`, error);
		}
	}

	await sessions.restore();
	console.log('Ready.');
});

client.on(Events.GuildCreate, async guild => {
	if (!isGuildAllowed(guild.id)) {
		console.warn(`Leaving disallowed guild ${guild.name} (${guild.id})`);
		await guild.leave().catch(error => console.error(`Failed to leave ${guild.id}:`, error));
		return;
	}

	try {
		await guild.commands.set(commandData);
	} catch (error) {
		console.error(`Failed to register commands in ${guild.name}:`, error);
	}
});

client.on(Events.InteractionCreate, interaction => {
	void handleInteraction(interaction, sessions);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
	sessions.onVoiceStateUpdate(oldState, newState);
});

process.on('unhandledRejection', error => {
	console.error('[unhandledRejection]', error);
});

await client.login(config.token);
