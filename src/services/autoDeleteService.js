import { logger } from '../utils/logger.js';

export const MIN_SECONDS = 20;
export const MAX_SECONDS = 100;

const KEY_PREFIX = 'autoDelete:';

// guildId -> { [channelId]: seconds }
const cache = new Map();

const keyFor = (guildId) => `${KEY_PREFIX}${guildId}`;

export async function getAutoDeleteConfig(client, guildId) {
  if (cache.has(guildId)) return cache.get(guildId);

  try {
    const raw = await client.db.get(keyFor(guildId));
    const data = raw && typeof raw === 'object' ? { ...raw } : {};
    cache.set(guildId, data);
    return data;
  } catch (error) {
    logger.error('Failed to load auto-delete config:', { guildId, error });
    return {};
  }
}

async function saveConfig(client, guildId, data) {
  await client.db.set(keyFor(guildId), data);
  cache.set(guildId, data);
}

export async function setChannelDelay(client, guildId, channelId, seconds) {
  const current = await getAutoDeleteConfig(client, guildId);
  await saveConfig(client, guildId, { ...current, [channelId]: seconds });
}

export async function removeChannel(client, guildId, channelId) {
  const current = await getAutoDeleteConfig(client, guildId);
  if (!(channelId in current)) return false;

  const next = { ...current };
  delete next[channelId];
  await saveConfig(client, guildId, next);
  return true;
}

export function scheduleDelete(message, delayMs) {
  setTimeout(async () => {
    try {
      // Stop if auto-delete was turned off for this channel in the meantime
      const config = await getAutoDeleteConfig(message.client, message.guildId);
      if (!config[message.channelId]) return;

      const fresh = await message.channel.messages.fetch(message.id);
      if (fresh.pinned) return; // leave pinned messages alone
      await fresh.delete();
    } catch {
      // already deleted, missing permissions, etc. - ignore
    }
  }, Math.max(0, delayMs));
}

// Timers are lost when the bot restarts, so on startup we re-check the most
// recent messages in each auto-delete channel and delete / reschedule them.
export async function resumeAutoDelete(client) {
  for (const guild of client.guilds.cache.values()) {
    const config = await getAutoDeleteConfig(client, guild.id);

    for (const [channelId, seconds] of Object.entries(config)) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.messages) continue;

        const messages = await channel.messages.fetch({ limit: 100 });
        for (const msg of messages.values()) {
          if (msg.pinned) continue;
          const age = Date.now() - msg.createdTimestamp;
          scheduleDelete(msg, seconds * 1000 - age);
        }
      } catch (error) {
        logger.warn(`Auto-delete resume failed for channel ${channelId}: ${error.message}`);
      }
    }
  }
}
