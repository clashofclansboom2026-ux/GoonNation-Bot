const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, 'autodelete.json');
const MIN_SECONDS = 20;
const MAX_SECONDS = 100;

// { [channelId]: seconds }
let config = {};
try {
  config = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  config = {};
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(config, null, 2));
}

function scheduleDelete(message, delayMs) {
  setTimeout(async () => {
    try {
      const fresh = await message.channel.messages.fetch(message.id);
      if (fresh.pinned) return; // leave pinned messages alone
      await fresh.delete();
    } catch {
      // already deleted, missing perms, etc. - ignore
    }
  }, Math.max(0, delayMs));
}

const data = new SlashCommandBuilder()
  .setName('autodelete')
  .setDescription('Automatically delete messages in a channel after a delay')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Turn on auto-delete for a channel')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to auto-delete messages in')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt
          .setName('seconds')
          .setDescription(`Delay before deleting (${MIN_SECONDS}-${MAX_SECONDS} seconds)`)
          .setMinValue(MIN_SECONDS)
          .setMaxValue(MAX_SECONDS)
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Turn off auto-delete for a channel')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to stop auto-deleting in')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show channels with auto-delete on')
  );

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const channel = interaction.options.getChannel('channel');
    const seconds = interaction.options.getInteger('seconds');

    const perms = channel.permissionsFor(interaction.guild.members.me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages])) {
      return interaction.reply({
        content: `I need **View Channel** and **Manage Messages** permissions in ${channel} first.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    config[channel.id] = seconds;
    save();
    return interaction.reply({
      content: `Auto-delete is on for ${channel}. Messages will be deleted after **${seconds}s**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'remove') {
    const channel = interaction.options.getChannel('channel');
    if (!config[channel.id]) {
      return interaction.reply({
        content: `${channel} doesn't have auto-delete enabled.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    delete config[channel.id];
    save();
    return interaction.reply({
      content: `Auto-delete is off for ${channel}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'list') {
    const lines = Object.entries(config)
      .filter(([id]) => interaction.guild.channels.cache.has(id))
      .map(([id, s]) => `<#${id}> - ${s}s`);
    return interaction.reply({
      content: lines.length ? lines.join('\n') : 'No channels have auto-delete enabled.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

// Call from the messageCreate event
function handleMessage(message) {
  if (!message.guild) return;
  const seconds = config[message.channelId];
  if (!seconds) return;
  scheduleDelete(message, seconds * 1000);
}

// Call once when the bot is ready. Picks up recent messages after a restart,
// since timers are lost when the bot goes offline.
async function resume(client) {
  for (const [channelId, seconds] of Object.entries(config)) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.messages) continue;
      const messages = await channel.messages.fetch({ limit: 100 });
      for (const msg of messages.values()) {
        const age = Date.now() - msg.createdTimestamp;
        scheduleDelete(msg, seconds * 1000 - age);
      }
    } catch {
      // channel gone or inaccessible - ignore
    }
  }
}

module.exports = { data, execute, handleMessage, resume };
