import { Events } from 'discord.js';
import { resumeAutoDelete } from '../services/autoDeleteService.js';

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    await resumeAutoDelete(client);
  },
};
