import { Events } from 'discord.js';
import { getAutoDeleteConfig, scheduleDelete } from '../services/autoDeleteService.js';

export default {
  name: Events.MessageCreate,
  async execute(message) {
    if (!message.guild) return;

    const config = await getAutoDeleteConfig(message.client, message.guild.id);
    const seconds = config[message.channelId];
    if (!seconds) return;

    scheduleDelete(message, seconds * 1000);
  },
};
