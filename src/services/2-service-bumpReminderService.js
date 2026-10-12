// src/services/bumpReminderService.js
//
// Persistent bump reminders.
// - Every timer is a row in the `bump_reminders` Postgres table (UTC timestamps).
// - A cron job (see app.js) calls checkBumpReminders() every minute, so timers
//   survive restarts and redeploys: anything due is sent on the next tick.
// - One row per (guild, directory). Duplicate timers and duplicate reminders are
//   prevented by the primary key plus an atomic "claim" before sending.

import { pgDb } from '../utils/postgresDatabase.js';
import { pgConfig } from '../config/database/postgres.js';
import { logger } from '../utils/logger.js';
import { infoEmbed } from '../utils/embeds.js';
import { getDirectoryConfig, getNotificationConfig } from '../config/bump.js';

const TABLE = pgConfig.tables.bump_reminders;
const CLAIM_LEASE_MS = 5 * 60 * 1000; // a claimed reminder is retried after this long
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_PER_TICK = 25;

let tickRunning = false;

export class BumpStorageUnavailableError extends Error {
    constructor() {
        super('PostgreSQL is not available, so bump timers cannot be stored persistently.');
        this.name = 'BumpStorageUnavailableError';
    }
}

function getPool() {
    if (!pgDb.isAvailable() || !pgDb.pool) {
        throw new BumpStorageUnavailableError();
    }
    return pgDb.pool;
}

function mapRow(row) {
    return {
        guildId: row.guild_id,
        directory: row.directory,
        userId: row.user_id,
        channelId: row.channel_id,
        bumpedAt: row.bumped_at,
        remindAt: row.remind_at,
        cooldownMs: Number(row.cooldown_ms),
        notifiedAt: row.notified_at,
        attempts: row.attempts,
    };
}

/** Discord timestamp markup. Discord shows it in each viewer's own timezone. */
export function discordTime(date, style = 'F') {
    return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

export function formatRemaining(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds && !days && !hours) parts.push(`${seconds}s`);
    return parts.length ? parts.join(' ') : '0s';
}

/** The pending, not-yet-expired timer for this directory, or null. */
export async function getActiveBump(guildId, directoryKey, now = new Date()) {
    const result = await getPool().query(
        `SELECT * FROM ${TABLE}
         WHERE guild_id = $1 AND directory = $2
           AND notified_at IS NULL AND remind_at > $3`,
        [guildId, directoryKey, now]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * Record a bump and schedule its reminder.
 * Atomic: if a timer is still running for this guild + directory, nothing is
 * changed and { created: false, existing } is returned instead.
 */
export async function scheduleBump({ guildId, channelId, userId, directoryKey, now = new Date() }) {
    const directory = getDirectoryConfig(directoryKey);
    if (!directory) {
        return { created: false, error: 'unknown_directory' };
    }
    if (directory.cooldownMs === null) {
        return { created: false, error: 'cooldown_not_configured', directory };
    }

    const remindAt = new Date(now.getTime() + directory.cooldownMs);

    const result = await getPool().query(
        `INSERT INTO ${TABLE}
            (guild_id, directory, user_id, channel_id, bumped_at, remind_at, cooldown_ms,
             notified_at, claimed_at, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, 0)
         ON CONFLICT (guild_id, directory) DO UPDATE SET
            user_id = EXCLUDED.user_id,
            channel_id = EXCLUDED.channel_id,
            bumped_at = EXCLUDED.bumped_at,
            remind_at = EXCLUDED.remind_at,
            cooldown_ms = EXCLUDED.cooldown_ms,
            notified_at = NULL,
            claimed_at = NULL,
            attempts = 0
         WHERE ${TABLE}.notified_at IS NOT NULL OR ${TABLE}.remind_at <= $5
         RETURNING *`,
        [guildId, directoryKey, userId, channelId || null, now, remindAt, directory.cooldownMs]
    );

    if (result.rows[0]) {
        return { created: true, bump: mapRow(result.rows[0]), directory };
    }

    const existing = await getActiveBump(guildId, directoryKey, now);
    return { created: false, existing, directory };
}

async function claimDueReminders(now) {
    const leaseCutoff = new Date(now.getTime() - CLAIM_LEASE_MS);
    const result = await getPool().query(
        `UPDATE ${TABLE}
         SET claimed_at = $1, attempts = attempts + 1
         WHERE (guild_id, directory) IN (
             SELECT guild_id, directory FROM ${TABLE}
             WHERE notified_at IS NULL
               AND remind_at <= $1
               AND (claimed_at IS NULL OR claimed_at < $2)
             ORDER BY remind_at ASC
             LIMIT ${MAX_PER_TICK}
             FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [now, leaseCutoff]
    );
    return result.rows.map(mapRow);
}

async function markNotified(reminder) {
    // The bumped_at check means we never mark a NEWER timer as sent.
    await getPool().query(
        `UPDATE ${TABLE}
         SET notified_at = $1
         WHERE guild_id = $2 AND directory = $3 AND bumped_at = $4 AND notified_at IS NULL`,
        [new Date(), reminder.guildId, reminder.directory, reminder.bumpedAt]
    );
}

async function sendDm(client, reminder, payload) {
    try {
        const user = await client.users.fetch(reminder.userId);
        await user.send(payload);
        return true;
    } catch (error) {
        logger.warn(`Bump reminder DM failed for user ${reminder.userId}: ${error.message}`);
        return false;
    }
}

async function sendToChannel(client, reminder, channelId, embed, { ping }) {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || typeof channel.send !== 'function') {
            return false;
        }
        if (channel.guildId && channel.guildId !== reminder.guildId) {
            return false; // never post a reminder in a different server
        }

        const notification = getNotificationConfig();
        const useRole = Boolean(ping && notification.roleId);

        await channel.send({
            content: useRole ? `<@&${notification.roleId}>` : `<@${reminder.userId}>`,
            embeds: [embed],
            // Exactly one role OR one user can be pinged. Never everyone/here.
            allowedMentions: useRole
                ? { parse: [], roles: [notification.roleId], users: [] }
                : { parse: [], roles: [], users: [reminder.userId] },
        });
        return true;
    } catch (error) {
        logger.warn(`Bump reminder channel post failed (channel ${channelId}): ${error.message}`);
        return false;
    }
}

function buildReminderEmbed(client, reminder, label) {
    const guildName = client.guilds.cache.get(reminder.guildId)?.name;
    const lines = [
        `The **${label}** cooldown you logged with \`/bump\` has finished${guildName ? ` for **${guildName}**` : ''}.`,
        'You can bump again now.',
        '',
        `Logged: ${discordTime(reminder.bumpedAt, 'R')}`,
        `Cooldown ended: ${discordTime(reminder.remindAt, 'F')}`,
    ];
    return infoEmbed(`⏰ Time to bump on ${label}`, lines.join('\n'));
}

async function deliverReminder(client, reminder) {
    const directory = getDirectoryConfig(reminder.directory);
    const label = directory?.label || reminder.directory;
    const embed = buildReminderEmbed(client, reminder, label);
    const notification = getNotificationConfig();

    const wantDm = notification.mode === 'dm' || notification.mode === 'both';
    const wantChannel = notification.mode === 'channel' || notification.mode === 'both';

    let delivered = false;

    if (wantDm) {
        delivered = await sendDm(client, reminder, { embeds: [embed] });
    }

    if (wantChannel && notification.channelId) {
        const ok = await sendToChannel(client, reminder, notification.channelId, embed, { ping: true });
        delivered = delivered || ok;
    }

    // Fallback so a reminder is not lost (for example when DMs are closed):
    // post in the channel where /bump was used, pinging only the person who ran it.
    if (!delivered && reminder.channelId) {
        delivered = await sendToChannel(client, reminder, reminder.channelId, embed, { ping: false });
    }

    if (delivered) {
        await markNotified(reminder);
        logger.info(`Bump reminder sent: guild ${reminder.guildId}, ${reminder.directory}, user ${reminder.userId}`);
        return;
    }

    if (reminder.attempts >= MAX_DELIVERY_ATTEMPTS) {
        await markNotified(reminder);
        logger.error(
            `Bump reminder gave up after ${reminder.attempts} attempts: guild ${reminder.guildId}, ${reminder.directory}, user ${reminder.userId}`
        );
        return;
    }

    logger.warn(
        `Bump reminder not delivered (attempt ${reminder.attempts}/${MAX_DELIVERY_ATTEMPTS}); will retry in ${CLAIM_LEASE_MS / 60000} minutes`
    );
}

/** Called every minute by cron. Safe to call repeatedly; safe across restarts. */
export async function checkBumpReminders(client) {
    if (tickRunning) {
        return;
    }
    if (!pgDb.isAvailable() || !pgDb.pool) {
        return;
    }

    tickRunning = true;
    try {
        const due = await claimDueReminders(new Date());
        for (const reminder of due) {
            try {
                await deliverReminder(client, reminder);
            } catch (error) {
                logger.error('Bump reminder delivery error:', error);
            }
        }
    } finally {
        tickRunning = false;
    }
}
