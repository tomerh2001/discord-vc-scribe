import {Client, Events, GatewayIntentBits, MessageFlags, type Guild} from 'discord.js';
import {commandData, handleInteraction} from './commands.js';
import {config} from './config.js';
import {SessionManager} from './session-manager.js';

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
let sessions: SessionManager | undefined;
let ready = false;
let stopping = false;
let shutdownPromise: Promise<void> | undefined;

function isGuildAllowed(guildId: string): boolean {
	return config.allowedGuildIds.length === 0 || config.allowedGuildIds.includes(guildId);
}

async function prepareGuild(guild: Guild): Promise<void> {
	if (!isGuildAllowed(guild.id)) {
		console.warn(`[bot] Leaving disallowed guild ${guild.id}.`);
		await guild.leave().catch(() => console.error(`[bot] Could not leave disallowed guild ${guild.id}.`));
		return;
	}

	await guild.commands.set(commandData).catch(() => {
		console.error(`[commands:${guild.id}] Registration failed. Check the bot's server access and applications.commands authorization.`);
	});
}

client.on(Events.GuildCreate, guild => {
	void prepareGuild(guild);
});
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
	sessions?.onVoiceStateUpdate(oldState, newState);
});
client.on(Events.Error, () => {
	console.error('[bot] Discord client error. Check connectivity and the bot configuration.');
});
client.on(Events.InteractionCreate, interaction => {
	if (ready && sessions) {
		void handleInteraction(interaction, sessions);
	} else if (interaction.isChatInputCommand() && interaction.commandName === 'scribe') {
		void interaction.reply({content: 'Scribe is starting or stopping. Try again shortly.', flags: MessageFlags.Ephemeral}).catch(() => undefined);
	}
});

/** login() may resolve before ClientReady, so wait for both with a bounded deadline. */
async function loginClient(): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	let onReady: (() => void) | undefined;
	const readyPromise = new Promise<void>((resolve, reject) => {
		onReady = () => resolve();
		client.once(Events.ClientReady, onReady);
		timer = setTimeout(() => reject(new Error('Discord login timed out.')), 45_000);
	});
	try {
		await Promise.all([client.login(config.token), readyPromise]);
	} catch {
		throw new Error('Bot login failed. Check DISCORD_TOKEN, network access, and enabled gateway intents.');
	} finally {
		clearTimeout(timer);
		if (onReady) client.off(Events.ClientReady, onReady);
	}
}

function shutdown(): Promise<void> {
	if (shutdownPromise) return shutdownPromise;
	stopping = true;
	ready = false;
	shutdownPromise = (async () => {
		const deadline = setTimeout(() => process.exit(1), 15_000);
		deadline.unref();
		try {
			await sessions?.stop();
		} catch {
			console.error('[shutdown] Could not finish every session cleanly. Saved mappings and follow settings remain available for restart.');
		} finally {
			await Promise.allSettled([client.destroy()]);
			clearTimeout(deadline);
		}
	})();
	return shutdownPromise;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => {
		console.log(`[shutdown] ${signal}: stopping transcription sessions.`);
		void shutdown().then(() => process.exit(0));
	});
}

process.on('unhandledRejection', () => {
	console.error('[unhandledRejection] An asynchronous operation failed. Check Discord and transcription-server connectivity.');
});

async function start(): Promise<void> {
	await loginClient();
	if (stopping) return;
	console.log(`[bot] Logged in as ${client.user!.tag}.`);
	for (const guild of client.guilds.cache.values()) {
		await prepareGuild(guild);
	}

	if (stopping) return;
	sessions = new SessionManager(client);
	await sessions.restore();
	if (stopping) return;
	ready = true;
	console.log('Ready. Watching saved voice-channel mappings; use /scribe status to see current calls and follow settings.');
}

await start().catch(async error => {
	console.error('[startup]', error instanceof Error && error.message.startsWith('Bot login failed.')
		? error.message
		: 'Startup failed. Check the saved mapping files and bot configuration.');
	await shutdown();
	process.exitCode = 1;
});
