import { logger } from '../utils/logger.js';

export const REPORT_COMMAND_NAME = 'Report Message';

// A message is removed automatically once this many different people report it
export const AUTO_HIDE_AT = 3;

const MAX_TRACKED_REPORTS = 200;

async function read(client, key, fallback) {
  try {
    const raw = await client.db.get(key);
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch (error) {
    logger.error(`DB read failed for ${key}:`, error);
    return fallback;
  }
}

async function write(client, key, value) {
  await client.db.set(key, value);
}

/* ---------------------------------- Reports --------------------------------- */

export async function getReportConfig(client, guildId) {
  const raw = await read(client, `reports:${guildId}`, {});
  return { channelId: null, ...raw };
}

export async function saveReportConfig(client, guildId, config) {
  await write(client, `reports:${guildId}`, config);
}

// Records a report. Returns { duplicate, total } where total = unique reporters.
export async function addReport(client, guildId, messageId, reporterId) {
  const key = `reportLog:${guildId}`;
  const data = await read(client, key, { entries: [] });
  const entries = Array.isArray(data.entries) ? data.entries : [];

  let entry = entries.find((e) => e.id === messageId);
  if (!entry) {
    entry = { id: messageId, reporters: [] };
    entries.push(entry);
    while (entries.length > MAX_TRACKED_REPORTS) entries.shift();
  }

  if (entry.reporters.includes(reporterId)) {
    return { duplicate: true, total: entry.reporters.length };
  }

  entry.reporters.push(reporterId);
  await write(client, key, { entries });
  return { duplicate: false, total: entry.reporters.length };
}

/* -------------------------------- Confessions ------------------------------- */

const confessDefaults = () => ({
  reviewChannelId: null,
  publicChannelId: null,
  counter: 0,
  blocked: [],
});

export async function getConfessConfig(client, guildId) {
  const raw = await read(client, `confess:${guildId}`, {});
  return {
    ...confessDefaults(),
    ...raw,
    blocked: Array.isArray(raw.blocked) ? raw.blocked : [],
  };
}

export async function saveConfessConfig(client, guildId, config) {
  await write(client, `confess:${guildId}`, config);
}

export async function blockConfessionAuthor(client, guildId, userId) {
  const config = await getConfessConfig(client, guildId);
  if (!config.blocked.includes(userId)) {
    await saveConfessConfig(client, guildId, { ...config, blocked: [...config.blocked, userId] });
  }
}

export async function unblockConfessionAuthor(client, guildId, userId) {
  const config = await getConfessConfig(client, guildId);
  if (!config.blocked.includes(userId)) return false;
  await saveConfessConfig(client, guildId, {
    ...config,
    blocked: config.blocked.filter((id) => id !== userId),
  });
  return true;
}

/* ------------------------------ Truth or dare ------------------------------- */

export const TOD_LEVELS = ['mild', 'spicy', 'wild'];

// Built-in prompts are flirty but not explicit. Add your own with /tod add.
const BUILT_IN_PROMPTS = [
  // Truth - mild
  { type: 'truth', level: 'mild', text: "What's the most embarrassing thing you've done to impress someone?" },
  { type: 'truth', level: 'mild', text: "What's your biggest dating pet peeve?" },
  { type: 'truth', level: 'mild', text: "What's the worst pickup line you've ever heard?" },
  { type: 'truth', level: 'mild', text: "What's your most awkward first-date story?" },
  { type: 'truth', level: 'mild', text: 'Who in this server would you most like to go on a date with, and why?' },
  // Truth - spicy
  { type: 'truth', level: 'spicy', text: "What's the boldest message you've ever sent to someone you liked?" },
  { type: 'truth', level: 'spicy', text: "What's the flirtiest thing anyone has ever said to you?" },
  { type: 'truth', level: 'spicy', text: "What's the most daring thing you've done to get someone's attention?" },
  { type: 'truth', level: 'spicy', text: 'What instantly makes you attracted to someone?' },
  { type: 'truth', level: 'spicy', text: "What's your biggest guilty pleasure?" },
  // Dare - mild
  { type: 'dare', level: 'mild', text: 'Post the cheesiest pickup line you can think of.' },
  { type: 'dare', level: 'mild', text: 'Describe your dream date using only emojis.' },
  { type: 'dare', level: 'mild', text: 'Compliment the last person who posted in the chat.' },
  { type: 'dare', level: 'mild', text: 'Change your server nickname to whatever the next person suggests for an hour.' },
  { type: 'dare', level: 'mild', text: 'Write a two-line poem about the person who played before you.' },
  // Dare - spicy
  { type: 'dare', level: 'spicy', text: 'Send the flirtiest (non-explicit) message you can to someone of your choice.' },
  { type: 'dare', level: 'spicy', text: 'Describe your ideal partner in exactly five words.' },
  { type: 'dare', level: 'spicy', text: 'Write a steamy-sounding opening line for a romance novel.' },
  { type: 'dare', level: 'spicy', text: 'Tell the chat the most daring thing on your bucket list.' },
  { type: 'dare', level: 'spicy', text: 'Rate the last three people who posted from 1 to 10 on charm, and say why.' },
];

async function readTod(client, guildId) {
  const raw = await read(client, `tod:${guildId}`, {});
  return {
    nextId: Number(raw.nextId) || 1,
    prompts: Array.isArray(raw.prompts) ? raw.prompts : [],
  };
}

export async function pickPrompt(client, guildId, type, level) {
  const data = await readTod(client, guildId);
  const matches = (p) => p.type === type && p.level === level;
  const pool = [...BUILT_IN_PROMPTS.filter(matches), ...data.prompts.filter(matches)];
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function addPrompt(client, guildId, type, level, text) {
  const data = await readTod(client, guildId);
  const id = data.nextId;
  data.prompts.push({ id, type, level, text });
  await write(client, `tod:${guildId}`, { nextId: id + 1, prompts: data.prompts });
  return id;
}

export async function removePrompt(client, guildId, id) {
  const data = await readTod(client, guildId);
  const remaining = data.prompts.filter((p) => p.id !== id);
  if (remaining.length === data.prompts.length) return false;
  await write(client, `tod:${guildId}`, { nextId: data.nextId, prompts: remaining });
  return true;
}

export async function listPrompts(client, guildId) {
  const data = await readTod(client, guildId);
  return data.prompts;
}
