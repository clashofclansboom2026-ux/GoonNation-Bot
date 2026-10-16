import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import {
  STICKY_LIMITS,
  StickyError,
  isStickyChannel,
  getSticky,
  listStickies,
  setSticky,
  editSticky,
  updateStickySettings,
  setStickyEnabled,
  removeSticky,
  restoreStickyVersion,
  repostSticky,
  validateStickyInput,
} from '../../services/stickyService.js';

const MODAL_TIMEOUT_MS = 10 * 60_000;

const channelOption = (option, description = 'Channel (defaults to this channel)') =>
  option
    .setName('channel')
    .setDescription(description)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

const styleOption = (option) =>
  option
    .setName('style')
    .setDescription('How the sticky looks')
    .addChoices({ name: 'Embed', value: 'embed' }, { name: 'Plain text', value: 'text' });

const colorOption = (option) =>
  option.setName('color').setDescription('Embed color as hex, e.g. #FFAA00');

const delayOption = (option) =>
  option
    .setName('delay')
    .setDescription('Seconds of quiet before the sticky moves back to the bottom (default 5)')
    .setMinValue(STICKY_LIMITS.minDelaySec)
    .setMaxValue(STICKY_LIMITS.maxDelaySec);

const everyOption = (option) =>
  option
    .setName('every')
    .setDescription('Only move the sticky after this many new messages (default 1)')
    .setMinValue(STICKY_LIMITS.minEvery)
    .setMaxValue(STICKY_LIMITS.maxEvery);

export default {
  slashOnly: true,
  category: 'Utility',

  data: new SlashCommandBuilder()
    .setName('sticky')
    .setDescription('Keep an important message at the bottom of a channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Create (or replace) the sticky note in a channel')
        .addChannelOption(channelOption)
        .addStringOption(styleOption)
        .addStringOption(colorOption)
        .addIntegerOption(delayOption)
        .addIntegerOption(everyOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription('Edit the text of a sticky note')
        .addChannelOption(channelOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('settings')
        .setDescription('Change style, color, delay or frequency without touching the text')
        .addChannelOption(channelOption)
        .addStringOption(styleOption)
        .addStringOption(colorOption)
        .addIntegerOption(delayOption)
        .addIntegerOption(everyOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a sticky note and delete its message')
        .addChannelOption(channelOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('pause')
        .setDescription('Temporarily take a sticky note down')
        .addChannelOption(channelOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('resume')
        .setDescription('Put a paused sticky note back up')
        .addChannelOption(channelOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('refresh')
        .setDescription('Repost the sticky note right now')
        .addChannelOption(channelOption),
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Show every sticky note in this server'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('history')
        .setDescription('Show previous versions of a sticky note')
        .addChannelOption(channelOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName('restore')
        .setDescription('Restore a previous version of a sticky note')
        .addIntegerOption((option) =>
          option
            .setName('version')
            .setDescription('Version number from /sticky history')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(STICKY_LIMITS.historySize),
        )
        .addChannelOption(channelOption),
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        return await replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'This command can only be used in a server.',
        });
      }

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
        return await replyUserError(interaction, {
          type: ErrorTypes.PERMISSION,
          message: 'You need the **Manage Messages** permission to use this command.',
        });
      }

      const subcommand = interaction.options.getSubcommand();
      const channel = resolveChannel(interaction);
      if (subcommand !== 'list' && !channel) {
        return await replyUserError(interaction, {
          type: ErrorTypes.VALIDATION,
          message: 'Please choose a text or announcement channel.',
        });
      }

      switch (subcommand) {
        case 'set':
          return await handleSet(interaction, channel);
        case 'edit':
          return await handleEdit(interaction, channel);
        default:
          break;
      }

      const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferred) return;

      switch (subcommand) {
        case 'settings':
          return await handleSettings(interaction, channel);
        case 'remove':
          return await handleRemove(interaction, channel);
        case 'pause':
          return await handlePauseResume(interaction, channel, false);
        case 'resume':
          return await handlePauseResume(interaction, channel, true);
        case 'refresh':
          return await handleRefresh(interaction, channel);
        case 'list':
          return await handleList(interaction);
        case 'history':
          return await handleHistory(interaction, channel);
        case 'restore':
          return await handleRestore(interaction, channel);
        default:
          return await replyUserError(interaction, {
            type: ErrorTypes.VALIDATION,
            message: 'Unknown sticky action.',
          });
      }
    } catch (error) {
      return await handleCommandError(interaction, error);
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveChannel(interaction) {
  const selected = interaction.options.getChannel('channel');
  const channel = selected ?? interaction.channel;
  return isStickyChannel(channel) ? channel : null;
}

function readOptions(interaction) {
  return {
    style: interaction.options.getString('style'),
    color: interaction.options.getString('color'),
    delaySec: interaction.options.getInteger('delay'),
    everyN: interaction.options.getInteger('every'),
  };
}

/** Returns a list of permission names the bot lacks in the channel (empty = fine). */
function missingBotPermissions(interaction, channel, style = 'embed') {
  const me = interaction.guild?.members?.me;
  const perms = me ? channel.permissionsFor(me) : null;
  if (!perms) return [];

  const required = [
    [PermissionFlagsBits.ViewChannel, 'View Channel'],
    [PermissionFlagsBits.SendMessages, 'Send Messages'],
  ];
  if (style === 'embed') required.push([PermissionFlagsBits.EmbedLinks, 'Embed Links']);
  return required.filter(([flag]) => !perms.has(flag)).map(([, name]) => name);
}

function preview(text, max = 70) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function describeResult(result) {
  switch (result?.reason) {
    case 'posted':
    case 'edited':
      return null;
    case 'permissions':
      return `Saved, but I couldn't post it: I'm missing permissions in that channel (${(result.missing ?? []).join(', ') || 'Send Messages / Embed Links'}).`;
    case 'send_failed':
      return "Saved, but posting failed just now. It will retry when the next message arrives.";
    case 'channel_missing':
      return 'That channel no longer exists, so the sticky was removed.';
    default:
      return null;
  }
}

function resultEmbed(title, body, result) {
  const warning = describeResult(result);
  return warning ? warningEmbed(title, `${body}\n\n⚠️ ${warning}`) : successEmbed(title, body);
}

async function handleCommandError(interaction, error) {
  if (error instanceof StickyError) {
    const type = error.code === 'DATABASE' ? ErrorTypes.DATABASE : ErrorTypes.VALIDATION;
    return await replyUserError(interaction, { type, message: error.message });
  }
  logger.error('Sticky command error:', error);
  return await replyUserError(interaction, {
    type: ErrorTypes.UNKNOWN,
    message: 'Something went wrong while managing the sticky note.',
  });
}

/** Opens the editor modal and waits for it. Returns the submit interaction or null. */
async function promptForContent(interaction, { title, defaultTitle = '', defaultContent = '' }) {
  const modalId = `sticky_modal_${interaction.id}`;

  const titleInput = new TextInputBuilder()
    .setCustomId('sticky_title')
    .setLabel('Title (optional)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(STICKY_LIMITS.maxTitle);
  if (defaultTitle) titleInput.setValue(defaultTitle.slice(0, STICKY_LIMITS.maxTitle));

  const contentInput = new TextInputBuilder()
    .setCustomId('sticky_content')
    .setLabel('Sticky message')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(STICKY_LIMITS.maxEmbedContent);
  if (defaultContent) contentInput.setValue(defaultContent.slice(0, STICKY_LIMITS.maxEmbedContent));

  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(contentInput),
    );

  const shown = await InteractionHelper.safeShowModal(interaction, modal);
  if (!shown) return null;

  return interaction
    .awaitModalSubmit({
      filter: (i) => i.customId === modalId && i.user.id === interaction.user.id,
      time: MODAL_TIMEOUT_MS,
    })
    .catch(() => null);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function handleSet(interaction, channel) {
  const options = readOptions(interaction);

  // Validate the cheap options before opening the modal so mistakes show up immediately.
  const checked = validateStickyInput(options);
  const existing = await getSticky(interaction.client, interaction.guildId, channel.id);
  const style = checked.style ?? existing?.style ?? 'embed';

  const missing = missingBotPermissions(interaction, channel, style);
  if (missing.length > 0) {
    return await replyUserError(interaction, {
      type: ErrorTypes.PERMISSION,
      message: `I need these permissions in ${channel}: **${missing.join(', ')}**.`,
    });
  }

  const submitted = await promptForContent(interaction, {
    title: existing ? 'Replace Sticky Note' : 'New Sticky Note',
    defaultTitle: existing?.title ?? '',
    defaultContent: existing?.content ?? '',
  });
  if (!submitted) return;

  await submitted.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const { result } = await setSticky(
      interaction.client,
      interaction.guildId,
      channel.id,
      {
        ...options,
        title: submitted.fields.getTextInputValue('sticky_title'),
        content: submitted.fields.getTextInputValue('sticky_content'),
      },
      interaction.user.id,
    );

    await submitted.editReply({
      embeds: [
        resultEmbed(
          existing ? 'Sticky Note Replaced' : 'Sticky Note Created',
          `The sticky in ${channel} is set. When people chat, it moves back to the bottom after ${options.delaySec ?? existing?.delaySec ?? STICKY_LIMITS.defaultDelaySec}s of quiet.`,
          result,
        ),
      ],
    });
  } catch (error) {
    await replyToSubmitError(submitted, error);
  }
}

async function handleEdit(interaction, channel) {
  const existing = await getSticky(interaction.client, interaction.guildId, channel.id);
  if (!existing) {
    return await replyUserError(interaction, {
      type: ErrorTypes.VALIDATION,
      message: `There is no sticky note in ${channel}. Create one with \`/sticky set\`.`,
    });
  }

  const submitted = await promptForContent(interaction, {
    title: 'Edit Sticky Note',
    defaultTitle: existing.title,
    defaultContent: existing.content,
  });
  if (!submitted) return;

  await submitted.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const { result } = await editSticky(
      interaction.client,
      interaction.guildId,
      channel.id,
      {
        title: submitted.fields.getTextInputValue('sticky_title'),
        content: submitted.fields.getTextInputValue('sticky_content'),
      },
      interaction.user.id,
    );

    await submitted.editReply({
      embeds: [resultEmbed('Sticky Note Updated', `The sticky in ${channel} has been updated. The previous version was saved (see \`/sticky history\`).`, result)],
    });
  } catch (error) {
    await replyToSubmitError(submitted, error);
  }
}

async function replyToSubmitError(submitted, error) {
  let message = 'Something went wrong while saving the sticky note.';
  if (error instanceof StickyError) {
    message = error.message;
  } else {
    logger.error('Sticky modal submit error:', error);
  }
  await submitted
    .editReply({ embeds: [warningEmbed('Sticky Note Not Saved', message)] })
    .catch(() => {});
}

async function handleSettings(interaction, channel) {
  const options = readOptions(interaction);
  if (Object.values(options).every((value) => value === null)) {
    return await InteractionHelper.safeEditReply(interaction, {
      embeds: [infoEmbed('Nothing To Change', 'Pick at least one of: style, color, delay, every.')],
    });
  }

  const { result } = await updateStickySettings(
    interaction.client,
    interaction.guildId,
    channel.id,
    options,
    interaction.user.id,
  );

  return await InteractionHelper.safeEditReply(interaction, {
    embeds: [resultEmbed('Sticky Settings Updated', `Settings for the sticky in ${channel} were saved.`, result)],
  });
}

async function handleRemove(interaction, channel) {
  const removed = await removeSticky(interaction.client, interaction.guildId, channel.id);
  if (!removed) {
    return await InteractionHelper.safeEditReply(interaction, {
      embeds: [infoEmbed('No Sticky Note', `There is no sticky note in ${channel}.`)],
    });
  }
  return await InteractionHelper.safeEditReply(interaction, {
    embeds: [successEmbed('Sticky Note Removed', `The sticky in ${channel} was removed.`)],
  });
}

async function handlePauseResume(interaction, channel, enable) {
  const existing = await getSticky(interaction.client, interaction.guildId, channel.id);
  if (!existing) {
    return await InteractionHelper.safeEditReply(interaction, {
      embeds: [infoEmbed('No Sticky Note', `There is no sticky note in ${channel}.`)],
    });
  }
  if (existing.enabled === enable) {
    return await InteractionHelper.safeEditReply(interaction, {
      embeds: [infoEmbed(enable ? 'Already Active' : 'Already Paused', `The sticky in ${channel} is already ${enable ? 'active' : 'paused'}.`)],
    });
  }

  const { result } = await setStickyEnabled(
    interaction.client,
    interaction.guildId,
    channel.id,
    enable,
    interaction.user.id,
  );

  return await InteractionHelper.safeEditReply(interaction, {
    embeds: [
      enable
        ? resultEmbed('Sticky Note Resumed', `The sticky in ${channel} is back up.`, result)
        : successEmbed('Sticky Note Paused', `The sticky in ${channel} was taken down. Use \`/sticky resume\` to put it back.`),
    ],
  });
}

async function handleRefresh(interaction, channel) {
  const existing = await getSticky(interaction.client, interaction.guildId, channel.id);
  if (!existing) {
    return await InteractionHelper.safeEditReply(interaction, {
      embeds: [infoEmbed('No Sticky Note', `There is no sticky note in ${channel}.`)],
    });
  }
  if (!existing.enabled) {
    return await InteractionHelper.safeEditReply(interaction, {
      embeds: [infoEmbed('Sticky Note Paused', 'Resume it first with `/sticky resume`.')],
    });
  }

  const result = await repostSticky(interaction.client, interaction.guildId, channel.id, { force: true });
  return await InteractionHelper.safeEditReply(interaction, {
    embeds: [resultEmbed('Sticky Note Refreshed', `The sticky in ${channel} was reposted.`, result)],
  });
}

async function handleList(interaction) {
  const stickies = await listStickies(interaction.client, interaction.guildId);
  if (stickies.length === 0) {
    return await InteractionHelper.safeEditReply(interaction, {
      embeds: [infoEmbed('No Sticky Notes', 'This server has no sticky notes yet. Create one with `/sticky set`.')],
    });
  }

  const lines = stickies.map((sticky) => {
    const status = sticky.enabled ? '🟢' : '⏸️';
    const pace = `${sticky.style} · ${sticky.delaySec}s · every ${sticky.everyN}`;
    return `${status} <#${sticky.channelId}> — ${pace}\n> ${preview(sticky.content)}`;
  });

  return await InteractionHelper.safeEditReply(interaction, {
    embeds: [
      createEmbed({
        title: `Sticky Notes (${stickies.length}/${STICKY_LIMITS.maxPerGuild})`,
        description: lines.join('\n').slice(0, 4000),
        color: 'primary',
      }),
    ],
  });
}

async function handleHistory(interaction, channel) {
  const existing = await getSticky(interaction.client, interaction.guildId, channel.id);
  if (!existing) {
    return await InteractionHelper.safeEditReply(interaction, {
      embeds: [infoEmbed('No Sticky Note', `There is no sticky note in ${channel}.`)],
    });
  }
  if (existing.history.length === 0) {
    return await InteractionHelper.safeEditReply(interaction, {
      embeds: [infoEmbed('No History Yet', 'Previous versions appear here after the sticky is edited or replaced.')],
    });
  }

  const lines = existing.history.map((entry, index) => {
    const when = `<t:${Math.floor(entry.at / 1000)}:R>`;
    const by = entry.editedBy ? ` by <@${entry.editedBy}>` : '';
    return `**${index + 1}.** ${when}${by}\n> ${preview(entry.title ? `${entry.title} — ${entry.content}` : entry.content, 90)}`;
  });

  return await InteractionHelper.safeEditReply(interaction, {
    embeds: [
      createEmbed({
        title: `Sticky History — #${channel.name}`,
        description: `${lines.join('\n')}\n\nRestore one with \`/sticky restore version:<number>\`.`.slice(0, 4000),
        color: 'primary',
      }),
    ],
  });
}

async function handleRestore(interaction, channel) {
  const version = interaction.options.getInteger('version', true);
  const { result } = await restoreStickyVersion(
    interaction.client,
    interaction.guildId,
    channel.id,
    version,
    interaction.user.id,
  );

  return await InteractionHelper.safeEditReply(interaction, {
    embeds: [resultEmbed('Version Restored', `Version ${version} is now the sticky in ${channel}. The text it replaced was saved to history.`, result)],
  });
}
