import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { createEmbed } from '../../utils/embeds.js';
import {
  PREFERENCE_CATEGORIES,
  DM_KINDS,
  TIERS,
  getProfile,
  joinProblem,
  dmAccess,
  rankCandidates,
  looksLikeDmSolicitation,
} from './matchLogic.js';
import {
  MATCH_LIMITS,
  MatchError,
  getConfig,
  peekConfig,
  prefetchConfig,
  isOptedIn,
  isBlockedEitherWay,
  isConfigured,
  joinMatcher,
  leaveMatcher,
  removeMembers,
  createRequest,
  attachRequestMessage,
  cancelRequest,
  noteActivity,
  wasRecentlyActive,
} from './roleMatchStore.js';

/**
 * Discord-facing part of the role matcher. Everything the commands and buttons need lives here so
 * the command and button files stay thin.
 */

const MAX_POOL = 100; // candidates looked at per search (random sample if more members have joined)
const MAX_RESULTS = 5;
const REMINDER_COOLDOWN_MS = 2 * 60_000;
const REMINDER_DELETE_MS = 20_000;
const REMINDER_CACHE_CAP = 2000;

export const profileLink = (userId) => `https://discord.com/users/${userId}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchMembersByIds(guild, ids) {
  const found = new Map();
  const toFetch = [];

  for (const id of ids) {
    const cached = guild.members.cache.get(id);
    if (cached) found.set(id, cached);
    else toFetch.push(id);
  }

  let failed = false;
  if (toFetch.length > 0) {
    try {
      const fetched = await guild.members.fetch({ user: toFetch, time: 15_000 });
      for (const member of fetched.values()) found.set(member.id, member);
    } catch (error) {
      failed = true;
      logger.warn('Could not fetch members for the matcher', { guildId: guild.id, error: error?.message });
    }
  }

  const missing = failed ? [] : ids.filter((id) => !found.has(id));
  return { found, missing, failed };
}

function sample(list, count) {
  if (list.length <= count) return [...list];
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

function requireUsable(config) {
  if (!config.enabled) throw new MatchError('DISABLED', 'The matcher is switched off in this server.');
  if (!isConfigured(config)) {
    throw new MatchError('NOT_CONFIGURED', 'The matcher hasn\'t been set up yet. An admin needs to run `/match config` first.');
  }
}

// ---------------------------------------------------------------------------
// Join / leave
// ---------------------------------------------------------------------------

export async function performJoin(client, guild, userId) {
  const config = await getConfig(client, guild.id);
  requireUsable(config);

  const { found } = await fetchMembersByIds(guild, [userId]);
  const member = found.get(userId);
  if (!member) throw new MatchError('NOT_FOUND', 'I couldn\'t load your roles. Please try again.');

  const problem = joinProblem(getProfile(member.roles.cache.keys(), config));
  if (problem) throw new MatchError('NOT_ELIGIBLE', problem);

  const { already } = await joinMatcher(client, guild.id, userId);
  noteActivity(guild.id, userId);

  return already
    ? 'You\'re already in the matcher. Use `/match find` to see your matches.'
    : 'You\'re in! Use `/match find` to see who fits you. You\'ll only ever appear to people who are also in the matcher, and you can leave any time.';
}

export async function performLeave(client, guild, userId) {
  const wasIn = await leaveMatcher(client, guild.id, userId);
  return wasIn
    ? 'You\'ve left the matcher. You won\'t appear in anyone\'s matches.'
    : 'You weren\'t in the matcher.';
}

// ---------------------------------------------------------------------------
// Finding matches
// ---------------------------------------------------------------------------

export async function findMatches(client, guild, userId) {
  const config = await getConfig(client, guild.id);
  requireUsable(config);

  if (!isOptedIn(config, userId)) {
    throw new MatchError('NOT_JOINED', 'Join the matcher first with `/match join`, so you can be matched too.');
  }

  const { found: mine } = await fetchMembersByIds(guild, [userId]);
  const me = mine.get(userId);
  if (!me) throw new MatchError('NOT_FOUND', 'I couldn\'t load your roles. Please try again.');

  const myProfile = getProfile(me.roles.cache.keys(), config);
  const problem = joinProblem(myProfile);
  if (problem) throw new MatchError('NOT_ELIGIBLE', problem);

  const poolIds = sample(Object.keys(config.members).filter((id) => id !== userId), MAX_POOL);
  const { found, missing } = await fetchMembersByIds(guild, poolIds);

  // Members who left the server are quietly removed from the matcher.
  if (missing.length > 0) {
    removeMembers(client, guild.id, missing).catch((error) =>
      logger.debug('Could not remove departed matcher members', { error: error?.message }),
    );
  }

  const candidates = [];
  for (const [id, member] of found) {
    if (member.user?.bot) continue;
    candidates.push({
      userId: id,
      profile: getProfile(member.roles.cache.keys(), config),
      active: wasRecentlyActive(guild.id, id),
    });
  }

  return rankCandidates({
    me: myProfile,
    candidates,
    limit: MAX_RESULTS,
    isBlocked: (id) => isBlockedEitherWay(config, userId, id),
  });
}

export function buildMatchPayload(matches) {
  if (matches.length === 0) {
    return {
      embeds: [
        createEmbed({
          title: 'No Matches Right Now',
          description:
            'Nobody who fits you has joined the matcher yet, or they\'re all unavailable. Check back later — the more people join, the better it gets.',
          color: 'info',
        }),
      ],
      components: [],
    };
  }

  const lines = matches.map((match, index) => {
    const parts = [`**${index + 1}.** <@${match.userId}> · ${TIERS[match.tier]}${match.active ? ' · 🟢 active recently' : ''}`];
    if (match.dynamic) parts.push(`> Pairs well: ${match.dynamic.mine} × ${match.dynamic.theirs}`);
    if (match.shared.length > 0) parts.push(`> Shared: ${match.shared.join(', ')}`);
    parts.push(`> ${match.dm === 'open' ? DM_KINDS.open : DM_KINDS.ask}`);
    return parts.join('\n');
  });

  const row = new ActionRowBuilder().addComponents(
    matches.map((match, index) =>
      new ButtonBuilder()
        .setCustomId(`match_req:${match.userId}`)
        .setLabel(match.dm === 'open' ? `Say hi #${index + 1}` : `Ask #${index + 1}`)
        .setStyle(match.dm === 'open' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );

  return {
    embeds: [
      createEmbed({
        title: 'Your Matches',
        description: `${lines.join('\n\n')}\n\nOnly you can see this. Nobody is told you looked.`,
        color: 'primary',
      }),
    ],
    components: [row],
  };
}

// ---------------------------------------------------------------------------
// DM requests
// ---------------------------------------------------------------------------

/**
 * Asks `targetId` for permission to DM them, respecting their DM role.
 * Returns { kind: 'direct' } if their DMs are open, or { kind: 'sent', request, channelId } after
 * posting the request. Throws MatchError (with a message that is safe to show) otherwise.
 */
export async function requestDm(client, guild, requesterId, targetId) {
  const config = await getConfig(client, guild.id);
  if (!config.enabled) throw new MatchError('DISABLED', 'DM requests are switched off in this server.');

  if (requesterId === targetId) throw new MatchError('VALIDATION', 'You can\'t send a request to yourself.');

  const { found, failed } = await fetchMembersByIds(guild, [targetId]);
  const target = found.get(targetId);
  if (!target) {
    throw new MatchError('NOT_FOUND', failed ? 'I couldn\'t look that member up. Please try again.' : 'That member isn\'t in the server.');
  }
  if (target.user?.bot) throw new MatchError('VALIDATION', 'Bots don\'t take DM requests.');

  // The same wording whether or not a block exists, so a block is never revealed.
  const unavailable = new MatchError('UNAVAILABLE', 'That member isn\'t available for requests right now.');
  if (isBlockedEitherWay(config, requesterId, targetId)) throw unavailable;

  const access = dmAccess(getProfile(target.roles.cache.keys(), config));

  if (access === 'closed') {
    throw new MatchError('CLOSED', `${target.displayName} has **DMs Closed**. Please respect that and keep the conversation in the server.`);
  }
  if (access === 'direct') {
    return { kind: 'direct', targetId };
  }

  // "Ask to DM": post a request they can accept or decline.
  if (!config.requestChannelId) {
    throw new MatchError('NOT_CONFIGURED', 'Requests can\'t be sent yet: an admin needs to set the request channel with `/match config channel`.');
  }
  const channel = guild.channels.cache.get(config.requestChannelId);
  const me = guild.members.me;
  const perms = channel && me ? channel.permissionsFor(me) : null;
  if (
    !channel ||
    !channel.isTextBased?.() ||
    !perms ||
    !perms.has(PermissionFlagsBits.ViewChannel) ||
    !perms.has(PermissionFlagsBits.SendMessages) ||
    !perms.has(PermissionFlagsBits.EmbedLinks)
  ) {
    throw new MatchError('NOT_CONFIGURED', 'I can\'t post in the request channel right now. An admin needs to check the channel and my permissions.');
  }

  const request = await createRequest(client, guild.id, { from: requesterId, to: targetId });

  try {
    const expires = Math.floor(request.expiresAt / 1000);
    const embed = createEmbed({
      title: '💌 DM request',
      description: `<@${requesterId}> would like to DM <@${targetId}>.\n\nYou're in control: accept, decline, or decline and block. This request expires <t:${expires}:R>.`,
      color: 'primary',
    });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`match_ans:${request.id}:accept`).setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`match_ans:${request.id}:decline`).setLabel('Decline').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`match_ans:${request.id}:block`).setLabel('Decline & block').setStyle(ButtonStyle.Danger),
    );

    const sent = await channel.send({
      content: `<@${targetId}>`,
      embeds: [embed],
      components: [row],
      allowedMentions: { users: [targetId] },
    });

    await attachRequestMessage(client, guild.id, request.id, { channelId: channel.id, messageId: sent.id }).catch(() => {});
    return { kind: 'sent', request, channelId: channel.id };
  } catch (error) {
    logger.error('Could not post a DM request', { guildId: guild.id, error: error?.message });
    await cancelRequest(client, guild.id, request.id).catch(() => {});
    throw new MatchError('DELIVERY', 'I couldn\'t post your request. Please try again in a moment.');
  }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function buildPanelPayload() {
  const embed = createEmbed({
    title: '💞 Find Your Match',
    description:
      'Join the matcher to get suggestions of members who fit your preferences, based on your self-roles.\n\n' +
      '• It\'s **opt-in**: you only appear to other members who joined too.\n' +
      '• Matches are private. Nobody is told you looked.\n' +
      '• DM roles are respected: **DMs Closed** members are never suggested, and **Ask to DM** members get a request they can accept, decline or block.\n' +
      '• Leave any time with the button below.',
    color: 'primary',
  });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('match_join').setLabel('Join matcher').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('match_leave').setLabel('Leave matcher').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

export function describeConfig(config) {
  const roleLine = (id) => (id ? `<@&${id}>` : '*not set*');
  const preferences = Object.entries(PREFERENCE_CATEGORIES)
    .map(([key, { label }]) => `**${label}:** ${roleLine(config.roles[key])}`)
    .join('\n');
  const dm = Object.entries(DM_KINDS)
    .map(([kind, label]) => `**${label}:** ${roleLine(config.dmRoles[kind])}`)
    .join('\n');

  return [
    { name: 'Status', value: config.enabled ? '🟢 On' : '⏸️ Off', inline: true },
    { name: 'Members in matcher', value: String(Object.keys(config.members).length), inline: true },
    { name: 'Request channel', value: config.requestChannelId ? `<#${config.requestChannelId}>` : '*not set*', inline: true },
    { name: 'Preference roles', value: preferences },
    { name: 'DM roles', value: dm },
  ];
}

// ---------------------------------------------------------------------------
// Message hooks (called from messageCreate; both are cheap and never throw)
// ---------------------------------------------------------------------------

/** Remembers when matcher members last chatted, so recently active people rank a little higher. */
export function noteMatcherActivity(message, client) {
  try {
    const guildId = message.guildId;
    if (!guildId || message.author?.bot) return;

    const config = peekConfig(guildId);
    if (!config) {
      prefetchConfig(client, guildId);
      return;
    }
    if (config.members[message.author.id]) noteActivity(guildId, message.author.id);
  } catch (error) {
    logger.debug('Matcher activity tracking failed', { error: error?.message });
  }
}

const reminderSeen = new Map(); // "channelId:targetId" -> timestamp

function shouldRemind(channelId, targetId, now) {
  const key = `${channelId}:${targetId}`;
  const last = reminderSeen.get(key);
  if (last !== undefined && now - last < REMINDER_COOLDOWN_MS) return false;

  if (reminderSeen.size >= REMINDER_CACHE_CAP) {
    for (const [k, at] of reminderSeen) {
      if (now - at >= REMINDER_COOLDOWN_MS) reminderSeen.delete(k);
    }
    if (reminderSeen.size >= REMINDER_CACHE_CAP) reminderSeen.delete(reminderSeen.keys().next().value);
  }
  reminderSeen.set(key, now);
  return true;
}

/**
 * If someone asks a **DMs Closed** member to DM them, post a short polite reminder (it deletes
 * itself). For **Ask to DM** members it points to `/match ask`. It never deletes anything and never pings.
 */
export function maybeRemindDmPreferences(message, client) {
  try {
    const guildId = message.guildId;
    if (!guildId || message.author?.bot) return;

    const mentioned = message.mentions?.members;
    if (!mentioned || mentioned.size === 0) return;
    if (!looksLikeDmSolicitation(message.content)) return;

    const config = peekConfig(guildId);
    if (!config) {
      prefetchConfig(client, guildId);
      return;
    }
    if (!config.enabled) return;

    const closedId = config.dmRoles.closed;
    const askId = config.dmRoles.ask;
    if (!closedId && !askId) return;

    const now = Date.now();
    const closed = [];
    const ask = [];
    for (const member of mentioned.values()) {
      if (member.id === message.author.id || member.user?.bot) continue;
      if (closedId && member.roles.cache.has(closedId)) {
        if (shouldRemind(message.channelId, member.id, now)) closed.push(member.id);
      } else if (askId && member.roles.cache.has(askId)) {
        if (shouldRemind(message.channelId, member.id, now)) ask.push(member.id);
      }
    }
    if (closed.length === 0 && ask.length === 0) return;

    const mention = (ids) => ids.slice(0, 5).map((id) => `<@${id}>`).join(', ');
    const lines = [];
    if (closed.length > 0) {
      lines.push(`👋 Heads-up: ${mention(closed)} ${closed.length === 1 ? 'has' : 'have'} **DMs Closed**. Please don't ask them to DM. Keep it in the server.`);
    }
    if (ask.length > 0) {
      lines.push(`💌 ${mention(ask)} ${ask.length === 1 ? 'is' : 'are'} set to **Ask to DM**. Send a request with \`/match ask\` instead of asking here.`);
    }

    const me = message.guild?.members?.me;
    const perms = me ? message.channel.permissionsFor?.(me) : null;
    if (perms && !perms.has(PermissionFlagsBits.SendMessages)) return;

    message.channel
      .send({ content: lines.join('\n'), allowedMentions: { parse: [] } })
      .then((sent) => {
        const timer = setTimeout(() => sent.delete().catch(() => {}), REMINDER_DELETE_MS);
        timer.unref?.();
      })
      .catch(() => {});
  } catch (error) {
    logger.debug('DM reminder failed', { error: error?.message });
  }
}

export { MATCH_LIMITS };
