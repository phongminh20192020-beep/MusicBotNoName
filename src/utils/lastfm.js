"use strict";

// ─── Last.fm track search ──────────────────────────────────────────────────
// Free, key-only API (https://www.last.fm/api/account/create) — no OAuth,
// no Premium requirement, unlike Spotify's Web API since February 2026.
// Used to correct/canonicalize a plain-text search query (e.g. "believe cher"
// -> artist: "Cher", title: "Believe") before searching YouTube Music.
//
// Last.fm has no concept of Spotify playlists — it can only search its own
// track catalog. Spotify link/playlist resolution still goes through
// resolveSpotify() in helpers.js and still requires real Spotify credentials.

const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";

/**
 * Search Last.fm's track catalog for the closest match to a plain-text query.
 * Returns { title, artist, url } for the top match, or null if:
 *  - LASTFM_API_KEY isn't configured
 *  - the request fails or times out
 *  - there's no match
 * Callers should treat null as "fall back to the original query" — this is
 * a best-effort correction step, not a hard requirement.
 */
async function searchTrack(query) {
  const apiKey = process.env.LASTFM_API_KEY;
  if (!apiKey || !query?.trim()) return null;

  const url = new URL(LASTFM_API);
  url.searchParams.set("method", "track.search");
  url.searchParams.set("track", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.warn(`[Last.fm] search request failed (${res.status})`);
      return null;
    }

    const data  = await res.json();
    const match = data?.results?.trackmatches?.track?.[0];
    if (!match?.name || !match?.artist) return null;

    return { title: match.name, artist: match.artist, url: match.url || null };
  } catch (err) {
    console.warn("[Last.fm] search error:", err.message);
    return null;
  }
}

module.exports = { searchTrack };
