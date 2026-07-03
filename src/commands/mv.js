"use strict";

const { SlashCommandBuilder } = require("discord.js");
const fs = require("fs");
const path = require("path");
const mvStreamer = require("../stream/mvStreamer");

const VIDEOS_DIR = process.env.MV_VIDEOS_DIR || "./videos";

module.exports = {
  data: new SlashCommandBuilder()
    .setName("mv")
    .setDescription("Stream a music video into your voice channel")
    .addSubcommand((sub) =>
      sub
        .setName("play")
        .setDescription("Play a music video file")
        .addStringOption((opt) =>
          opt.setName("file").setDescription("Filename in the videos folder").setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand((sub) => sub.setName("stop").setDescription("Stop the current MV stream")),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    let files = [];
    try {
      files = fs.readdirSync(VIDEOS_DIR).filter((f) => /\.(mp4|mkv|webm|mov)$/i.test(f));
    } catch { /* dir may not exist yet */ }

    const filtered = files.filter((f) => f.toLowerCase().includes(focused)).slice(0, 25);
    await interaction.respond(filtered.map((f) => ({ name: f, value: f })));
  },

  async execute(interaction, client) {
    if (!mvStreamer.isReady()) {
      return interaction.reply({
        content: "MV streaming isn't configured (missing `STREAM_USER_TOKEN`). Ask the bot owner to set it up.",
        ephemeral: true,
      });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "stop") {
      await interaction.deferReply();
      await mvStreamer.stopMV();
      return interaction.editReply("⏹️ Stopped the MV stream.");
    }

    // sub === "play"
    const voiceChannel = interaction.member.voice?.channel;
    if (!voiceChannel) return interaction.reply({ content: "Join a voice channel first.", ephemeral: true });

    const filename = interaction.options.getString("file");
    const filePath = path.join(VIDEOS_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return interaction.reply({ content: `Couldn't find \`${filename}\` in the videos folder.`, ephemeral: true });
    }

    await interaction.deferReply();
    await interaction.editReply(`🎬 Starting **${filename}** in **${voiceChannel.name}**...`);

    mvStreamer.playMV(interaction.guildId, voiceChannel.id, filePath).catch((err) => {
      console.error("[mv] playMV failed:", err.message);
      interaction.followUp(`⚠️ Streaming failed: ${err.message}`).catch(() => {});
    });
  },
};
