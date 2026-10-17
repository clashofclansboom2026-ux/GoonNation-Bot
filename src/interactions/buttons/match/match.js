import { MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, warningEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { MatchError, respondToRequest } from '../../../services/roleMatch/roleMatchStore.js';
import { performJoin, performLeave, requestDm, profileLink } from '../../../services/roleMatch/roleMatchService.js';

const ACCEPT_CLEANUP_MS = 5 * 60_000;
const DECLINE_CLEANUP_MS = 2 * 60_000;

/** Replies privately to the person who clicked, whatever state the interaction is in. */
async function replyPrivately(interaction, embed) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [embed] });
    } else {
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    logger.debug('Could not reply to match button', { error: error?.message });
  }
}

/** Runs an action that may throw MatchError and shows the error nicely to the clicker. */
async function guarded(interaction, action) {
  try {
    await action();
  } catch (error) {
    if (error instanceof MatchError) {
      await replyPrivately(interaction, warningEmbed('Matcher', error.message));
      return;
    }
    throw error;
  }
}

function deleteLater(message, ms) {
  if (!message) return;
  const timer = setTimeout(() => message.delete().catch(() => {}), ms);
  timer.unref?.();
}

const joinButton = {
  name: 'match_join',
  async execute(interaction, client) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await guarded(interaction, async () => {
      const text = await performJoin(client, interaction.guild, interaction.user.id);
      await replyPrivately(interaction, successEmbed('Matcher', text));
    });
  },
};

const leaveButton = {
  name: 'match_leave',
  async execute(interaction, client) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await guarded(interaction, async () => {
      const text = await performLeave(client, interaction.guild, interaction.user.id);
      await replyPrivately(interaction, successEmbed('Matcher', text));
    });
  },
};

// "Say hi" / "Ask" buttons under /match find results. customId: match_req:<targetId>
const requestButton = {
  name: 'match_req',
  async execute(interaction, client, args) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const targetId = args?.[0];
    if (!targetId) {
      await replyPrivately(interaction, warningEmbed('Matcher', 'This button is no longer valid. Run `/match find` again.'));
      return;
    }

    await guarded(interaction, async () => {
      const result = await requestDm(client, interaction.guild, interaction.user.id, targetId);
      if (result.kind === 'direct') {
        await replyPrivately(
          interaction,
          successEmbed('DMs Open', `They have **DMs Open**, so you can message them directly: ${profileLink(targetId)}\n\nBe respectful, and stop if they ask you to.`),
        );
      } else {
        await replyPrivately(
          interaction,
          successEmbed('Request Sent', `Your request was posted in <#${result.channelId}>. They'll see it next time they're around.\n\nPlease don't send it again if they don't answer.`),
        );
      }
    });
  },
};

// Accept / Decline / Decline & block on a posted request. customId: match_ans:<requestId>:<action>
const answerButton = {
  name: 'match_ans',
  async execute(interaction, client, args) {
    const [requestId, action] = args ?? [];

    let request;
    try {
      request = await respondToRequest(client, interaction.guildId, requestId, interaction.user.id, action);
    } catch (error) {
      if (!(error instanceof MatchError)) throw error;

      // Dead requests get their buttons removed so nobody keeps clicking them.
      if (error.code === 'EXPIRED' || error.code === 'NOT_FOUND') {
        await interaction
          .update({ content: '', embeds: [createEmbed({ title: '💌 DM request', description: 'This request is closed.', color: 'info' })], components: [] })
          .catch(() => {});
        return;
      }
      await replyPrivately(interaction, warningEmbed('DM request', error.message));
      return;
    }

    const accepted = request.status === 'accepted';

    // Close the request message (no buttons, no hint about what was chosen beyond the outcome).
    await interaction
      .update({
        content: '',
        embeds: [
          createEmbed({
            title: accepted ? '💌 DM request accepted' : '💌 DM request closed',
            description: accepted ? `<@${request.to}> said yes to <@${request.from}>.` : 'This request is closed.',
            color: accepted ? 'success' : 'info',
          }),
        ],
        components: [],
      })
      .catch((error) => logger.debug('Could not update request message', { error: error?.message }));

    // Tell the requester. Declines are worded neutrally and never mention a block.
    const followUp = accepted
      ? `<@${request.from}> ✅ <@${request.to}> said yes. You can message them here: ${profileLink(request.to)}\nBe respectful, and stop if they ask you to.`
      : `<@${request.from}> they aren't available to chat right now. Please don't send this request again.`;

    const sent = await interaction.channel
      ?.send({ content: followUp, allowedMentions: { users: [request.from] } })
      .catch(() => null);

    const cleanupMs = accepted ? ACCEPT_CLEANUP_MS : DECLINE_CLEANUP_MS;
    deleteLater(sent, cleanupMs);
    deleteLater(interaction.message, cleanupMs);
  },
};

export default [joinButton, leaveButton, requestButton, answerButton];
