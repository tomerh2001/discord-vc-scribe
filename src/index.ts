import {Client, Events, GatewayIntentBits} from 'discord.js';
import {commandData, handleInteraction} from './commands.js';
import {config} from './config.js';
import {SessionManager} from './session.js';

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const sessions = new SessionManager(client);

client.once(Events.ClientReady, async readyClient => {
	console.log(`Logged in as ${readyClient.user.tag}`);

	for (const guild of readyClient.guilds.cache.values()) {
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
