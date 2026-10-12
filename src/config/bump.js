// src/config/bump.js
//
// Settings for the /bump reminder feature.
//
// IMPORTANT: no cooldown numbers are written in this file on purpose.
// Enter the current VERIFIED cooldown for each directory as a Railway variable
// (Railway -> your bot service -> Variables), in MINUTES:
//
//   BUMP_DISBOARD_COOLDOWN_MINUTES   e.g. the number of minutes DISBOARD currently requires
//   BUMP_DISCADIA_COOLDOWN_MINUTES   e.g. the number of minutes Discadia currently requires
//
// Check each directory's own site/bot for the real current cooldown first.
// If a variable is missing or invalid, /bump for that directory refuses to
// schedule a reminder and tells the user the cooldown is not configured.
//
// Optional notification settings (all optional):
//
//   BUMP_REMINDER_MODE        dm (default) | channel | both
//   BUMP_REMINDER_CHANNEL_ID  channel to post in when mode is channel or both
//   BUMP_REMINDER_ROLE_ID     ONE role to ping in that channel (never @everyone/@here)

const MAX_COOLDOWN_MINUTES = 60 * 24 * 14; // sanity cap: 14 days

export const BUMP_DIRECTORIES = {
    disboard: {
        key: 'disboard',
        label: 'DISBOARD',
        cooldownEnv: '120',
    },
    discadia: {
        key: 'discadia',
        label: 'Discadia',
        cooldownEnv: '360',
    },
};

/**
 * Look up a directory and its configured cooldown.
 * Returns null for an unknown directory key.
 * cooldownMs is null when the variable is missing or invalid; `problem`
 * explains which ('missing' | 'invalid').
 */
export function getDirectoryConfig(key) {
    const directory = BUMP_DIRECTORIES[String(key || '').toLowerCase()];
    if (!directory) {
        return null;
    }

    const raw = process.env[directory.cooldownEnv];
    if (raw === undefined || String(raw).trim() === '') {
        return { ...directory, cooldownMs: null, problem: 'missing' };
    }

    const minutes = Number(String(raw).trim());
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_COOLDOWN_MINUTES) {
        return { ...directory, cooldownMs: null, problem: 'invalid' };
    }

    return { ...directory, cooldownMs: Math.round(minutes * 60 * 1000), problem: null };
}

const SNOWFLAKE = /^\d{17,20}$/;

function readSnowflake(name) {
    const raw = process.env[name];
    if (!raw) {
        return null;
    }
    const value = String(raw).trim();
    return SNOWFLAKE.test(value) ? value : null;
}

/** Notification settings, read fresh each time so a redeploy picks up changes. */
export function getNotificationConfig() {
    const requestedMode = String(process.env.BUMP_REMINDER_MODE || 'dm').trim().toLowerCase();
    const channelId = readSnowflake('1558426575140159600');
    const roleId = readSnowflake('1558443630967136377');

    let mode = ['dm', 'channel', 'both'].includes(requestedMode) ? requestedMode : 'dm';
    if ((mode === 'channel' || mode === 'both') && !channelId) {
        // Channel mode needs a channel. Fall back to DM rather than losing reminders.
        mode = 'dm';
    }

    return { mode, channelId, roleId };
}
