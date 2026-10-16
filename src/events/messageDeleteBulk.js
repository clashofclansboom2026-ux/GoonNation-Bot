import { Events } from 'discord.js';
import { handleStickyBulkDelete } from '../services/stickyService.js';

// Fires when messages are purged in bulk (e.g. /purge). If the live sticky was among them, bring it back.
export default {
  name: Events.MessageBulkDelete,
  once: false,

  async execute(messages, channel, client) {
    await handleStickyBulkDelete(messages, channel, client);
  },
};
