import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { PREFERENCE_CATEGORIES, DM_KINDS } from '../../services/roleMatch/matchLogic.js';
import {
  MatchError,
  MATCH_LIMITS,
  getConfig,
  setPreferenceRole,
  setDmRole,
  setRequestChannel,
  setEnabled,
  blockUser,
  unblockUser,
} from '../../services/roleMatch/roleMatchStore.js';
import {
  performJoin,
  performLeave,
  findMatches,
  buildMatchPayload,
  requestDm,
  buildPanelPayload,
  describeConfig,
  profileLink,
} from '../../services/roleMatch/roleMatchService.js';

const TEXT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const categoryChoices = Object.entries(PREFERENCE_CATEGORIES).map(([value, { label }]) => ({ name: label, value }));
const dmChoices = Object.entries(DM_KINDS).map(([value, name]) => ({ name, value }));

export default {
  slashOnly: true,
  category: 'Community',

  data: new SlashCommandBuilder()
    .setName('match')
    .setDescription('Find members who fit you, and ask before sending a DM')
    .setDMPermission(false)
    .addSubcommand((sub) => sub.setName('join').setDescription('Join the matcher (opt-in, you can leave any time)'))
    .addSubcommand((sub) => sub.setName('leave').setDescription('Leave the matcher'))
    .addSubcommand((sub) => sub.setName('find').setDescription('See members who fit you (only you can see this)'))
    .addSubcommand((sub) =>
      sub
        .setName('ask')
        .setDescription('Ask a member if you can DM them')
        .addUserOption((option) => option.setName('user').setDescription('Who to ask').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('block')
        .setDescription('Stop a member from requesting you or showing up in your matches')
        .addUserOption((option) => option.setName('user').setDescription('Who to block').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('unblock')
        .setDescription('Undo a block')
        .addUserOption((option) => option.setName('user').setDescription('Who to unblock').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('panel')
        .setDescription('Admin: post the Join / Leave panel')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Where to post it (defaults to this channel)')
            .addChannelTypes(...TEXT_CHANNEL_TYPES),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('config')
        .setDescription('Admin: set up the matcher')
        .addSubcommand((sub) => sub.setName('view').setDescription('Show the current setup'))
        .addSubcommand((sub) =>
          sub
            .setName('role')
            .setDescription('Link one of your server roles to a preference')
            .addStringOption((option) =>
              option.setName('preference').setDescription('Which preference').setRequired(true).addChoices(...categoryChoices),
            )
            .addRoleOption((option) => option.setName('role').setDescription('The role (leave empty to unlink)')),
        )
        .addSubcommand((sub) =>
          sub
            .setName('dmrole')
            .setDescription('Link one of your server roles to a DM setting')
            .addStringOption((option) =>
              option.setName('type').setDescription('Which DM setting').setRequired(true).addChoices(...dmChoices),
            )
            .addRoleOption((option) => option.setName('role').setDescription('The role (leave empty to unlink)')),
        )
        .addSubcommand((sub) =>
          sub
            .setName('channel')
            .setDescription('Where DM requests are posted (e.g. your ask-2-dm channel)')
            .addChannelOption((option) =>
              option
                .setName('channel')
                .setDescription('The request channel (leave empty to clear)')
                .addChannelTypes(...TEXT_CHANNEL_TYPES),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName('toggle')
            .setDescription('Turn the matcher and DM requests on or off')
            .addBooleanOption((option) => option.setName('enabled').setDescription('On or off').setRequired(true)),
        ),
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'This command can only be used in a server.' });
      }

      const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferred) return;

      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();

      if (group === 'config' || sub === 'panel') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          return await replyUserError(interaction, {
            type: ErrorTypes.PERMISSION,
            message: 'You need the **Manage Server** permission to use this.',
          });
        }
      }

      if (group === 'config') return await handleConfig(interaction, sub);

      switch (sub) {
        case 'join':
          return await reply(interaction, successEmbed('Matcher', await performJoin(interaction.client, interaction.guild, interaction.user.id)));
        case 'leave':
          return await reply(interaction, infoEmbed('Matcher', await performLeave(interaction.client, interaction.guild, interaction.user.id)));
        case 'find': {
          const matches = await findMatches(interaction.client, interaction.guild, interaction.user.id);
          return await InteractionHelper.safeEditReply(interaction, buildMatchPayload(matches));
        }
        case 'ask':
          return await handleAsk(interaction);
        case 'block':
          return await handleBlock(interaction);
        case 'unblock':
          return await handleUnblock(interaction);
        case 'panel':
          return await handlePanel(interaction);
        default:
          return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Unknown action.' });
      }
    } catch (error) {
      return await handleError(interaction, error);
    }
  },
};

// ---------------------------------------------------------------------------

const reply = (interaction, embed) => InteractionHelper.safeEditReply(interaction, { embeds: [embed] });

async function handleError(interaction, error) {
  if (error instanceof MatchError) {
    const type = error.code === 'DATABASE' ? ErrorTypes.DATABASE : ErrorTypes.VALIDATION;
    return await replyUserError(interaction, { type, message: error.message });
  }
  logger.error('Match command error:', error);
  return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Something went wrong. Please try again.' });
}

function describeRequestResult(result) {
  if (result.kind === 'direct') {
    return successEmbed('DMs Open', `They have **DMs Open**, so you can message them directly: ${profileLink(result.targetId)}\n\nBe respectful, and stop if they ask you to.`);
  }
  const hours = Math.round(MATCH_LIMITS.requestTtlMs / 3_600_000);
  return successEmbed('Request Sent', `Your request was posted in <#${result.channelId}>. They'll see it next time they're around, and it expires in ${hours} hours.\n\nPlease don't send it again if they don't answer.`);
}

async function handleAsk(interaction) {
  const user = interaction.options.getUser('user', true);
  const result = await requestDm(interaction.client, interaction.guild, interaction.user.id, user.id);
  return await reply(interaction, describeRequestResult(result));
}

async function handleBlock(interaction) {
  const user = interaction.options.getUser('user', true);
  const { already } = await blockUser(interaction.client, interaction.guildId, interaction.user.id, user.id);
  return await reply(
    interaction,
    already
      ? infoEmbed('Already Blocked', `<@${user.id}> is already blocked.`)
      : successEmbed('Blocked', `<@${user.id}> can't send you requests and won't appear in your matches, and you won't appear in theirs. They aren't told.`),
  );
}

async function handleUnblock(interaction) {
  const user = interaction.options.getUser('user', true);
  const removed = await unblockUser(interaction.client, interaction.guildId, interaction.user.id, user.id);
  return await reply(
    interaction,
    removed ? successEmbed('Unblocked', `<@${user.id}> is no longer blocked.`) : infoEmbed('Not Blocked', `<@${user.id}> wasn't blocked.`),
  );
}

async function handlePanel(interaction) {
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  if (!channel || !TEXT_CHANNEL_TYPES.includes(channel.type)) {
    return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Please choose a text or announcement channel.' });
  }

  const config = await getConfig(interaction.client, interaction.guildId);
  const me = interaction.guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.EmbedLinks)) {
    return await replyUserError(interaction, {
      type: ErrorTypes.PERMISSION,
      message: `I need **View Channel, Send Messages and Embed Links** in ${channel}.`,
    });
  }

  await channel.send(buildPanelPayload());

  const warning = Object.keys(config.roles).length === 0 || !(config.dmRoles.open || config.dmRoles.ask)
    ? '\n\n⚠️ The roles aren\'t linked yet, so the buttons won\'t work until you finish `/match config`.'
    : '';
  return await reply(interaction, successEmbed('Panel Posted', `The Join / Leave panel is now in ${channel}.${warning}`));
}

async function handleConfig(interaction, sub) {
  const { client, guildId } = interaction;

  if (sub === 'view') {
    const config = await getConfig(client, guildId);
    return await InteractionHelper.safeEditReply(interaction, {
      embeds: [createEmbed({ title: 'Matcher Setup', fields: describeConfig(config), color: 'primary' })],
    });
  }

  if (sub === 'role') {
    const preference = interaction.options.getString('preference', true);
    const role = interaction.options.getRole('role');
    if (role && role.id === interaction.guildId) {
      return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: '`@everyone` can\'t be linked.' });
    }
    await setPreferenceRole(client, guildId, preference, role?.id ?? null);
    const label = PREFERENCE_CATEGORIES[preference].label;
    return await reply(interaction, successEmbed('Role Linked', role ? `**${label}** is now linked to ${role}.` : `**${label}** was unlinked.`));
  }

  if (sub === 'dmrole') {
    const kind = interaction.options.getString('type', true);
    const role = interaction.options.getRole('role');
    if (role && role.id === interaction.guildId) {
      return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: '`@everyone` can\'t be linked.' });
    }
    await setDmRole(client, guildId, kind, role?.id ?? null);
    return await reply(interaction, successEmbed('Role Linked', role ? `**${DM_KINDS[kind]}** is now linked to ${role}.` : `**${DM_KINDS[kind]}** was unlinked.`));
  }

  if (sub === 'channel') {
    const channel = interaction.options.getChannel('channel');
    if (channel) {
      const me = interaction.guild.members.me;
      const perms = me ? channel.permissionsFor(me) : null;
      if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.EmbedLinks)) {
        return await replyUserError(interaction, {
          type: ErrorTypes.PERMISSION,
          message: `I need **View Channel, Send Messages and Embed Links** in ${channel} first.`,
        });
      }
    }
    await setRequestChannel(client, guildId, channel?.id ?? null);
    return await reply(interaction, successEmbed('Request Channel', channel ? `DM requests will be posted in ${channel}.` : 'The request channel was cleared. Requests to "Ask to DM" members won\'t work until you set one.'));
  }

  if (sub === 'toggle') {
    const enabled = interaction.options.getBoolean('enabled', true);
    await setEnabled(client, guildId, enabled);
    return await reply(interaction, enabled ? successEmbed('Matcher On', 'The matcher and DM requests are on.') : warningEmbed('Matcher Off', 'The matcher and DM requests are off. Members who joined stay joined.'));
  }

  return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Unknown setting.' });
}
