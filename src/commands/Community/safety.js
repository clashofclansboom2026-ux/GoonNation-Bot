import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} from 'discord.js';
import {
  AUTO_HIDE_AT,
  getReportConfig,
  saveReportConfig,
  getConfessConfig,
  saveConfessConfig,
  unblockConfessionAuthor,
} from '../../services/safetyService.js';

const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

const VIEW = [PermissionFlagsBits.ViewChannel, 'View Channel'];
const SEND = [PermissionFlagsBits.SendMessages, 'Send Messages'];
const EMBED = [PermissionFlagsBits.EmbedLinks, 'Embed Links'];

// Returns a problem description, or null if the channel is fine
function checkChannel(channel, guild, needs, mustBePrivate) {
  const perms = channel.permissionsFor(guild.members.me);
  const missing = needs.filter(([flag]) => !perms?.has(flag)).map(([, label]) => label);
  if (missing.length) {
    return `${channel}: I need ${missing.join(', ')}.`;
  }

  if (mustBePrivate && channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) {
    return `${channel} can be seen by everyone. Make it mods-only first so reporters and authors stay private.`;
  }
  return null;
}

export default {
  data: new SlashCommandBuilder()
    .setName('safety')
    .setDescription('Set up reports and confessions (admins only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('reports')
        .setDescription('Set the private channel where reports go')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Mods-only channel for reports')
            .addChannelTypes(...TEXT_TYPES)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('confessions')
        .setDescription('Set the review channel and the public confession channel')
        .addChannelOption((opt) =>
          opt
            .setName('review')
            .setDescription('Mods-only channel where confessions are approved')
            .addChannelTypes(...TEXT_TYPES)
            .setRequired(true)
        )
        .addChannelOption((opt) =>
          opt
            .setName('public')
            .setDescription('Channel where approved confessions are posted')
            .addChannelTypes(...TEXT_TYPES)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('unblock')
        .setDescription('Let a blocked member send confessions again')
        .addUserOption((opt) =>
          opt.setName('user').setDescription('Member to unblock').setRequired(true)
        )
    )
    .addSubcommand((sub) => sub.setName('status').setDescription('Show the current setup')),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply(ephemeral('This command only works in a server.'));
    }

    const client = interaction.client;
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();

    if (sub === 'reports') {
      const channel = interaction.options.getChannel('channel');
      const problem = checkChannel(channel, guild, [VIEW, SEND, EMBED], true);
      if (problem) return interaction.reply(ephemeral(problem));

      const config = await getReportConfig(client, guild.id);
      await saveReportConfig(client, guild.id, { ...config, channelId: channel.id });
      return interaction.reply(
        ephemeral(
          `Reports will go to ${channel}.\nMembers can long-press (or right-click) a message, choose Apps, then **Report Message**.\nA message is removed automatically after **${AUTO_HIDE_AT}** reports from different people.`
        )
      );
    }

    if (sub === 'confessions') {
      const review = interaction.options.getChannel('review');
      const publicChannel = interaction.options.getChannel('public');

      if (review.id === publicChannel.id) {
        return interaction.reply(ephemeral('The review and public channels need to be different.'));
      }

      const problems = [
        checkChannel(review, guild, [VIEW, SEND, EMBED], true),
        checkChannel(publicChannel, guild, [VIEW, SEND, EMBED], false),
      ].filter(Boolean);
      if (problems.length) return interaction.reply(ephemeral(problems.join('\n')));

      const config = await getConfessConfig(client, guild.id);
      await saveConfessConfig(client, guild.id, {
        ...config,
        reviewChannelId: review.id,
        publicChannelId: publicChannel.id,
      });
      return interaction.reply(
        ephemeral(
          `Confessions are on.\nMembers use \`/confess\`, mods approve in ${review}, and approved ones appear anonymously in ${publicChannel}.`
        )
      );
    }

    if (sub === 'unblock') {
      const user = interaction.options.getUser('user');
      const removed = await unblockConfessionAuthor(client, guild.id, user.id);
      return interaction.reply(
        ephemeral(removed ? `${user} can send confessions again.` : `${user} wasn't blocked.`)
      );
    }

    if (sub === 'status') {
      const reports = await getReportConfig(client, guild.id);
      const confess = await getConfessConfig(client, guild.id);
      const lines = [
        `Reports channel: ${reports.channelId ? `<#${reports.channelId}>` : 'not set'}`,
        `Confession review: ${confess.reviewChannelId ? `<#${confess.reviewChannelId}>` : 'not set'}`,
        `Confession public: ${confess.publicChannelId ? `<#${confess.publicChannelId}>` : 'not set'}`,
        `Confessions posted: ${confess.counter}`,
        `Blocked confessors: ${confess.blocked.length}`,
        `Auto-remove after: ${AUTO_HIDE_AT} reports`,
      ];
      return interaction.reply(ephemeral(lines.join('\n')));
    }
  },
};
