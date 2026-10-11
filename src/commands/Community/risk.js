import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} from 'discord.js';
import {
  MIN_SECONDS,
  MAX_SECONDS,
  DEFAULT_SECONDS,
  getRiskConfig,
  saveRiskConfig,
  disableRisk,
} from '../../services/riskService.js';

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });
const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

export default {
  data: new SlashCommandBuilder()
    .setName('risk')
    .setDescription('Claim system: images must be claimed in time or they get deleted')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Set the channels and claim time')
        .addChannelOption((opt) =>
          opt
            .setName('spawn')
            .setDescription('Channel where images are posted')
            .addChannelTypes(...TEXT_TYPES)
            .setRequired(true)
        )
        .addChannelOption((opt) =>
          opt
            .setName('caught')
            .setDescription('Channel where claimed images get reposted')
            .addChannelTypes(...TEXT_TYPES)
            .setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('seconds')
            .setDescription(`Time to claim (${MIN_SECONDS}-${MAX_SECONDS}s, default ${DEFAULT_SECONDS})`)
            .setMinValue(MIN_SECONDS)
            .setMaxValue(MAX_SECONDS)
        )
    )
    .addSubcommand((sub) => sub.setName('status').setDescription('Show the current setup'))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Turn the claim system off')),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply(ephemeral('This command only works in a server.'));
    }

    const client = interaction.client;
    const guildId = interaction.guild.id;
    const sub = interaction.options.getSubcommand();

    if (sub === 'setup') {
      const spawn = interaction.options.getChannel('spawn');
      const caught = interaction.options.getChannel('caught');
      const seconds = interaction.options.getInteger('seconds') ?? DEFAULT_SECONDS;

      if (spawn.id === caught.id) {
        return interaction.reply(ephemeral('The spawn and caught channels need to be different.'));
      }

      const me = interaction.guild.members.me;
      const spawnPerms = spawn.permissionsFor(me);
      const caughtPerms = caught.permissionsFor(me);
      const problems = [];

      if (
        !spawnPerms?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ])
      ) {
        problems.push(`${spawn}: View Channel, Send Messages, Read Message History, Manage Messages`);
      }
      if (
        !caughtPerms?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
        ])
      ) {
        problems.push(`${caught}: View Channel, Send Messages, Attach Files`);
      }

      if (problems.length) {
        return interaction.reply(ephemeral(`I'm missing permissions:\n${problems.join('\n')}`));
      }

      await saveRiskConfig(client, guildId, {
        spawnChannelId: spawn.id,
        caughtChannelId: caught.id,
        seconds,
      });

      return interaction.reply(
        ephemeral(
          `Claim system is on.\nImages posted in ${spawn} get **${seconds}s** to be claimed.\nClaimed images are reposted in ${caught}.`
        )
      );
    }

    if (sub === 'status') {
      const config = await getRiskConfig(client, guildId);
      if (!config) {
        return interaction.reply(ephemeral('The claim system is not set up. Use `/risk setup`.'));
      }
      return interaction.reply(
        ephemeral(
          `Spawn channel: <#${config.spawnChannelId}>\nCaught channel: <#${config.caughtChannelId}>\nClaim time: **${config.seconds}s**`
        )
      );
    }

    if (sub === 'disable') {
      await disableRisk(client, guildId);
      return interaction.reply(ephemeral('The claim system is turned off.'));
    }
  },
};
