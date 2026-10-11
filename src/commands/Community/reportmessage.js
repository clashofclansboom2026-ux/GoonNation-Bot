import { ContextMenuCommandBuilder, ApplicationCommandType } from 'discord.js';
import { REPORT_COMMAND_NAME } from '../../services/safetyService.js';

// Right-click (or long-press) a message -> Apps -> "Report Message".
// The actual handling lives in src/events/safetyInteractions.js.
export default {
  data: new ContextMenuCommandBuilder()
    .setName(REPORT_COMMAND_NAME)
    .setType(ApplicationCommandType.Message),

  async execute() {
    // Handled by safetyInteractions.js
  },
};
