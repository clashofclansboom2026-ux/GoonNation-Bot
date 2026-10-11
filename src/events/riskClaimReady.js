import { Events } from 'discord.js';
import { cleanupAfterRestart } from '../services/riskService.js';

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    await cleanupAfterRestart(client);
  },
};
