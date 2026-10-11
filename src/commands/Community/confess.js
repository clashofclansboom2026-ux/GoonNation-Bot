import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { getConfessConfig } from '../../services/safetyService.js';

const COOLDOWN_MS = 60_000;
const lastUsed = new Map(); // userId -> timestamp

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

export default {
  data: new SlashCommandBuilder()
    .setName('confess')
    .setDescription('Send an anonymous confession (mods review it first)')
    .addStringOption((opt) =>
      opt
        .setName('text')
        .setDescription('Your confession')
        .setMinLength(5)
        .setMaxLength(1000)
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply(ephemeral('This command only works in a server.'));
    }

    const config = await getConfessConfig(interaction.client, interaction.guild.id);
    if (!config.reviewChannelId || !config.publicChannelId) {
      return interaction.reply(ephemeral("Confessions aren't set up on this server yet."));
    }

    if (config.blocked.includes(interaction.user.id)) {
      return interaction.reply(ephemeral("You can't send confessions on this server."));
    }

    const wait = (lastUsed.get(interaction.user.id) ?? 0) + COOLDOWN_MS - Date.now();
    if (wait > 0) {
      return interaction.reply(
        ephemeral(`Slow down! You can send another confession in ${Math.ceil(wait / 1000)}s.`)
      );
    }

    const reviewChannel = await interaction.guild.channels
      .fetch(config.reviewChannelId)
      .catch(() => null);
    if (!reviewChannel?.isTextBased()) {
      return interaction.reply(ephemeral("I can't reach the review channel. Please tell an admin."));
    }

    const text = interaction.options.getString('text').trim();
    const user = interaction.user;

    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle('📝 Confession awaiting review')
      .setDescription(text)
      .addFields({ name: 'Author (mods only)', value: `${user} (${user.tag})` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`cnf|ok|${user.id}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`cnf|no|${user.id}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`cnf|block|${user.id}`)
        .setLabel('Reject & block')
        .setStyle(ButtonStyle.Danger)
    );

    try {
      await reviewChannel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
    } catch {
      return interaction.reply(ephemeral("I couldn't send that to the review channel. Please tell an admin."));
    }

    lastUsed.set(user.id, Date.now());
    return interaction.reply(
      ephemeral('Your confession was sent to the mods for review. If approved, it will be posted anonymously.')
    );
  },
};
