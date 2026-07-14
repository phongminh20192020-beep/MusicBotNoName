"use strict";

const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const { searchTrack: lastfmSearch } = require("../utils/lastfm");

const MAX_TRACKS = 300;

/** Parse one CSV line into fields, handling quoted commas (RFC4180-ish). */
function parseCSVLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map(f => f.trim());
}

/**
 * Parse either an Exportify-style CSV (has "Track Name" / "Artist Name(s)"
 * columns) or a plain pasted list (one track per line, e.g. from Chosic, or
 * typed by hand) into an array of search query strings like "Artist Title".
 */
function parseTrackList(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const header    = parseCSVLine(lines[0]).map(h => h.toLowerCase());
  const nameIdx   = header.findIndex(h => h.includes("track name"));
  const artistIdx = header.findIndex(h => h.includes("artist name"));

  if (nameIdx !== -1 && artistIdx !== -1) {
    return lines.slice(1)
      .map(line => {
        const fields = parseCSVLine(line);
        const name   = fields[nameIdx] || "";
        const artist = (fields[artistIdx] || "").split(";")[0]; // first artist if multiple
        return `${artist} ${name}`.trim();
      })
      .filter(Boolean);
  }

  // Plain pasted list — strip common leading list markers ("1.", "1)", "- ", "• ")
  return lines
    .map(line => line.replace(/^\s*\d+[.)]\s*/, "").replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("import")
    .setDescription("Import a track list (pasted text or a .csv/.txt file) and queue them all")
    .addStringOption(o =>
      o.setName("list").setDescription("Paste track lines, one per line (e.g. exported from Chosic)").setRequired(false)
    )
    .addAttachmentOption(o =>
      o.setName("file").setDescription("Upload a .csv/.txt track list (e.g. an Exportify export)").setRequired(false)
    ),

  async execute(interaction, client) {
    await interaction.deferReply();

    const voiceChannel = interaction.member.voice?.channel;
    if (!voiceChannel)
      return interaction.editReply("You must be in a voice channel.");

    const perms = voiceChannel.permissionsFor(interaction.guild.members.me);
    if (!perms.has("Connect") || !perms.has("Speak"))
      return interaction.editReply("I need permission to join and speak in your channel.");

    const listText = interaction.options.getString("list");
    const file      = interaction.options.getAttachment("file");

    if (!listText && !file)
      return interaction.editReply("❌ Provide either `list` (pasted text) or `file` (a .csv/.txt upload).");

    let rawText = listText || "";
    if (file) {
      if (file.size > 2 * 1024 * 1024)
        return interaction.editReply("❌ That file is too large (max 2 MB).");
      try {
        const res = await fetch(file.url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`status ${res.status}`);
        rawText = await res.text();
      } catch (err) {
        console.error("[Import] file fetch error:", err.message);
        return interaction.editReply("❌ Couldn't download that file.");
      }
    }

    let queries = parseTrackList(rawText);
    if (!queries.length)
      return interaction.editReply("❌ Couldn't find any tracks in that list.");

    let truncated = false;
    if (queries.length > MAX_TRACKS) {
      queries = queries.slice(0, MAX_TRACKS);
      truncated = true;
    }

    let player  = client.lavalink.getPlayer(interaction.guildId);
    const isNew = !player;

    if (!player) {
      player = client.lavalink.createPlayer({
        guildId:        interaction.guildId,
        voiceChannelId: voiceChannel.id,
        textChannelId:  interaction.channelId,
        selfDeaf:       true,
        selfMute:       false,
      });
    }

    if (!player.connected) {
      await player.connect();
      if (isNew) await new Promise(r => setTimeout(r, 1000));
    }

    if (player.get("afk")) {
      await player.stopPlaying(true).catch(() => {});
      player.set("afk", false);
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff0000)
          .setTitle("⏳ Importing Track List...")
          .setDescription(
            `Found **${queries.length}** track${queries.length !== 1 ? "s" : ""}.` +
            (truncated ? `\n⚠️ Limited to the first ${MAX_TRACKS}.` : "") +
            `\nSearching and queuing — playback starts as soon as the first track is ready.`
          ),
      ],
    });

    (async () => {
      let added = 0;
      const failed = [];

      for (const query of queries) {
        try {
          let ytQuery = query;
          const lastfmMatch = await lastfmSearch(query);
          if (lastfmMatch) ytQuery = `${lastfmMatch.artist} ${lastfmMatch.title}`.trim();

          let res = await player.search({ query: ytQuery, source: "ytmsearch" }, interaction.user);
          if ((!res?.tracks?.length || res.loadType === "empty" || res.loadType === "error") && lastfmMatch) {
            res = await player.search({ query, source: "ytmsearch" }, interaction.user);
          }

          if (res?.tracks?.[0]) {
            player.queue.add(res.tracks[0]);
            added++;
            if (added === 1 && !player.playing && !player.paused)
              await player.play().catch(err => console.error("[Import] initial play() error:", err.message));
          } else {
            failed.push(query);
          }
        } catch (err) {
          console.warn(`[Import] Skipped "${query}":`, err.message);
          failed.push(query);
        }
      }

      console.log(`[Import] Queued ${added}/${queries.length} tracks`);

      const summary = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle("✅ Import Complete")
        .setDescription(`Added **${added}/${queries.length}** tracks to the queue.`);

      if (failed.length) {
        const preview = failed.slice(0, 10).map(f => `• ${f}`).join("\n");
        summary.addFields({
          name: `Couldn't find (${failed.length})`,
          value: preview + (failed.length > 10 ? `\n…and ${failed.length - 10} more` : ""),
        });
      }

      interaction.editReply({ embeds: [summary] }).catch(() => {});
    })();
  },
};
