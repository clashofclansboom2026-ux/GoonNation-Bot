/**
 * Pure logic for the role matcher and DM requests.
 *
 * No Discord, no database, no I/O in this file, so every rule here is easy to test and cannot
 * break because of API changes. The storage and Discord layers build on top of it.
 */

// The preference roles the matcher understands. Admins link their existing server roles to these
// keys with `/match config role`. The labels are what members see.
export const PREFERENCE_CATEGORIES = Object.freeze({
  dominate: { label: 'Dominate', group: 'dynamic' },
  submissive: { label: 'Submissive', group: 'dynamic' },
  switch: { label: 'Switch', group: 'dynamic' },
  brat: { label: 'Brat', group: 'dynamic' },
  curious: { label: 'Curious', group: 'style' },
  vanilla: { label: 'Vanilla', group: 'style' },
  flirting: { label: 'Flirting', group: 'interest' },
  dirtyTalk: { label: 'Dirty Talk', group: 'interest' },
  roleplay: { label: 'NSFW Roleplay', group: 'interest' },
  voyeur: { label: 'Voyeur/Exhibitionist', group: 'interest' },
  notSharing: { label: 'Not Sharing', group: 'privacy' },
});

export const DM_KINDS = Object.freeze({
  open: 'DMs Open',
  closed: 'DMs Closed',
  ask: 'Ask to DM',
});

export const TIERS = Object.freeze({
  great: '🔥 Great match',
  good: '✨ Good match',
  possible: '💬 Could click',
});

const DYNAMIC_KEYS = ['dominate', 'submissive', 'switch', 'brat'];
const STYLE_KEYS = ['curious', 'vanilla'];
const INTEREST_KEYS = ['flirting', 'dirtyTalk', 'roleplay', 'voyeur'];

// Keys are the two category names sorted alphabetically and joined with "|".
const DYNAMIC_SCORES = Object.freeze({
  'dominate|submissive': 6,
  'brat|dominate': 5,
  'dominate|switch': 4,
  'submissive|switch': 4,
  'brat|switch': 3,
  'switch|switch': 3,
});
const STYLE_SCORES = Object.freeze({
  'curious|curious': 2,
  'vanilla|vanilla': 2,
  'curious|vanilla': 1,
});
const INTEREST_POINTS = 2;
const ACTIVE_BONUS = 2;

const pairKey = (a, b) => [a, b].sort().join('|');
const labelOf = (key) => PREFERENCE_CATEGORIES[key]?.label ?? key;

/**
 * Turns a member's role IDs into a profile using the guild's role mapping.
 * If a member somehow holds several DM roles, the most restrictive one wins (closed > ask > open).
 */
export function getProfile(roleIds, config) {
  const owned = new Set(roleIds);
  const categories = new Set();

  for (const key of Object.keys(PREFERENCE_CATEGORIES)) {
    const roleId = config?.roles?.[key];
    if (roleId && owned.has(roleId)) categories.add(key);
  }

  let dm = 'unset';
  for (const kind of ['open', 'ask', 'closed']) {
    const roleId = config?.dmRoles?.[kind];
    if (roleId && owned.has(roleId)) dm = kind;
  }

  const notSharing = categories.has('notSharing');
  categories.delete('notSharing');
  return { categories, dm, notSharing };
}

/** A member can be matched only if they share their preferences and can be contacted. */
export function isMatchable(profile) {
  return (
    !profile.notSharing &&
    (profile.dm === 'open' || profile.dm === 'ask') &&
    profile.categories.size > 0
  );
}

/** Why a member cannot join the matcher (a message for them), or null if they can. */
export function joinProblem(profile) {
  if (profile.notSharing) {
    return 'You have the **Not Sharing** role, so you can\'t be matched. Remove that role if you change your mind.';
  }
  if (profile.dm === 'closed') {
    return 'Matching needs **DMs Open** or **Ask to DM**. Your DMs are set to Closed.';
  }
  if (profile.dm === 'unset') {
    return 'Pick a DM preference role first (**DMs Open** or **Ask to DM**) in the self-roles channel.';
  }
  if (profile.categories.size === 0) {
    return 'Pick at least one preference role first in the self-roles channel.';
  }
  return null;
}

/** How a request to this member must be handled. */
export function dmAccess(profile) {
  if (profile.dm === 'closed') return 'closed';
  if (profile.dm === 'open') return 'direct';
  return 'request'; // "Ask to DM", and members with no DM role at all: always ask first
}

export function tierFor(score) {
  if (score >= 8) return 'great';
  if (score >= 4) return 'good';
  return 'possible';
}

/** Scores how well two profiles fit. Symmetric. Returns { score, shared, dynamic }. */
export function scorePair(a, b) {
  if (a.notSharing || b.notSharing) return { score: 0, shared: [], dynamic: null };

  let dynamicScore = 0;
  let dynamic = null;
  for (const mine of DYNAMIC_KEYS) {
    if (!a.categories.has(mine)) continue;
    for (const theirs of DYNAMIC_KEYS) {
      if (!b.categories.has(theirs)) continue;
      const value = DYNAMIC_SCORES[pairKey(mine, theirs)] ?? 0;
      if (value > dynamicScore) {
        dynamicScore = value;
        dynamic = { mine: labelOf(mine), theirs: labelOf(theirs) };
      }
    }
  }

  let styleScore = 0;
  for (const mine of STYLE_KEYS) {
    if (!a.categories.has(mine)) continue;
    for (const theirs of STYLE_KEYS) {
      if (!b.categories.has(theirs)) continue;
      styleScore = Math.max(styleScore, STYLE_SCORES[pairKey(mine, theirs)] ?? 0);
    }
  }

  const shared = INTEREST_KEYS.filter((key) => a.categories.has(key) && b.categories.has(key));
  const score = dynamicScore + styleScore + shared.length * INTEREST_POINTS;
  return { score, shared: shared.map(labelOf), dynamic };
}

/**
 * Picks the best matches for `me` out of `candidates` ([{ userId, profile, active }]).
 * - skips anyone who isn't matchable, anyone `isBlocked(userId)` says to skip, and zero-score pairs
 * - recently active members get a small boost
 * - ties are broken randomly so the same people don't always sit on top
 */
export function rankCandidates({ me, candidates, limit = 5, rng = Math.random, isBlocked = () => false }) {
  const pool = [];

  for (const candidate of candidates) {
    if (!isMatchable(candidate.profile)) continue;
    if (isBlocked(candidate.userId)) continue;

    const result = scorePair(me, candidate.profile);
    if (result.score <= 0) continue;

    pool.push({
      userId: candidate.userId,
      dm: candidate.profile.dm,
      active: Boolean(candidate.active),
      score: result.score,
      shared: result.shared,
      dynamic: result.dynamic,
      tier: tierFor(result.score),
      rank: result.score + (candidate.active ? ACTIVE_BONUS : 0),
    });
  }

  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  pool.sort((x, y) => y.rank - x.rank);
  return pool.slice(0, limit);
}

// ---------------------------------------------------------------------------
// "Please ask first" reminder: spotting messages that ask someone for DMs
// ---------------------------------------------------------------------------

const SOLICITATION_PATTERNS = [
  /\b(?:can|could|may|might|should|shall|will|would)\s+(?:i|we)\s+(?:please\s+)?(?:dm|pm)\b/i, // "can i dm"
  /\b(?:wanna|want\s+to|lemme|let\s+me|let\s+us|lets|let's)\s+(?:dm|pm)\b/i, // "wanna dm"
  /\b(?:dm|pm|msg|message|inbox)\s+(?:me|u|you)\b/i, // "dm me", "message you"
  /\b(?:slide|sliding)\s+(?:in|into)\b/i, // "slide into"
  /\b(?:open|check)\s+(?:your|ur)\s+dms?\b/i, // "check ur dms"
  /\bdm\s*\?/i, // "dm?"
  /\bdms?\s+open\s*\?/i, // "dms open?"
];

/** True if the text looks like a request to move a conversation into DMs. */
export function looksLikeDmSolicitation(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 1000) return false;
  return SOLICITATION_PATTERNS.some((pattern) => pattern.test(text));
}
