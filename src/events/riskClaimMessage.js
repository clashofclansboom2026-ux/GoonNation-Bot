import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  Events,
  MessageFlags,
} from 'discord.js';
import { logger } from '../utils/logger.js';
import { CLAIM_BUTTON_ID, getRiskConfig, getImageAttachments } from '../services/riskService.js';

const NO_PINGS = { parse: [] };

export default {
  name: Events.MessageCreate,
  async execute(message) {
    if (!message.guild) return;
    if (message.author.id === message.client.user.id) return;

    const config = await getRiskConfig(message.client, message.guild.id);
    if (!config || message.channelId !== config.spawnChannelId) return;

    const images = getImageAttachments(message);
    if (images.length === 0) return;

    await startClaim(message, config, images);
  },
};

async function startClaim(message, config, images) {
  const seconds = config.seconds;
  const expiresAt = Math.floor(Date.now() / 1000) + seconds;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CLAIM_BUTTON_ID)
      .setLabel('Claim')
      .setEmoji('🎯')
      .setStyle(ButtonStyle.Success)
  );

  let claimMessage;
  try {
    claimMessage = await message.channel.send({
      content: `New image from ${message.author}! First to click **Claim** wins. Expires <t:${expiresAt}:R>`,
      components: [row],
      allowedMentions: NO_PINGS,
    });
  } catch (error) {
    logger.warn(`Risk: could not post claim message: ${error.message}`);
    return;
  }

  let claimed = false;

  const collector = claimMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: seconds * 1000,
  });

  collector.on('collect', async (interaction) => {
    if (interaction.customId !== CLAIM_BUTTON_ID) return;

    if (claimed) {
      await interaction
        .reply({ content: 'Too slow, someone already claimed this one!', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }

    if (interaction.user.id === message.author.id) {
      await interaction
        .reply({ content: "You can't claim your own image.", flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }

    // Set before any await so two near-simultaneous clicks can't both win
    claimed = true;
    collector.stop('claimed');
    await interaction.deferUpdate().catch(() => {});

    try {
      await completeClaim({ message, claimMessage, config, images, claimer: interaction.user });
    } catch (error) {
      logger.error('Risk: error while completing claim:', error);
    }
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'claimed') return;

    // Nobody claimed it in time
    await message.delete().catch(() => {});
    await claimMessage.delete().catch(() => {});
  });
}

async function completeClaim({ message, claimMessage, config, images, claimer }) {
  const caught = await message.guild.channels.fetch(config.caughtChannelId).catch(() => null);

  if (!caught?.isTextBased()) {
    await claimMessage
      .edit({
        content: 'Claimed, but the caught channel is missing. An admin needs to run /risk setup again.',
        components: [],
      })
      .catch(() => {});
    return;
  }

  const header = `🎯 **Caught!** ${claimer} claimed an image posted by ${message.author}`;
  let posted = false;

  try {
    // Re-upload the file itself so it still works after the original is deleted
    const files = await Promise.all(
      images.map(async (attachment) => {
        const response = await fetch(attachment.url);
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        const buffer = Buffer.from(await response.arrayBuffer());
        return new AttachmentBuilder(buffer, { name: attachment.name ?? 'image.png' });
      })
    );
    await caught.send({ content: header, files, allowedMentions: NO_PINGS });
    posted = true;
  } catch (error) {
    logger.warn(`Risk: re-upload failed (${error.message}), falling back to links`);
    try {
      await caught.send({
        content: `${header}\n${images.map((a) => a.url).join('\n')}`,
        allowedMentions: NO_PINGS,
      });
      posted = true;
    } catch (fallbackError) {
      logger.error(`Risk: could not post in caught channel: ${fallbackError.message}`);
    }
  }

  if (!posted) {
    await claimMessage
      .edit({
        content: "Claimed, but I couldn't post it in the caught channel. Check my permissions there.",
        components: [],
      })
      .catch(() => {});
    return;
  }

  await claimMessage
    .edit({ content: `✅ ${claimer} caught it! Posted in ${caught}.`, components: [], allowedMentions: NO_PINGS })
    .catch(() => {});
  await message.delete().catch(() => {});
  setTimeout(() => claimMessage.delete().catch(() => {}), 5000);
}
