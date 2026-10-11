import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} from 'discord.js';
import {
  MIN_SECONDS,
  MAX_SECONDS,
  getAutoDeleteConfig,
  setChannelDelay,
  removeChannel,
} from '../../services/autoDeleteService.js';

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

export default {
  data: new SlashCommandBuilder()
    .setName('autodelete')
    .setDescription('Automatically delete messages in a channel after a delay')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
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
    ),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply(ephemeral('This command only works in a server.'));
    }

    const client = interaction.client;
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const channel = interaction.options.getChannel('channel');
      const seconds = interaction.options.getInteger('seconds');

      const perms = channel.permissionsFor(interaction.guild.members.me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages])) {
        return interaction.reply(
          ephemeral(`I need **View Channel** and **Manage Messages** permissions in ${channel} first.`)
        );
      }

      await setChannelDelay(client, interaction.guild.id, channel.id, seconds);
      return interaction.reply(
        ephemeral(`Auto-delete is on for ${channel}. Messages will be deleted after **${seconds}s**.`)
      );
    }

    if (sub === 'remove') {
      const channel = interaction.options.getChannel('channel');
      const removed = await removeChannel(client, interaction.guild.id, channel.id);
      return interaction.reply(
        ephemeral(
          removed
            ? `Auto-delete is off for ${channel}.`
            : `${channel} doesn't have auto-delete enabled.`
        )
      );
    }

    if (sub === 'list') {
      const config = await getAutoDeleteConfig(client, interaction.guild.id);
      const lines = Object.entries(config).map(([id, s]) => `<#${id}> - ${s}s`);
      return interaction.reply(
        ephemeral(lines.length ? lines.join('\n') : 'No channels have auto-delete enabled.')
      );
    }
  },
};
