import { logger } from '../utils/logger.js';

export const MIN_SECONDS = 10;
export const MAX_SECONDS = 120;
export const DEFAULT_SECONDS = 30;
export const CLAIM_BUTTON_ID = 'riskclaim'; // no ":" so TitanBot's main button handler ignores it

const KEY_PREFIX = 'riskClaim:';

// guildId -> config object, or null when not set up
const cache = new Map();

const keyFor = (guildId) => `${KEY_PREFIX}${guildId}`;

export async function getRiskConfig(client, guildId) {
  if (cache.has(guildId)) return cache.get(guildId);

  try {
    const raw = await client.db.get(keyFor(guildId));
    const valid =
      raw &&
      typeof raw === 'object' &&
      raw.enabled !== false &&
      raw.spawnChannelId &&
      raw.caughtChannelId;

    const config = valid ? { seconds: DEFAULT_SECONDS, ...raw } : null;
    cache.set(guildId, config);
    return config;
  } catch (error) {
    logger.error('Failed to load risk claim config:', { guildId, error });
    return null;
  }
}

export async function saveRiskConfig(client, guildId, { spawnChannelId, caughtChannelId, seconds }) {
  const config = { enabled: true, spawnChannelId, caughtChannelId, seconds };
  await client.db.set(keyFor(guildId), config);
  cache.set(guildId, config);
  return config;
}

export async function disableRisk(client, guildId) {
  await client.db.set(keyFor(guildId), { enabled: false });
  cache.set(guildId, null);
}

export function getImageAttachments(message) {
  return [...message.attachments.values()].filter(
    (a) => a.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name ?? '')
  );
}

function isClaimRelated(message, client) {
  if (message.author.id === client.user.id) {
    return (message.components?.length ?? 0) > 0; // leftover claim message with a dead button
  }
  return getImageAttachments(message).length > 0;
}

// Claim timers are lost on restart, so clear out anything left behind in the
// spawn channel (images and their dead claim buttons) once its time is up.
export async function cleanupAfterRestart(client) {
  for (const guild of client.guilds.cache.values()) {
    const config = await getRiskConfig(client, guild.id);
    if (!config) continue;

    try {
      const channel = await client.channels.fetch(config.spawnChannelId);
      if (!channel?.messages) continue;

      const messages = await channel.messages.fetch({ limit: 100 });
      for (const msg of messages.values()) {
        if (msg.pinned || !isClaimRelated(msg, client)) continue;

        const age = Date.now() - msg.createdTimestamp;
        const remaining = Math.max(0, config.seconds * 1000 - age);
        setTimeout(() => msg.delete().catch(() => {}), remaining);
      }
    } catch (error) {
      logger.warn(`Risk cleanup failed for guild ${guild.id}: ${error.message}`);
    }
  }
}
