import {Client, Events, GatewayIntentBits, MessageFlags, type Guild} from 'discord.js';
import {commandData, handleInteraction} from './commands.js';
import {config} from './config.js';
import {SessionManager} from './session-manager.js';

const tokens = [config.token, ...config.workerTokens];
const clients = tokens.map(() => new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
}));
const primary = clients[0];
let sessions: SessionManager | undefined;
let ready = false;
let stopping = false;
let shutdownPromise: Promise<void> | undefined;

function isGuildAllowed(guildId: string): boolean {
	return config.allowedGuildIds.length === 0 || config.allowedGuildIds.includes(guildId);
}

async function prepareGuild(client: Client, guild: Guild): Promise<void> {
	if (!isGuildAllowed(guild.id)) {
		console.warn(`[bot:${client.user?.id}] Leaving disallowed guild ${guild.id}.`);
		await guild.leave().catch(() => console.error(`[bot:${client.user?.id}] Could not leave disallowed guild ${guild.id}.`));
		return;
	}

	if (client === primary) {
		await guild.commands.set(commandData).catch(() => {
			console.error(`[commands:${guild.id}] Registration failed. Check the primary bot's server access and applications.commands authorization.`);
		});
	}
}

for (const [index, client] of clients.entries()) {
	client.on(Events.GuildCreate, guild => {
		void prepareGuild(client, guild);
	});
	client.on(Events.VoiceStateUpdate, (oldState, newState) => {
		sessions?.onVoiceStateUpdate(client, oldState, newState);
	});
	client.on(Events.Error, () => {
		console.error(`[bot:${index === 0 ? 'primary' : `worker-${index}`}] Discord client error. Check connectivity and the bot configuration.`);
	});
}

primary.on(Events.InteractionCreate, interaction => {
	if (ready && sessions) {
		void handleInteraction(interaction, sessions);
	} else if (interaction.isChatInputCommand() && interaction.commandName === 'scribe') {
		void interaction.reply({content: 'Scribe is starting or stopping. Try again shortly.', flags: MessageFlags.Ephemeral}).catch(() => undefined);
	}
});

/** login() may resolve before ClientReady, so wait for both with a bounded deadline. */
async function loginClient(client: Client, token: string): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	let onReady: (() => void) | undefined;
	const readyPromise = new Promise<void>((resolve, reject) => {
		onReady = () => resolve();
		client.once(Events.ClientReady, onReady);
		timer = setTimeout(() => reject(new Error('Discord login timed out.')), 45_000);
	});
	try {
		await Promise.all([client.login(token), readyPromise]);
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
			console.error('[shutdown] Could not finish every session cleanly. Saved assignments remain available for restart.');
		} finally {
			await Promise.allSettled(clients.map(client => client.destroy()));
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
	const results = await Promise.allSettled(clients.map((client, index) => loginClient(client, tokens[index])));
	if (stopping) return;
	if (results[0].status === 'rejected') {
		throw new Error('Primary bot login failed. Check DISCORD_TOKEN, network access, and enabled gateway intents.');
	}

	const usable: Client[] = [];
	const identities = new Set<string>();
	for (const [index, result] of results.entries()) {
		const client = clients[index];
		if (result.status === 'rejected' || !client.user) {
			console.error(`[worker-${index}] Login failed. Check entry ${index} in DISCORD_WORKER_TOKENS, network access, and gateway intents. Other bots will continue.`);
			await client.destroy();
			continue;
		}

		if (identities.has(client.user.id)) {
			console.error(`[worker-${index}] Duplicate bot account ${client.user.id}. Each worker token must belong to a different bot. This duplicate worker is disabled.`);
			await client.destroy();
			continue;
		}

		identities.add(client.user.id);
		usable.push(client);
		console.log(`[bot:${index === 0 ? 'primary' : `worker-${index}`}] Logged in as ${client.user.tag}.`);
		for (const guild of client.guilds.cache.values()) {
			await prepareGuild(client, guild);
		}
	}

	if (stopping) return;
	sessions = new SessionManager(usable);
	await sessions.restore();
	if (stopping) return;
	ready = true;
	console.log(`Ready with ${usable.length}/${clients.length} configured bot accounts. Use /scribe status to see this server's capacity.`);
}

await start().catch(async error => {
	console.error('[startup]', error instanceof Error && error.message.startsWith('Primary bot login failed.')
		? error.message
		: 'Startup failed. Check the saved assignment file and bot configuration.');
	await shutdown();
	process.exitCode = 1;
});
