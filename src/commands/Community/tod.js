import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import {
  pickPrompt,
  addPrompt,
  removePrompt,
  listPrompts,
} from '../../services/safetyService.js';

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

const TYPE_CHOICES = [
  { name: 'Truth', value: 'truth' },
  { name: 'Dare', value: 'dare' },
];
const LEVEL_CHOICES = [
  { name: 'Mild', value: 'mild' },
  { name: 'Spicy (18+ channels only)', value: 'spicy' },
  { name: 'Wild (18+ channels only)', value: 'wild' },
];

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export default {
  data: new SlashCommandBuilder()
    .setName('tod')
    .setDescription('Truth or dare with spice levels')
    .addSubcommand((sub) =>
      sub
        .setName('play')
        .setDescription('Get a truth or a dare')
        .addStringOption((opt) =>
          opt.setName('type').setDescription('Truth or dare').addChoices(...TYPE_CHOICES).setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('level').setDescription('How spicy').addChoices(...LEVEL_CHOICES).setRequired(true)
        )
        .addUserOption((opt) =>
          opt.setName('member').setDescription('Who is it for? (optional)')
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Admins: add your own prompt')
        .addStringOption((opt) =>
          opt.setName('type').setDescription('Truth or dare').addChoices(...TYPE_CHOICES).setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('level').setDescription('How spicy').addChoices(...LEVEL_CHOICES).setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('text').setDescription('The prompt').setMaxLength(300).setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Admins: remove one of your custom prompts')
        .addIntegerOption((opt) =>
          opt.setName('id').setDescription('Prompt number from /tod list').setMinValue(1).setRequired(true)
        )
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Admins: list your custom prompts')),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply(ephemeral('This command only works in a server.'));
    }

    const client = interaction.client;
    const guildId = interaction.guild.id;
    const sub = interaction.options.getSubcommand();

    if (sub === 'play') {
      const type = interaction.options.getString('type');
      const level = interaction.options.getString('level');
      const member = interaction.options.getUser('member');

      const channel = interaction.channel;
      const ageRestricted = Boolean(channel?.nsfw ?? channel?.parent?.nsfw);
      if (level !== 'mild' && !ageRestricted) {
        return interaction.reply(
          ephemeral('Spicy and wild prompts only work in age-restricted channels. Try mild here.')
        );
      }

      const prompt = await pickPrompt(client, guildId, type, level);
      if (!prompt) {
        return interaction.reply(
          ephemeral(`There are no ${level} ${type} prompts yet. An admin can add some with /tod add.`)
        );
      }

      const isTruth = type === 'truth';
      const embed = new EmbedBuilder()
        .setColor(isTruth ? 0x3498db : 0xe74c3c)
        .setTitle(`${isTruth ? '🫣 Truth' : '😈 Dare'} · ${capitalize(level)}`)
        .setDescription(prompt.text);

      return interaction.reply({
        content: member ? `${member}, you're up!` : undefined,
        embeds: [embed],
        allowedMentions: member ? { users: [member.id] } : { parse: [] },
      });
    }

    // Everything below is admin-only
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply(ephemeral('Only admins can manage prompts.'));
    }

    if (sub === 'add') {
      const type = interaction.options.getString('type');
      const level = interaction.options.getString('level');
      const text = interaction.options.getString('text').trim();
      const id = await addPrompt(client, guildId, type, level, text);
      return interaction.reply(ephemeral(`Added ${level} ${type} #${id}.`));
    }

    if (sub === 'remove') {
      const id = interaction.options.getInteger('id');
      const removed = await removePrompt(client, guildId, id);
      return interaction.reply(ephemeral(removed ? `Removed prompt #${id}.` : `No custom prompt with number ${id}.`));
    }

    if (sub === 'list') {
      const prompts = await listPrompts(client, guildId);
      if (prompts.length === 0) {
        return interaction.reply(ephemeral('You have no custom prompts yet. Add some with /tod add.'));
      }
      let output = prompts.map((p) => `#${p.id} [${p.type}/${p.level}] ${p.text}`).join('\n');
      if (output.length > 1800) output = `${output.slice(0, 1800)}\n…`;
      return interaction.reply(ephemeral(output));
    }
  },
};
