import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { logger } from '../utils/logger.js';
import {
  AUTO_HIDE_AT,
  REPORT_COMMAND_NAME,
  addReport,
  getReportConfig,
  getConfessConfig,
  saveConfessConfig,
  blockConfessionAuthor,
} from '../services/safetyService.js';

// Custom IDs use "|" (never ":") so TitanBot's own button handler ignores them.
//   rptbtn                          Report button on bot posts (confessions)
//   rptmodal|channelId|messageId    Report reason form
//   rpt|del|channelId|messageId     Mod: delete reported message
//   rpt|ok|channelId|messageId      Mod: dismiss report
//   cnf|ok|authorId                 Mod: approve confession
//   cnf|no|authorId                 Mod: reject confession
//   cnf|block|authorId              Mod: reject and block author

const NO_PINGS = { parse: [] };
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
const markEmbed = (embed, text) => EmbedBuilder.from(embed).setFooter({ text });
const isMod = (interaction) =>
  Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages));

export default {
  name: Events.InteractionCreate,
  async execute(interaction) {
    try {
      if (interaction.isMessageContextMenuCommand()) {
        if (interaction.commandName === REPORT_COMMAND_NAME) {
          await openReportModal(interaction, interaction.targetMessage);
        }
        return;
      }

      if (interaction.isButton()) {
        const id = interaction.customId;
        if (id === 'rptbtn') return await openReportModal(interaction, interaction.message);
        if (id.startsWith('rpt|')) return await handleReportDecision(interaction);
        if (id.startsWith('cnf|')) return await handleConfessionDecision(interaction);
        return;
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith('rptmodal|')) {
        await handleReportModal(interaction);
      }
    } catch (error) {
      logger.error('Safety interaction error:', error);
      try {
        const payload = ephemeral('Something went wrong. Please try again.');
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch {
        // nothing more we can do
      }
    }
  },
};

/* ---------------------------------- Reports --------------------------------- */

async function openReportModal(interaction, target) {
  if (!interaction.guild) return;

  const config = await getReportConfig(interaction.client, interaction.guild.id);
  if (!config.channelId) {
    return interaction.reply(ephemeral("Reports aren't set up on this server yet."));
  }
  if (target.author.id === interaction.user.id) {
    return interaction.reply(ephemeral("You can't report your own message."));
  }

  const modal = new ModalBuilder()
    .setCustomId(`rptmodal|${target.channelId}|${target.id}`)
    .setTitle('Report message')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Why are you reporting this?')
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(3)
          .setMaxLength(300)
          .setRequired(true)
      )
    );

  await interaction.showModal(modal);
}

async function handleReportModal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [, channelId, messageId] = interaction.customId.split('|');
  const reason = interaction.fields.getTextInputValue('reason').trim();
  const guild = interaction.guild;
  const client = interaction.client;

  const config = await getReportConfig(client, guild.id);
  const modChannel = config.channelId
    ? await guild.channels.fetch(config.channelId).catch(() => null)
    : null;
  if (!modChannel?.isTextBased()) {
    return interaction.editReply("Reports aren't set up properly here. Please tell an admin.");
  }

  const sourceChannel = await guild.channels.fetch(channelId).catch(() => null);
  const target = sourceChannel?.isTextBased()
    ? await sourceChannel.messages.fetch(messageId).catch(() => null)
    : null;
  if (!target) {
    return interaction.editReply('I could not find that message. It may already be deleted.');
  }

  const { duplicate, total } = await addReport(client, guild.id, target.id, interaction.user.id);
  if (duplicate) {
    return interaction.editReply('You already reported this message. The mods have it.');
  }

  const isBotPost = target.author.id === client.user.id;
  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('🚩 Message reported')
    .setDescription(target.content ? target.content.slice(0, 900) : '*No text (attachment or embed only)*')
    .addFields(
      { name: 'Reporter', value: `${interaction.user} (${interaction.user.tag})`, inline: true },
      {
        name: 'Author',
        value: isBotPost
          ? 'Bot post (see the confession review channel)'
          : `${target.author} (${target.author.tag})`,
        inline: true,
      },
      { name: 'Channel', value: `<#${target.channelId}>`, inline: true },
      { name: 'Reason', value: reason.slice(0, 300) },
      { name: 'Reports', value: `${total}/${AUTO_HIDE_AT}`, inline: true },
      { name: 'Attachments', value: String(target.attachments.size), inline: true },
      { name: 'Message', value: `[Jump to message](${target.url})`, inline: true }
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rpt|del|${target.channelId}|${target.id}`)
      .setLabel('Delete message')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`rpt|ok|${target.channelId}|${target.id}`)
      .setLabel('Dismiss')
      .setStyle(ButtonStyle.Secondary)
  );

  await modChannel.send({ embeds: [embed], components: [row], allowedMentions: NO_PINGS });

  if (total === AUTO_HIDE_AT) {
    const removed = await target.delete().then(() => true, () => false);
    await modChannel
      .send({
        content: removed
          ? `🚫 A message (${target.id}) was removed automatically after ${AUTO_HIDE_AT} reports.`
          : `⚠️ A message hit ${AUTO_HIDE_AT} reports but I couldn't delete it: ${target.url}`,
        allowedMentions: NO_PINGS,
      })
      .catch(() => {});
  }

  await interaction.editReply('Thanks, the moderators have been notified.');
}

async function handleReportDecision(interaction) {
  if (!isMod(interaction)) {
    return interaction.reply(ephemeral('Only moderators can use these buttons.'));
  }

  const [, action, channelId, messageId] = interaction.customId.split('|');
  let outcome = 'Dismissed';

  if (action === 'del') {
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    const target = channel?.isTextBased()
      ? await channel.messages.fetch(messageId).catch(() => null)
      : null;

    if (!target) {
      outcome = 'Message was already gone';
    } else {
      const deleted = await target.delete().then(() => true, () => false);
      outcome = deleted ? 'Message deleted' : 'Could not delete the message';
    }
  }

  await interaction.update({
    embeds: [markEmbed(interaction.message.embeds[0], `${outcome} · ${interaction.user.tag}`)],
    components: [],
  });
}

/* -------------------------------- Confessions ------------------------------- */

async function handleConfessionDecision(interaction) {
  if (!isMod(interaction)) {
    return interaction.reply(ephemeral('Only moderators can use these buttons.'));
  }

  const [, action, authorId] = interaction.customId.split('|');
  const reviewEmbed = interaction.message.embeds[0];
  const client = interaction.client;
  const guild = interaction.guild;

  if (action === 'ok') {
    const config = await getConfessConfig(client, guild.id);
    const publicChannel = config.publicChannelId
      ? await guild.channels.fetch(config.publicChannelId).catch(() => null)
      : null;
    if (!publicChannel?.isTextBased()) {
      return interaction.reply(
        ephemeral('The public confession channel is missing. Run /safety confessions again.')
      );
    }

    const number = config.counter + 1;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('rptbtn')
        .setLabel('Report')
        .setEmoji('🚩')
        .setStyle(ButtonStyle.Secondary)
    );

    await publicChannel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x9b59b6)
          .setTitle(`Confession #${number}`)
          .setDescription(reviewEmbed.description)
          .setTimestamp(),
      ],
      components: [row],
      allowedMentions: NO_PINGS,
    });
    await saveConfessConfig(client, guild.id, { ...config, counter: number });

    return interaction.update({
      embeds: [markEmbed(reviewEmbed, `Approved as Confession #${number} · ${interaction.user.tag}`)],
      components: [],
    });
  }

  if (action === 'block') {
    await blockConfessionAuthor(client, guild.id, authorId);
  }

  const text =
    action === 'block'
      ? `Rejected and author blocked · ${interaction.user.tag}`
      : `Rejected · ${interaction.user.tag}`;

  return interaction.update({
    embeds: [markEmbed(reviewEmbed, text)],
    components: [],
  });
}
