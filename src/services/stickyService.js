import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import { getStickyKey } from '../utils/database/keys.js';
import { createEmbed } from '../utils/embeds.js';

/**
 * Sticky notes: a message the bot keeps as the most recent message in a channel.
 *
 * Design notes (why it is built this way):
 * - One document per guild (`guild:<id>:sticky`) holding every channel's sticky, cached in memory,
 *   so the hot path (every incoming message) is a single Map lookup and never touches the database.
 * - Reposts are debounced (with a max-wait cap so busy chats still get a repost) and serialized per
 *   channel with a mutex, so bursts of messages can never create duplicate stickies.
 * - The new sticky is SENT before the old one is deleted, so a failed send never leaves a channel
 *   without its sticky.
 * - Config writes are serialized per guild and always go through `mutateGuild`.
 * - Lock order is always: post lock (`sticky-post:<channel>`) -> store lock (`sticky-store:<guild>`).
 *   Store-lock holders never take a post lock, so the two cannot deadlock.
 * - Mentions in sticky text never ping (`allowedMentions.parse = []`).
 */

export const STICKY_LIMITS = Object.freeze({
  maxPerGuild: 25,
  maxEmbedContent: 4000,
  maxTextContent: 1900,
  maxTitle: 100,
  minDelaySec: 2,
  maxDelaySec: 60,
  defaultDelaySec: 5,
  minEvery: 1,
  maxEvery: 50,
  defaultEvery: 1,
  historySize: 5,
});

const MAX_WAIT_MS = 30_000;
const NEGATIVE_CACHE_MS = 15_000;
const PERMISSION_WARN_INTERVAL_MS = 10 * 60_000;
const MAX_FAILURE_BACKOFF_MS = 10 * 60_000;
const OWN_ID_MEMORY = 10;

const STICKY_CHANNEL_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

const DISCORD_UNKNOWN_CHANNEL = 10003;
const DISCORD_UNKNOWN_MESSAGE = 10008;
const DISCORD_MISSING_ACCESS = 50001;
const DISCORD_MISSING_PERMISSIONS = 50013;

export class StickyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StickyError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Normalisation / validation
// ---------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function normalizeColor(value) {
  if (value === null || value === undefined || value === '') return null;
  const match = String(value).trim().match(/^(?:#|0x)?([0-9a-fA-F]{6})$/);
  return match ? `#${match[1].toUpperCase()}` : null;
}

function isHistoryEntry(entry) {
  return entry && typeof entry === 'object' && typeof entry.content === 'string' && entry.content.length > 0;
}

function normalizeSticky(raw, channelId) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.content !== 'string' || raw.content.trim().length === 0) return null;

  return {
    channelId,
    content: raw.content,
    title: typeof raw.title === 'string' ? raw.title.slice(0, STICKY_LIMITS.maxTitle) : '',
    style: raw.style === 'text' ? 'text' : 'embed',
    color: normalizeColor(raw.color),
    enabled: raw.enabled !== false,
    delaySec: clampInt(raw.delaySec, STICKY_LIMITS.minDelaySec, STICKY_LIMITS.maxDelaySec, STICKY_LIMITS.defaultDelaySec),
    everyN: clampInt(raw.everyN, STICKY_LIMITS.minEvery, STICKY_LIMITS.maxEvery, STICKY_LIMITS.defaultEvery),
    lastMessageId: typeof raw.lastMessageId === 'string' && raw.lastMessageId ? raw.lastMessageId : null,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : null,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : null,
    history: Array.isArray(raw.history)
      ? raw.history.filter(isHistoryEntry).slice(0, STICKY_LIMITS.historySize)
      : [],
  };
}

function normalizeGuildDoc(raw) {
  const doc = { version: 1, stickies: {} };
  if (!raw || typeof raw !== 'object' || !raw.stickies || typeof raw.stickies !== 'object') {
    return doc;
  }
  for (const [channelId, value] of Object.entries(raw.stickies)) {
    const sticky = normalizeSticky(value, channelId);
    if (sticky) doc.stickies[channelId] = sticky;
  }
  return doc;
}

/**
 * Validates and normalises user-supplied sticky fields. Throws StickyError on bad input.
 * Only keys present in `input` are returned so callers can use it for partial updates.
 */
export function validateStickyInput(input, { requireContent = false, styleForLengthCheck = 'embed' } = {}) {
  const out = {};

  if (input.style !== undefined && input.style !== null) {
    if (input.style !== 'text' && input.style !== 'embed') {
      throw new StickyError('VALIDATION', 'Style must be either **text** or **embed**.');
    }
    out.style = input.style;
  }

  if (input.title !== undefined && input.title !== null) {
    const title = String(input.title).trim();
    if (title.length > STICKY_LIMITS.maxTitle) {
      throw new StickyError('VALIDATION', `Title can be at most ${STICKY_LIMITS.maxTitle} characters.`);
    }
    out.title = title;
  }

  if (input.content !== undefined && input.content !== null) {
    const content = String(input.content).replace(/\r\n/g, '\n').trim();
    if (content.length === 0) {
      throw new StickyError('VALIDATION', 'The sticky message cannot be empty.');
    }
    out.content = content;
  } else if (requireContent) {
    throw new StickyError('VALIDATION', 'The sticky message cannot be empty.');
  }

  if (input.color !== undefined && input.color !== null && input.color !== '') {
    const color = normalizeColor(input.color);
    if (!color) {
      throw new StickyError('VALIDATION', 'Color must be a hex code like `#FFAA00`.');
    }
    out.color = color;
  }

  if (input.delaySec !== undefined && input.delaySec !== null) {
    const n = Number(input.delaySec);
    if (!Number.isInteger(n) || n < STICKY_LIMITS.minDelaySec || n > STICKY_LIMITS.maxDelaySec) {
      throw new StickyError(
        'VALIDATION',
        `Delay must be a whole number between ${STICKY_LIMITS.minDelaySec} and ${STICKY_LIMITS.maxDelaySec} seconds.`,
      );
    }
    out.delaySec = n;
  }

  if (input.everyN !== undefined && input.everyN !== null) {
    const n = Number(input.everyN);
    if (!Number.isInteger(n) || n < STICKY_LIMITS.minEvery || n > STICKY_LIMITS.maxEvery) {
      throw new StickyError(
        'VALIDATION',
        `"Every" must be a whole number between ${STICKY_LIMITS.minEvery} and ${STICKY_LIMITS.maxEvery} messages.`,
      );
    }
    out.everyN = n;
  }

  const style = out.style ?? styleForLengthCheck;
  if (out.content !== undefined) {
    if (style === 'text') {
      const total = out.content.length + (out.title ? out.title.length + 8 : 0);
      if (total > STICKY_LIMITS.maxTextContent) {
        throw new StickyError(
          'VALIDATION',
          `Text stickies can be at most ${STICKY_LIMITS.maxTextContent} characters (including the title). Use the embed style for longer notes.`,
        );
      }
    } else if (out.content.length > STICKY_LIMITS.maxEmbedContent) {
      throw new StickyError('VALIDATION', `Embed stickies can be at most ${STICKY_LIMITS.maxEmbedContent} characters.`);
    }
  }

  return out;
}

export function isStickyChannel(channel) {
  return Boolean(channel) && STICKY_CHANNEL_TYPES.has(channel.type);
}

// ---------------------------------------------------------------------------
// Storage (cached per guild)
// ---------------------------------------------------------------------------

const guildCache = new Map(); // guildId -> { data, ok, loadedAt }
const inflightLoads = new Map(); // guildId -> Promise<data>

function peekGuild(guildId) {
  const cached = guildCache.get(guildId);
  if (!cached) return undefined;
  if (cached.ok || Date.now() - cached.loadedAt < NEGATIVE_CACHE_MS) return cached.data;
  return undefined;
}

async function loadGuild(client, guildId) {
  const cached = peekGuild(guildId);
  if (cached) return cached;

  const existing = inflightLoads.get(guildId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const raw = await client.db.get(getStickyKey(guildId), null);
      const data = normalizeGuildDoc(raw);
      guildCache.set(guildId, { data, ok: true, loadedAt: Date.now() });
      return data;
    } catch (error) {
      logger.error('Failed to load sticky notes', { guildId, error });
      // Negative-cache an empty doc briefly so a DB outage doesn't turn every message into a DB call.
      // `ok: false` also guarantees this empty doc is never used as the base for a write.
      const empty = normalizeGuildDoc(null);
      guildCache.set(guildId, { data: empty, ok: false, loadedAt: Date.now() });
      return empty;
    } finally {
      inflightLoads.delete(guildId);
    }
  })();

  inflightLoads.set(guildId, promise);
  return promise;
}

async function loadForWrite(client, guildId) {
  const cached = guildCache.get(guildId);
  if (cached?.ok) return cached.data;

  try {
    const raw = await client.db.get(getStickyKey(guildId), null);
    return normalizeGuildDoc(raw);
  } catch (error) {
    logger.error('Failed to read sticky notes before writing', { guildId, error });
    throw new StickyError('DATABASE', 'Could not reach the database. Please try again in a moment.');
  }
}

/**
 * Runs `mutator(draft, ctx)` against a copy of the guild document under the guild's store lock,
 * persists the copy and swaps it into the cache. Set `ctx.skipWrite = true` to abort without saving.
 */
async function mutateGuild(client, guildId, mutator) {
  return Mutex.runExclusive(`sticky-store:${guildId}`, async () => {
    const base = await loadForWrite(client, guildId);
    const draft = structuredClone(base);
    const ctx = { skipWrite: false };
    const result = await mutator(draft, ctx);

    if (ctx.skipWrite) return result;

    let saved;
    try {
      saved = await client.db.set(getStickyKey(guildId), draft);
    } catch (error) {
      logger.error('Failed to save sticky notes', { guildId, error });
      throw new StickyError('DATABASE', 'Could not save the sticky note. Please try again.');
    }
    if (saved === false) {
      throw new StickyError('DATABASE', 'Could not save the sticky note. Please try again.');
    }

    guildCache.set(guildId, { data: draft, ok: true, loadedAt: Date.now() });
    return result;
  });
}

export async function getSticky(client, guildId, channelId) {
  const data = await loadGuild(client, guildId);
  return data.stickies[channelId] ?? null;
}

export async function listStickies(client, guildId) {
  const data = await loadGuild(client, guildId);
  return Object.values(data.stickies).sort((a, b) => a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------------------
// Runtime state (never persisted)
// ---------------------------------------------------------------------------

const channelState = new Map();

function getState(channelId) {
  let state = channelState.get(channelId);
  if (!state) {
    state = {
      timer: null,
      pending: 0,
      firstPendingAt: 0,
      busy: false,
      rerun: false,
      lastMessageId: null, // in-memory fallback if persisting the id fails
      ownIds: [],
      failures: 0,
      blockedUntil: 0,
      lastPermissionWarnAt: 0,
    };
    channelState.set(channelId, state);
  }
  return state;
}

function rememberOwnId(state, id) {
  state.ownIds.push(id);
  if (state.ownIds.length > OWN_ID_MEMORY) state.ownIds.shift();
}

function clearChannelTimer(state) {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.pending = 0;
  state.firstPendingAt = 0;
}

export function clearChannelState(channelId) {
  const state = channelState.get(channelId);
  if (state) clearChannelTimer(state);
  channelState.delete(channelId);
}

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------

export function buildStickyPayload(sticky) {
  const allowedMentions = { parse: [] };

  if (sticky.style === 'text') {
    const header = sticky.title ? `📌 **${sticky.title}**\n` : '';
    return {
      content: `${header}${sticky.content}`.slice(0, 2000),
      embeds: [],
      allowedMentions,
    };
  }

  const embed = createEmbed({
    title: sticky.title || '📌 Sticky Note',
    description: sticky.content,
    color: sticky.color || 'primary',
  });
  return { content: '', embeds: [embed], allowedMentions };
}

// ---------------------------------------------------------------------------
// Discord helpers
// ---------------------------------------------------------------------------

async function resolveChannel(client, guildId, channelId) {
  let channel = client.channels.cache.get(channelId);

  if (!channel) {
    try {
      channel = await client.channels.fetch(channelId);
    } catch (error) {
      if (error?.code === DISCORD_UNKNOWN_CHANNEL) return { channel: null, missing: true };
      if (error?.code === DISCORD_MISSING_ACCESS) return { channel: null, missing: false, noAccess: true };
      throw error;
    }
  }

  if (!channel || channel.guildId !== guildId || !isStickyChannel(channel)) {
    return { channel: null, missing: true };
  }
  return { channel, missing: false };
}

function missingPostingPermissions(channel, sticky) {
  const me = channel.guild?.members?.me;
  if (!me) return [];

  const perms = channel.permissionsFor(me);
  if (!perms) return ['View Channel'];

  const required = [
    [PermissionFlagsBits.ViewChannel, 'View Channel'],
    [PermissionFlagsBits.SendMessages, 'Send Messages'],
  ];
  if (sticky.style === 'embed') {
    required.push([PermissionFlagsBits.EmbedLinks, 'Embed Links']);
  }
  return required.filter(([flag]) => !perms.has(flag)).map(([, name]) => name);
}

async function deleteMessageQuietly(channel, messageId) {
  if (!messageId) return;
  try {
    await channel.messages.delete(messageId);
  } catch (error) {
    if (error?.code === DISCORD_UNKNOWN_MESSAGE) return;
    logger.debug('Could not delete old sticky message', { channelId: channel.id, messageId, error: error?.message });
  }
}

// ---------------------------------------------------------------------------
// Reposting
// ---------------------------------------------------------------------------

async function persistLastMessageId(client, guildId, channelId, messageId) {
  await mutateGuild(client, guildId, (draft, ctx) => {
    const sticky = draft.stickies[channelId];
    if (!sticky || sticky.lastMessageId === messageId) {
      ctx.skipWrite = true;
      return;
    }
    sticky.lastMessageId = messageId;
  });
}

/**
 * Makes sure the channel's sticky is posted as the latest message.
 * `force` re-posts even when the sticky already is the latest message (used after edits / manual refresh).
 * Never throws; returns `{ posted, reason }`.
 */
export async function repostSticky(client, guildId, channelId, { force = false } = {}) {
  try {
    return await Mutex.runExclusive(`sticky-post:${channelId}`, () =>
      repostLocked(client, guildId, channelId, force),
    );
  } catch (error) {
    logger.error('Unexpected error while reposting sticky', { guildId, channelId, error });
    return { posted: false, reason: 'error' };
  }
}

async function repostLocked(client, guildId, channelId, force) {
  const state = getState(channelId);
  state.busy = true;

  try {
    const data = await loadGuild(client, guildId);
    const sticky = data.stickies[channelId];
    if (!sticky || !sticky.enabled) return { posted: false, reason: 'inactive' };

    const resolved = await resolveChannel(client, guildId, channelId);
    if (resolved.missing) {
      logger.info('Sticky channel no longer exists, removing sticky', { guildId, channelId });
      await removeStickyConfigOnly(client, guildId, channelId);
      return { posted: false, reason: 'channel_missing' };
    }
    const channel = resolved.channel;
    if (!channel) return { posted: false, reason: 'no_access' };

    const missing = missingPostingPermissions(channel, sticky);
    if (missing.length > 0) {
      warnMissingPermissions(state, guildId, channelId, missing);
      return { posted: false, reason: 'permissions', missing };
    }

    const knownId = state.lastMessageId || sticky.lastMessageId;
    const isLatest = Boolean(knownId) && channel.lastMessageId === knownId;

    if (isLatest && !force) return { posted: false, reason: 'already_latest' };

    const payload = buildStickyPayload(sticky);

    // Nothing was posted after the sticky: update it in place (no flicker, keeps its position).
    if (isLatest && force) {
      try {
        await channel.messages.edit(knownId, payload);
        state.failures = 0;
        return { posted: true, reason: 'edited', messageId: knownId };
      } catch (error) {
        if (error?.code !== DISCORD_UNKNOWN_MESSAGE) {
          logger.debug('In-place sticky edit failed, reposting instead', { channelId, error: error?.message });
        }
      }
    }

    let sent;
    try {
      sent = await channel.send(payload);
    } catch (error) {
      return handleSendFailure(client, state, guildId, channelId, error);
    }

    state.failures = 0;
    state.blockedUntil = 0;
    rememberOwnId(state, sent.id);

    const staleIds = new Set([sticky.lastMessageId, state.lastMessageId].filter(Boolean));
    state.lastMessageId = sent.id;

    try {
      await persistLastMessageId(client, guildId, channelId, sent.id);
    } catch (error) {
      // The in-memory id keeps cleanup correct until the next successful save.
      logger.warn('Could not persist sticky message id', { guildId, channelId, error: error?.message });
    }

    for (const id of staleIds) {
      if (id !== sent.id) await deleteMessageQuietly(channel, id);
    }

    return { posted: true, reason: 'posted', messageId: sent.id };
  } finally {
    state.busy = false;
    if (state.rerun) {
      state.rerun = false;
      scheduleRepost(client, guildId, channelId, STICKY_LIMITS.defaultDelaySec * 1000);
    }
  }
}

function warnMissingPermissions(state, guildId, channelId, missing) {
  const now = Date.now();
  if (now - state.lastPermissionWarnAt < PERMISSION_WARN_INTERVAL_MS) return;
  state.lastPermissionWarnAt = now;
  logger.warn('Cannot post sticky: missing permissions', { guildId, channelId, missing });
}

async function handleSendFailure(client, state, guildId, channelId, error) {
  if (error?.code === DISCORD_UNKNOWN_CHANNEL) {
    await removeStickyConfigOnly(client, guildId, channelId).catch(() => {});
    return { posted: false, reason: 'channel_missing' };
  }

  if (error?.code === DISCORD_MISSING_ACCESS || error?.code === DISCORD_MISSING_PERMISSIONS) {
    warnMissingPermissions(state, guildId, channelId, ['Send Messages / Embed Links']);
    return { posted: false, reason: 'permissions' };
  }

  state.failures += 1;
  state.blockedUntil = Date.now() + Math.min(MAX_FAILURE_BACKOFF_MS, 30_000 * 2 ** Math.min(state.failures, 5));
  logger.error('Failed to post sticky', { guildId, channelId, failures: state.failures, error });
  return { posted: false, reason: 'send_failed' };
}

function scheduleRepost(client, guildId, channelId, delayMs) {
  const state = getState(channelId);
  const now = Date.now();

  if (state.busy) {
    state.rerun = true;
    return;
  }

  if (!state.firstPendingAt) state.firstPendingAt = now;
  const fireAt = Math.min(now + delayMs, state.firstPendingAt + MAX_WAIT_MS);

  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    state.pending = 0;
    state.firstPendingAt = 0;
    repostSticky(client, guildId, channelId).catch(() => {});
  }, Math.max(0, fireAt - now));
  state.timer.unref?.();
}

// ---------------------------------------------------------------------------
// Event hooks (called from the event files)
// ---------------------------------------------------------------------------

/** Hot path: called for every guild message. Must stay cheap and must never throw. */
export function notifyStickyMessage(message, client) {
  try {
    const guildId = message.guildId;
    if (!guildId || !message.channelId) return;

    const data = peekGuild(guildId);
    if (data) {
      handleMessageWithData(message, client, data);
      return;
    }

    loadGuild(client, guildId)
      .then((loaded) => handleMessageWithData(message, client, loaded))
      .catch((error) => logger.debug('Sticky notify failed', { error: error?.message }));
  } catch (error) {
    logger.debug('Sticky notify failed', { error: error?.message });
  }
}

function handleMessageWithData(message, client, data) {
  const sticky = data.stickies[message.channelId];
  if (!sticky || !sticky.enabled) return;

  const state = getState(message.channelId);

  // Ignore the sticky itself (the bot's own post), but still react to the bot's other messages
  // (e.g. slash command replies) since they push the sticky up.
  if (message.author?.id === client.user?.id) {
    if (state.busy) return;
    if (message.id === sticky.lastMessageId || message.id === state.lastMessageId) return;
    if (state.ownIds.includes(message.id)) return;
  }

  if (Date.now() < state.blockedUntil) return;

  state.pending += 1;
  if (state.pending < sticky.everyN) return;

  scheduleRepost(client, message.guildId, message.channelId, sticky.delaySec * 1000);
}

/** The live sticky message was deleted (by a moderator, purge, etc). Bring it back. */
export async function handleStickyMessageDeleted(message, client) {
  try {
    const guildId = message.guildId;
    if (!guildId) return;

    const data = await loadGuild(client, guildId);
    const sticky = data.stickies[message.channelId];
    if (!sticky) return;

    const state = getState(message.channelId);
    const isLive = message.id === sticky.lastMessageId || message.id === state.lastMessageId;
    if (!isLive) return; // e.g. the old sticky we deleted ourselves

    state.lastMessageId = null;
    await mutateGuild(client, guildId, (draft, ctx) => {
      const current = draft.stickies[message.channelId];
      if (!current || current.lastMessageId !== message.id) {
        ctx.skipWrite = true;
        return;
      }
      current.lastMessageId = null;
    }).catch((error) => logger.debug('Could not clear deleted sticky id', { error: error?.message }));

    if (sticky.enabled) {
      scheduleRepost(client, guildId, message.channelId, sticky.delaySec * 1000);
    }
  } catch (error) {
    logger.error('Error handling deleted sticky message', { error });
  }
}

export async function handleStickyBulkDelete(messages, channel, client) {
  try {
    const guildId = channel?.guildId;
    if (!guildId) return;
    const data = await loadGuild(client, guildId);
    const sticky = data.stickies[channel.id];
    if (!sticky) return;

    const state = getState(channel.id);
    const ids = new Set(messages.keys());
    const hit = ids.has(sticky.lastMessageId) || (state.lastMessageId && ids.has(state.lastMessageId));
    if (hit) {
      await handleStickyMessageDeleted(
        { id: sticky.lastMessageId ?? state.lastMessageId, guildId, channelId: channel.id },
        client,
      );
    }
  } catch (error) {
    logger.error('Error handling bulk delete for sticky', { error });
  }
}

export async function handleStickyChannelDeleted(channel, client) {
  try {
    const guildId = channel?.guildId;
    if (!guildId || !isStickyChannel(channel)) return;
    const data = await loadGuild(client, guildId);
    if (!data.stickies[channel.id]) return;
    await removeStickyConfigOnly(client, guildId, channel.id);
    logger.info('Removed sticky for deleted channel', { guildId, channelId: channel.id });
  } catch (error) {
    logger.error('Error cleaning up sticky for deleted channel', { error });
  }
}

// ---------------------------------------------------------------------------
// Management API (used by /sticky)
// ---------------------------------------------------------------------------

function pushHistory(sticky, editedBy) {
  sticky.history.unshift({
    title: sticky.title,
    content: sticky.content,
    style: sticky.style,
    color: sticky.color,
    editedBy: editedBy ?? null,
    at: Date.now(),
  });
  sticky.history = sticky.history.slice(0, STICKY_LIMITS.historySize);
}

async function removeStickyConfigOnly(client, guildId, channelId) {
  clearChannelState(channelId);
  return mutateGuild(client, guildId, (draft, ctx) => {
    if (!draft.stickies[channelId]) {
      ctx.skipWrite = true;
      return null;
    }
    const removed = draft.stickies[channelId];
    delete draft.stickies[channelId];
    return removed;
  });
}

/** Creates a sticky for a channel, or replaces the existing one (keeping history). */
export async function setSticky(client, guildId, channelId, input, userId) {
  const sticky = await mutateGuild(client, guildId, (draft) => {
    const existing = draft.stickies[channelId];
    if (!existing && Object.keys(draft.stickies).length >= STICKY_LIMITS.maxPerGuild) {
      throw new StickyError('LIMIT', `This server already has ${STICKY_LIMITS.maxPerGuild} sticky notes. Remove one first.`);
    }

    // Validate against the style that will actually be used (an existing text sticky stays text).
    const fields = validateStickyInput(input, {
      requireContent: true,
      styleForLengthCheck: input.style ?? existing?.style ?? 'embed',
    });

    const now = Date.now();
    if (existing) pushHistory(existing, userId);

    draft.stickies[channelId] = normalizeSticky(
      {
        ...(existing ?? {}),
        title: fields.title ?? '',
        content: fields.content,
        style: fields.style ?? existing?.style ?? 'embed',
        color: fields.color ?? existing?.color ?? null,
        delaySec: fields.delaySec ?? existing?.delaySec,
        everyN: fields.everyN ?? existing?.everyN,
        enabled: true,
        createdBy: existing?.createdBy ?? userId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        updatedBy: userId,
        history: existing?.history ?? [],
      },
      channelId,
    );
    return draft.stickies[channelId];
  });

  const result = await repostSticky(client, guildId, channelId, { force: true });
  return { sticky, result };
}

/** Changes the text/title of an existing sticky (previous version goes to history). */
export async function editSticky(client, guildId, channelId, input, userId) {
  const sticky = await mutateGuild(client, guildId, (draft) => {
    const existing = draft.stickies[channelId];
    if (!existing) throw new StickyError('NOT_FOUND', 'There is no sticky note in that channel.');

    const fields = validateStickyInput(input, { requireContent: true, styleForLengthCheck: existing.style });
    pushHistory(existing, userId);
    existing.content = fields.content;
    if (fields.title !== undefined) existing.title = fields.title;
    existing.updatedAt = Date.now();
    existing.updatedBy = userId;
    return existing;
  });

  const result = await repostSticky(client, guildId, channelId, { force: true });
  return { sticky, result };
}

/** Updates style / color / delay / "every N messages" without touching the text. */
export async function updateStickySettings(client, guildId, channelId, input, userId) {
  const sticky = await mutateGuild(client, guildId, (draft) => {
    const existing = draft.stickies[channelId];
    if (!existing) throw new StickyError('NOT_FOUND', 'There is no sticky note in that channel.');

    const fields = validateStickyInput(
      { style: input.style, color: input.color, delaySec: input.delaySec, everyN: input.everyN },
      { styleForLengthCheck: existing.style },
    );

    const nextStyle = fields.style ?? existing.style;
    if (nextStyle === 'text') {
      const total = existing.content.length + (existing.title ? existing.title.length + 8 : 0);
      if (total > STICKY_LIMITS.maxTextContent) {
        throw new StickyError('VALIDATION', `This note is too long for the text style (max ${STICKY_LIMITS.maxTextContent} characters).`);
      }
    }

    Object.assign(existing, fields);
    existing.updatedAt = Date.now();
    existing.updatedBy = userId;
    return existing;
  });

  const result = await repostSticky(client, guildId, channelId, { force: true });
  return { sticky, result };
}

/** Pauses (deletes the live message, stops reposting) or resumes (reposts right away). */
export async function setStickyEnabled(client, guildId, channelId, enabled, userId) {
  return Mutex.runExclusive(`sticky-post:${channelId}`, async () => {
    const state = getState(channelId);
    let liveIds = [];

    const sticky = await mutateGuild(client, guildId, (draft) => {
      const existing = draft.stickies[channelId];
      if (!existing) throw new StickyError('NOT_FOUND', 'There is no sticky note in that channel.');

      existing.enabled = enabled;
      existing.updatedAt = Date.now();
      existing.updatedBy = userId;

      if (!enabled) {
        liveIds = [existing.lastMessageId, state.lastMessageId].filter(Boolean);
        existing.lastMessageId = null;
      }
      return existing;
    });

    if (!enabled) {
      clearChannelTimer(state);
      state.lastMessageId = null;
      const resolved = await resolveChannel(client, guildId, channelId).catch(() => ({ channel: null }));
      if (resolved.channel) {
        for (const id of new Set(liveIds)) await deleteMessageQuietly(resolved.channel, id);
      }
    }
    return sticky;
  }).then(async (sticky) => {
    if (enabled) {
      const result = await repostSticky(client, guildId, channelId, { force: true });
      return { sticky, result };
    }
    return { sticky, result: { posted: false, reason: 'paused' } };
  });
}

/** Removes a sticky entirely and deletes its live message. Returns the removed sticky or null. */
export async function removeSticky(client, guildId, channelId) {
  return Mutex.runExclusive(`sticky-post:${channelId}`, async () => {
    const state = getState(channelId);
    const extraId = state.lastMessageId;
    const removed = await removeStickyConfigOnly(client, guildId, channelId);
    if (!removed) return null;

    const resolved = await resolveChannel(client, guildId, channelId).catch(() => ({ channel: null }));
    if (resolved.channel) {
      for (const id of new Set([removed.lastMessageId, extraId].filter(Boolean))) {
        await deleteMessageQuietly(resolved.channel, id);
      }
    }
    return removed;
  });
}

/** Restores one of the saved previous versions (1 = most recent). The current text is saved to history. */
export async function restoreStickyVersion(client, guildId, channelId, version, userId) {
  const sticky = await mutateGuild(client, guildId, (draft) => {
    const existing = draft.stickies[channelId];
    if (!existing) throw new StickyError('NOT_FOUND', 'There is no sticky note in that channel.');

    const entry = existing.history[version - 1];
    if (!entry) throw new StickyError('NOT_FOUND', `There is no saved version #${version}.`);

    const snapshot = { ...entry };
    pushHistory(existing, userId);
    existing.title = snapshot.title ?? '';
    existing.content = snapshot.content;
    existing.style = snapshot.style === 'text' ? 'text' : 'embed';
    existing.color = normalizeColor(snapshot.color);
    existing.updatedAt = Date.now();
    existing.updatedBy = userId;
    return existing;
  });

  const result = await repostSticky(client, guildId, channelId, { force: true });
  return { sticky, result };
}

// ---------------------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------------------

/**
 * Runs once on startup: drops stickies whose channel is gone and re-posts stickies that were
 * buried or deleted while the bot was offline. Sequential and light on API calls.
 */
export async function reconcileStickies(client) {
  const summary = { scannedGuilds: 0, stickies: 0, removed: 0, reposted: 0, errors: 0 };

  for (const guild of client.guilds.cache.values()) {
    try {
      // During a Discord outage the guild's channel cache can be empty; never prune in that state.
      if (!guild.available) continue;

      const data = await loadGuild(client, guild.id);
      const entries = Object.values(data.stickies);
      if (entries.length === 0) continue;

      summary.scannedGuilds += 1;

      for (const sticky of entries) {
        summary.stickies += 1;
        try {
          // resolveChannel only reports "missing" for a definite Unknown Channel / wrong-type answer.
          const resolved = await resolveChannel(client, guild.id, sticky.channelId);
          if (resolved.missing) {
            await removeStickyConfigOnly(client, guild.id, sticky.channelId);
            summary.removed += 1;
            continue;
          }
          const channel = resolved.channel;
          if (!channel || !sticky.enabled) continue;

          let needsRepost = !sticky.lastMessageId || channel.lastMessageId !== sticky.lastMessageId;

          if (!needsRepost) {
            // Discord keeps last_message_id even if that message was deleted while we were offline.
            try {
              await channel.messages.fetch(sticky.lastMessageId);
            } catch (error) {
              if (error?.code === DISCORD_UNKNOWN_MESSAGE) needsRepost = true;
            }
          }

          if (needsRepost) {
            const result = await repostSticky(client, guild.id, sticky.channelId);
            if (result.posted) summary.reposted += 1;
          }
        } catch (error) {
          summary.errors += 1;
          logger.warn('Sticky reconcile failed for channel', { guildId: guild.id, channelId: sticky.channelId, error: error?.message });
        }
      }
    } catch (error) {
      summary.errors += 1;
      logger.warn('Sticky reconcile failed for guild', { guildId: guild.id, error: error?.message });
    }
  }

  return summary;
}
