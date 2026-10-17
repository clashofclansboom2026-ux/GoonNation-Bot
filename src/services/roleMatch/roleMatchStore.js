import { randomBytes } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { Mutex } from '../../utils/mutex.js';
import { getRoleMatchKey, getRoleMatchRequestsKey } from '../../utils/database/keys.js';
import { PREFERENCE_CATEGORIES, DM_KINDS } from './matchLogic.js';

/**
 * Storage and rules for the role matcher.
 *
 * Two documents per guild, both cached in memory:
 *   - settings doc: role mapping, request channel, opted-in members, blocks
 *   - requests doc: DM requests, per-pair cooldowns, daily request counters
 *
 * Every write goes through `mutate`, which serialises writes per guild, works on a copy of the
 * document and only swaps it into the cache after the database confirmed the save. A failed save
 * therefore never leaves the cache and the database disagreeing.
 */

export const MATCH_LIMITS = Object.freeze({
  maxMembers: 2000,
  maxBlocksPerUser: 100,
  requestTtlMs: 24 * 60 * 60 * 1000,
  declineCooldownMs: 7 * 24 * 60 * 60 * 1000,
  dailyRequestLimit: 10,
  maxPendingPerUser: 3,
  keepRequestsMs: 7 * 24 * 60 * 60 * 1000,
  activeWindowMs: 2 * 60 * 60 * 1000,
});

const NEGATIVE_CACHE_MS = 15_000;
const DB_ERROR_MESSAGE = 'Could not reach the database. Please try again in a moment.';
const ACTIVITY_CAP_PER_GUILD = 5000;

export class MatchError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'MatchError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const isSnowflake = (value) => typeof value === 'string' && /^\d{15,25}$/.test(value);

// ---------------------------------------------------------------------------
// Generic cached document store
// ---------------------------------------------------------------------------

function createDocStore({ name, keyFn, normalize }) {
  const cache = new Map(); // guildId -> { data, ok, loadedAt }
  const inflight = new Map(); // guildId -> Promise

  function peek(guildId) {
    const cached = cache.get(guildId);
    if (!cached) return undefined;
    if (cached.ok || Date.now() - cached.loadedAt < NEGATIVE_CACHE_MS) return cached.data;
    return undefined;
  }

  async function load(client, guildId) {
    const cached = peek(guildId);
    if (cached) return cached;

    const existing = inflight.get(guildId);
    if (existing) return existing;

    const promise = (async () => {
      await null; // guarantees the `finally` below runs after the promise is registered
      try {
        const raw = await client.db.get(keyFn(guildId), null);
        const data = normalize(raw);
        cache.set(guildId, { data, ok: true, loadedAt: Date.now() });
        return data;
      } catch (error) {
        logger.error(`Failed to load ${name}`, { guildId, error });
        // `ok: false` means this empty document is never used as the base of a write.
        const empty = normalize(null);
        cache.set(guildId, { data: empty, ok: false, loadedAt: Date.now() });
        return empty;
      } finally {
        inflight.delete(guildId);
      }
    })();

    inflight.set(guildId, promise);
    return promise;
  }

  /** Runs mutator(draft, ctx) under the guild lock, then saves. `ctx.skipWrite = true` aborts the save. */
  async function mutate(client, guildId, mutator) {
    return Mutex.runExclusive(`${name}-store:${guildId}`, async () => {
      const cached = cache.get(guildId);
      let base;
      if (cached?.ok) {
        base = cached.data;
      } else {
        try {
          base = normalize(await client.db.get(keyFn(guildId), null));
        } catch (error) {
          logger.error(`Failed to read ${name} before writing`, { guildId, error });
          throw new MatchError('DATABASE', DB_ERROR_MESSAGE);
        }
      }

      const draft = structuredClone(base);
      const ctx = { skipWrite: false };
      const result = await mutator(draft, ctx);
      if (ctx.skipWrite) return result;

      let saved;
      try {
        saved = await client.db.set(keyFn(guildId), draft);
      } catch (error) {
        logger.error(`Failed to save ${name}`, { guildId, error });
        throw new MatchError('DATABASE', DB_ERROR_MESSAGE);
      }
      if (saved === false) throw new MatchError('DATABASE', DB_ERROR_MESSAGE);

      cache.set(guildId, { data: draft, ok: true, loadedAt: Date.now() });
      return result;
    });
  }

  return { peek, load, mutate };
}

// ---------------------------------------------------------------------------
// Settings document
// ---------------------------------------------------------------------------

function normalizeSettings(raw) {
  const doc = {
    version: 1,
    enabled: true,
    roles: {},
    dmRoles: { open: null, closed: null, ask: null },
    requestChannelId: null,
    members: {},
    blocks: {},
  };
  if (!raw || typeof raw !== 'object') return doc;

  doc.enabled = raw.enabled !== false;

  for (const key of Object.keys(PREFERENCE_CATEGORIES)) {
    if (isSnowflake(raw.roles?.[key])) doc.roles[key] = raw.roles[key];
  }
  for (const kind of Object.keys(DM_KINDS)) {
    if (isSnowflake(raw.dmRoles?.[kind])) doc.dmRoles[kind] = raw.dmRoles[kind];
  }
  if (isSnowflake(raw.requestChannelId)) doc.requestChannelId = raw.requestChannelId;

  if (raw.members && typeof raw.members === 'object') {
    for (const [userId, value] of Object.entries(raw.members)) {
      if (isSnowflake(userId)) doc.members[userId] = { joinedAt: Number(value?.joinedAt) || Date.now() };
    }
  }
  if (raw.blocks && typeof raw.blocks === 'object') {
    for (const [userId, list] of Object.entries(raw.blocks)) {
      if (!isSnowflake(userId) || !Array.isArray(list)) continue;
      const clean = [...new Set(list.filter(isSnowflake))].slice(0, MATCH_LIMITS.maxBlocksPerUser);
      if (clean.length > 0) doc.blocks[userId] = clean;
    }
  }
  return doc;
}

const settingsStore = createDocStore({ name: 'rolematch', keyFn: getRoleMatchKey, normalize: normalizeSettings });

export const getConfig = (client, guildId) => settingsStore.load(client, guildId);
export const peekConfig = (guildId) => settingsStore.peek(guildId);

/** Loads settings into the cache in the background (never throws). */
export function prefetchConfig(client, guildId) {
  settingsStore.load(client, guildId).catch(() => {});
}

export function isOptedIn(config, userId) {
  return Boolean(config.members[userId]);
}

export function isBlockedEitherWay(config, userA, userB) {
  return Boolean(config.blocks[userA]?.includes(userB) || config.blocks[userB]?.includes(userA));
}

/** A matcher is usable once at least one preference role and one contactable DM role are mapped. */
export function isConfigured(config) {
  const hasPreference = Object.keys(config.roles).some((key) => key !== 'notSharing');
  const hasDm = Boolean(config.dmRoles.open || config.dmRoles.ask);
  return hasPreference && hasDm;
}

function describeRoleUse(config, roleId, ignore) {
  for (const [key, id] of Object.entries(config.roles)) {
    if (id === roleId && key !== ignore) return PREFERENCE_CATEGORIES[key].label;
  }
  for (const [kind, id] of Object.entries(config.dmRoles)) {
    if (id === roleId && kind !== ignore) return DM_KINDS[kind];
  }
  return null;
}

export async function setPreferenceRole(client, guildId, category, roleId) {
  if (!PREFERENCE_CATEGORIES[category]) throw new MatchError('VALIDATION', 'Unknown preference category.');
  if (roleId !== null && !isSnowflake(roleId)) throw new MatchError('VALIDATION', 'That is not a valid role.');

  return settingsStore.mutate(client, guildId, (draft) => {
    if (roleId === null) {
      delete draft.roles[category];
      return null;
    }
    const usedBy = describeRoleUse(draft, roleId, category);
    if (usedBy) throw new MatchError('VALIDATION', `That role is already linked to **${usedBy}**. Each role can only be linked once.`);
    draft.roles[category] = roleId;
    return roleId;
  });
}

export async function setDmRole(client, guildId, kind, roleId) {
  if (!DM_KINDS[kind]) throw new MatchError('VALIDATION', 'Unknown DM role type.');
  if (roleId !== null && !isSnowflake(roleId)) throw new MatchError('VALIDATION', 'That is not a valid role.');

  return settingsStore.mutate(client, guildId, (draft) => {
    if (roleId === null) {
      draft.dmRoles[kind] = null;
      return null;
    }
    const usedBy = describeRoleUse(draft, roleId, kind);
    if (usedBy) throw new MatchError('VALIDATION', `That role is already linked to **${usedBy}**. Each role can only be linked once.`);
    draft.dmRoles[kind] = roleId;
    return roleId;
  });
}

export async function setRequestChannel(client, guildId, channelId) {
  if (channelId !== null && !isSnowflake(channelId)) throw new MatchError('VALIDATION', 'That is not a valid channel.');
  return settingsStore.mutate(client, guildId, (draft) => {
    draft.requestChannelId = channelId;
    return channelId;
  });
}

export async function setEnabled(client, guildId, enabled) {
  return settingsStore.mutate(client, guildId, (draft) => {
    draft.enabled = Boolean(enabled);
    return draft.enabled;
  });
}

/** Opts a member in. Returns { already: true } if they were already in. */
export async function joinMatcher(client, guildId, userId) {
  return settingsStore.mutate(client, guildId, (draft, ctx) => {
    if (draft.members[userId]) {
      ctx.skipWrite = true;
      return { already: true };
    }
    if (Object.keys(draft.members).length >= MATCH_LIMITS.maxMembers) {
      throw new MatchError('LIMIT', 'The matcher is full right now. Please ask an admin.');
    }
    draft.members[userId] = { joinedAt: Date.now() };
    return { already: false };
  });
}

/** Opts a member out. Returns true if they were in. */
export async function leaveMatcher(client, guildId, userId) {
  return settingsStore.mutate(client, guildId, (draft, ctx) => {
    if (!draft.members[userId]) {
      ctx.skipWrite = true;
      return false;
    }
    delete draft.members[userId];
    return true;
  });
}

/** Removes several members at once (used when they have left the server). */
export async function removeMembers(client, guildId, userIds) {
  if (userIds.length === 0) return 0;
  return settingsStore.mutate(client, guildId, (draft, ctx) => {
    let removed = 0;
    for (const id of userIds) {
      if (draft.members[id]) {
        delete draft.members[id];
        removed += 1;
      }
    }
    if (removed === 0) ctx.skipWrite = true;
    return removed;
  });
}

export async function blockUser(client, guildId, blockerId, targetId) {
  if (blockerId === targetId) throw new MatchError('VALIDATION', 'You can\'t block yourself.');
  if (!isSnowflake(targetId)) throw new MatchError('VALIDATION', 'That is not a valid member.');

  return settingsStore.mutate(client, guildId, (draft, ctx) => {
    const list = draft.blocks[blockerId] ?? [];
    if (list.includes(targetId)) {
      ctx.skipWrite = true;
      return { already: true };
    }
    if (list.length >= MATCH_LIMITS.maxBlocksPerUser) {
      throw new MatchError('LIMIT', `You can block up to ${MATCH_LIMITS.maxBlocksPerUser} members.`);
    }
    draft.blocks[blockerId] = [...list, targetId];
    return { already: false };
  });
}

export async function unblockUser(client, guildId, blockerId, targetId) {
  return settingsStore.mutate(client, guildId, (draft, ctx) => {
    const list = draft.blocks[blockerId];
    if (!list || !list.includes(targetId)) {
      ctx.skipWrite = true;
      return false;
    }
    const next = list.filter((id) => id !== targetId);
    if (next.length === 0) delete draft.blocks[blockerId];
    else draft.blocks[blockerId] = next;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Requests document
// ---------------------------------------------------------------------------

const dayKey = (now) => new Date(now).toISOString().slice(0, 10);

function normalizeRequests(raw) {
  const doc = { version: 1, requests: {}, cooldowns: {}, daily: {} };
  if (!raw || typeof raw !== 'object') return doc;

  if (raw.requests && typeof raw.requests === 'object') {
    for (const [id, r] of Object.entries(raw.requests)) {
      if (!r || !isSnowflake(r.from) || !isSnowflake(r.to)) continue;
      doc.requests[id] = {
        id,
        from: r.from,
        to: r.to,
        status: ['pending', 'accepted', 'declined', 'expired'].includes(r.status) ? r.status : 'expired',
        createdAt: Number(r.createdAt) || 0,
        expiresAt: Number(r.expiresAt) || 0,
        respondedAt: Number(r.respondedAt) || null,
        channelId: isSnowflake(r.channelId) ? r.channelId : null,
        messageId: isSnowflake(r.messageId) ? r.messageId : null,
      };
    }
  }
  if (raw.cooldowns && typeof raw.cooldowns === 'object') {
    for (const [key, until] of Object.entries(raw.cooldowns)) {
      if (Number.isFinite(Number(until))) doc.cooldowns[key] = Number(until);
    }
  }
  if (raw.daily && typeof raw.daily === 'object') {
    for (const [userId, entry] of Object.entries(raw.daily)) {
      if (typeof entry?.day === 'string' && Number.isFinite(Number(entry.count))) {
        doc.daily[userId] = { day: entry.day, count: Number(entry.count) };
      }
    }
  }
  return doc;
}

/** Marks overdue pending requests as expired and drops old data. Called on every write. */
function prune(doc, now) {
  for (const [id, request] of Object.entries(doc.requests)) {
    if (request.status === 'pending' && request.expiresAt <= now) request.status = 'expired';
    if (now - request.createdAt > MATCH_LIMITS.keepRequestsMs) delete doc.requests[id];
  }
  for (const [key, until] of Object.entries(doc.cooldowns)) {
    if (until <= now) delete doc.cooldowns[key];
  }
  const today = dayKey(now);
  for (const [userId, entry] of Object.entries(doc.daily)) {
    if (entry.day !== today) delete doc.daily[userId];
  }
}

const requestStore = createDocStore({ name: 'rolematch-requests', keyFn: getRoleMatchRequestsKey, normalize: normalizeRequests });

export async function getRequest(client, guildId, requestId) {
  const doc = await requestStore.load(client, guildId);
  return doc.requests[requestId] ?? null;
}

/**
 * Creates a pending request after checking every limit, all inside one locked write so two quick
 * clicks can never both pass the checks.
 */
export async function createRequest(client, guildId, { from, to, now = Date.now() }) {
  if (from === to) throw new MatchError('VALIDATION', 'You can\'t send a request to yourself.');

  return requestStore.mutate(client, guildId, (draft) => {
    prune(draft, now);

    const pending = Object.values(draft.requests).filter((r) => r.status === 'pending');
    if (pending.some((r) => r.from === from && r.to === to)) {
      throw new MatchError('DUPLICATE', 'You already have a pending request to this member.');
    }
    if (pending.filter((r) => r.from === from).length >= MATCH_LIMITS.maxPendingPerUser) {
      throw new MatchError('PENDING_LIMIT', `You can have up to ${MATCH_LIMITS.maxPendingPerUser} requests waiting at once. Wait for an answer first.`);
    }

    const cooldownUntil = draft.cooldowns[`${from}:${to}`];
    if (cooldownUntil && cooldownUntil > now) {
      throw new MatchError('COOLDOWN', 'You can\'t send this member a request right now.', { until: cooldownUntil });
    }

    const today = dayKey(now);
    const daily = draft.daily[from]?.day === today ? draft.daily[from] : { day: today, count: 0 };
    if (daily.count >= MATCH_LIMITS.dailyRequestLimit) {
      throw new MatchError('DAILY_LIMIT', `You've reached today's limit of ${MATCH_LIMITS.dailyRequestLimit} requests. Try again tomorrow.`);
    }
    draft.daily[from] = { day: today, count: daily.count + 1 };

    const id = randomBytes(5).toString('hex');
    const request = {
      id,
      from,
      to,
      status: 'pending',
      createdAt: now,
      expiresAt: now + MATCH_LIMITS.requestTtlMs,
      respondedAt: null,
      channelId: null,
      messageId: null,
    };
    draft.requests[id] = request;
    return request;
  });
}

export async function attachRequestMessage(client, guildId, requestId, { channelId, messageId }) {
  return requestStore.mutate(client, guildId, (draft, ctx) => {
    const request = draft.requests[requestId];
    if (!request) {
      ctx.skipWrite = true;
      return null;
    }
    request.channelId = channelId;
    request.messageId = messageId;
    return request;
  });
}

/** Undoes a request whose message could not be delivered (also gives back the daily allowance). */
export async function cancelRequest(client, guildId, requestId, now = Date.now()) {
  return requestStore.mutate(client, guildId, (draft, ctx) => {
    const request = draft.requests[requestId];
    if (!request) {
      ctx.skipWrite = true;
      return false;
    }
    delete draft.requests[requestId];
    const entry = draft.daily[request.from];
    if (entry && entry.day === dayKey(now) && entry.count > 0) entry.count -= 1;
    return true;
  });
}

/**
 * The person a request was sent to answers it. Only that person can; it can only be answered once;
 * and it must not have expired. 'decline' and 'block' also put the pair on cooldown.
 */
export async function respondToRequest(client, guildId, requestId, responderId, action, now = Date.now()) {
  if (!['accept', 'decline', 'block'].includes(action)) {
    throw new MatchError('VALIDATION', 'Unknown action.');
  }

  const request = await requestStore.mutate(client, guildId, (draft, ctx) => {
    const found = draft.requests[requestId];
    if (!found) {
      ctx.skipWrite = true;
      throw new MatchError('NOT_FOUND', 'This request no longer exists.');
    }
    if (found.to !== responderId) {
      ctx.skipWrite = true;
      throw new MatchError('NOT_TARGET', 'This request isn\'t for you.');
    }
    if (found.status === 'pending' && found.expiresAt <= now) {
      found.status = 'expired';
      throw new MatchError('EXPIRED', 'This request has expired.', { persistExpired: true });
    }
    if (found.status !== 'pending') {
      ctx.skipWrite = true;
      throw new MatchError(found.status === 'expired' ? 'EXPIRED' : 'ALREADY_ANSWERED', found.status === 'expired' ? 'This request has expired.' : 'This request was already answered.');
    }

    found.status = action === 'accept' ? 'accepted' : 'declined';
    found.respondedAt = now;
    if (action !== 'accept') draft.cooldowns[`${found.from}:${found.to}`] = now + MATCH_LIMITS.declineCooldownMs;
    prune(draft, now);
    return { ...found };
  }).catch(async (error) => {
    // An expiry discovered while answering must still be saved, but the mutator threw to abort the
    // answer, so persist it separately.
    if (error instanceof MatchError && error.persistExpired) {
      await requestStore.mutate(client, guildId, (draft) => prune(draft, now)).catch(() => {});
    }
    throw error;
  });

  if (action === 'block') {
    try {
      await blockUser(client, guildId, request.to, request.from);
    } catch (error) {
      logger.warn('Could not save block after declining a request', { guildId, error: error?.message });
    }
  }
  return request;
}

// ---------------------------------------------------------------------------
// Recent activity (memory only, only for members who joined the matcher)
// ---------------------------------------------------------------------------

const activity = new Map(); // guildId -> Map(userId -> timestamp)

export function noteActivity(guildId, userId, now = Date.now()) {
  let guildActivity = activity.get(guildId);
  if (!guildActivity) {
    guildActivity = new Map();
    activity.set(guildId, guildActivity);
  }
  guildActivity.delete(userId); // re-insert so the oldest entry is always first
  guildActivity.set(userId, now);
  if (guildActivity.size > ACTIVITY_CAP_PER_GUILD) {
    guildActivity.delete(guildActivity.keys().next().value);
  }
}

export function wasRecentlyActive(guildId, userId, now = Date.now()) {
  const at = activity.get(guildId)?.get(userId);
  return at !== undefined && now - at <= MATCH_LIMITS.activeWindowMs;
}
