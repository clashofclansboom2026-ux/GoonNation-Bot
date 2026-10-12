// src/commands/Utility/bump.js
//
// /bump directory:<DISBOARD|Discadia>
// Run this AFTER you have bumped on the directory yourself. It only records the
// time you tell it about and reminds you when the configured cooldown is over.
// It does not bump anything and cannot verify that a bump succeeded.

import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getDirectoryConfig, getNotificationConfig } from '../../config/bump.js';
import {
    scheduleBump,
    discordTime,
    formatRemaining,
    BumpStorageUnavailableError,
} from '../../services/bumpReminderService.js';

function describeDelivery() {
    const { mode, channelId, roleId } = getNotificationConfig();
    if (mode === 'dm') {
        return "I'll send you a DM when it's time (if your DMs are closed I'll post in this channel and mention only you).";
    }
    const target = roleId ? `<#${channelId}> and ping <@&${roleId}>` : `<#${channelId}>`;
    return mode === 'channel'
        ? `I'll post in ${target} when it's time.`
        : `I'll DM you and post in ${target} when it's time.`;
}

export default {
    data: new SlashCommandBuilder()
        .setName('bump')
        .setDescription('Log a directory bump you just did and get reminded when you can bump again.')
        .setDMPermission(false)
        .addStringOption((option) =>
            option
                .setName('directory')
                .setDescription('The directory you just bumped on')
                .setRequired(true)
                .addChoices(
                    { name: 'DISBOARD', value: 'disboard' },
                    { name: 'Discadia', value: 'discadia' },
                ),
        ),
    category: 'Utility',

    async execute(interaction) {
        const directoryKey = interaction.options.getString('directory');
        const directory = getDirectoryConfig(directoryKey);

        if (!directory) {
            await InteractionHelper.safeReply(interaction, {
                embeds: [errorEmbed(
                    'Unknown directory',
                    'Pick DISBOARD or Discadia, for example: `/bump directory:DISBOARD`',
                )],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (!interaction.guildId) {
            await InteractionHelper.safeReply(interaction, {
                embeds: [errorEmbed('Server only', 'Use `/bump` inside a server.')],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (directory.cooldownMs === null) {
            const reason = directory.problem === 'invalid'
                ? `\`${directory.cooldownEnv}\` is set to something that is not a valid number of minutes.`
                : `\`${directory.cooldownEnv}\` has not been set.`;
            await InteractionHelper.safeReply(interaction, {
                embeds: [errorEmbed(
                    `${directory.label} cooldown not configured`,
                    `${reason}\nThe bot owner needs to enter the current ${directory.label} cooldown (in minutes) in the bot's Railway variables. No reminder was scheduled.`,
                )],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        let result;
        try {
            result = await scheduleBump({
                guildId: interaction.guildId,
                channelId: interaction.channelId ?? interaction.channel?.id ?? null,
                userId: interaction.user.id,
                directoryKey: directory.key,
            });
        } catch (error) {
            if (error instanceof BumpStorageUnavailableError) {
                await InteractionHelper.safeReply(interaction, {
                    embeds: [errorEmbed(
                        'Database unavailable',
                        'I could not store the timer because the database is not connected. Nothing was scheduled. Please try again later.',
                    )],
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }
            throw error;
        }

        if (!result.created) {
            if (!result.existing) {
                // Rare race: the timer ended between the two database calls. Ask them to retry.
                await InteractionHelper.safeReply(interaction, {
                    embeds: [warningEmbed('Please try again', 'The timer just changed. Run the command once more.')],
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const remainingMs = result.existing.remindAt.getTime() - Date.now();
            await InteractionHelper.safeReply(interaction, {
                embeds: [warningEmbed(
                    `${directory.label} timer already running`,
                    [
                        `Remaining: **${formatRemaining(remainingMs)}**`,
                        `Next bump: ${discordTime(result.existing.remindAt, 'F')} (${discordTime(result.existing.remindAt, 'R')})`,
                        `Logged by <@${result.existing.userId}>`,
                        '',
                        'No new timer was created.',
                    ].join('\n'),
                )],
                allowedMentions: { parse: [] },
            });
            return;
        }

        const { bump } = result;
        await InteractionHelper.safeReply(interaction, {
            embeds: [successEmbed(
                `${directory.label} bump logged`,
                [
                    `Recorded as bumped ${discordTime(bump.bumpedAt, 'R')}.`,
                    `Next bump available: ${discordTime(bump.remindAt, 'F')} (${discordTime(bump.remindAt, 'R')})`,
                    '',
                    describeDelivery(),
                    '_I only record the time you tell me; I can\'t check that the bump actually worked._',
                ].join('\n'),
            )],
            allowedMentions: { parse: [] },
        });

        logger.info(`Bump logged: guild ${interaction.guildId}, ${directory.key}, user ${interaction.user.id}`);
    },
};
