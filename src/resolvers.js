"use strict";
/**
 * Resolves a playable direct audio-stream URL (+ subtitles when available)
 * for a YouTube video, trying multiple independent backends in order and
 * automatically falling back to the next one if a backend fails or times
 * out. This is what actually answers "how do we turn a YouTube link into
 * a URL mpv can play right now":
 *
 *   1. yt-dlp   - the existing binary-based extractor (src/youtube.js).
 *                 Most complete (also gets subtitles in the same call),
 *                 most actively maintained against YouTube's changes, but
 *                 pays subprocess-spawn overhead and is the one YouTube
 *                 rate-limits (429) most aggressively under heavy use.
 *   2. play-dl  - pure Node.js library (npm), no external binary at all.
 *                 Talks to YouTube's internal player API directly from
 *                 the same process. Usually faster per-call than spawning
 *                 yt-dlp, and is a *separate* code path/IP-request pattern
 *                 from yt-dlp, so it isn't affected by yt-dlp specifically
 *                 getting throttled. No subtitle support here (falls back
 *                 to empty subMap - subtitles are best-effort anyway).
 *   3. Piped    - REST API against public Piped instances (piped.video
 *                 and friends). Zero dependency, zero binary - just an
 *                 HTTP GET - so it's the lightest and often the fastest
 *                 when an instance is healthy, but reliability depends
 *                 entirely on a third-party instance being up, which
 *                 varies a lot. Several instances are tried in order.
 *
 * Order and which backends are enabled at all are configurable via
 * config.json's `resolver_order` (see config.js) so this can be tuned per
 * deployment without touching code - e.g. disable Piped entirely, or put
 * play-dl first once someone's benchmark (scripts/benchmark-resolvers.js)
 * shows it's the fastest/most reliable for their network.
 */
const youtube = require("./youtube");

const DEFAULT_ORDER = ["ytdlp", "play-dl", "piped"];

// Static fallback list, used only if the live instance list below can't be
// fetched at all (e.g. offline, or piped-instances.kavin.rocks itself down).
// Kept short and known-common; the live list is what actually matters.
const PIPED_INSTANCES_FALLBACK = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.private.coffee",
  "https://pipedapi.reallyaweso.me",
];
// https://piped-instances.kavin.rocks/ is a community-maintained JSON list
// of currently-known Piped instances with live uptime stats. Piped
// instances individually come and go / rate-limit constantly (this is a
// known characteristic of the project, confirmed by real-world testing:
// all 4 of the hardcoded instances above were unreachable in one run), so
// pulling the CURRENT list at request time and sorting by uptime gives a
// much better hit rate than any small hardcoded set ever could. Cached
// briefly so we're not hitting this meta-API on every single song.
const PIPED_INSTANCE_LIST_URL = "https://piped-instances.kavin.rocks/";
const PIPED_INSTANCE_LIST_TTL_MS = 30 * 60 * 1000; // 30 min
const PIPED_TIMEOUT_MS = 8000;
const PIPED_MAX_INSTANCES_TRIED = 6;

let _pipedInstanceCache = null; // { list: string[], fetchedAt: number }

async function getPipedInstances() {
  const now = Date.now();
  if (_pipedInstanceCache && now - _pipedInstanceCache.fetchedAt < PIPED_INSTANCE_LIST_TTL_MS) {
    return _pipedInstanceCache.list;
  }
  try {
    const resp = await fetch(PIPED_INSTANCE_LIST_URL, {
      headers: { "User-Agent": "KanaeDesktop-Resolver" },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    // Each entry looks like: [name, api_url, locations, cdn, ...uptime stats].
    // Sort by the 90-day uptime figure (index varies by schema version, so
    // read it defensively) - healthiest instances first.
    const withUrls = (Array.isArray(data) ? data : [])
      .map((entry) => {
        if (Array.isArray(entry)) return { url: entry[1], uptime: typeof entry[4] === "number" ? entry[4] : 0 };
        if (entry && typeof entry === "object") return { url: entry.api_url, uptime: entry.uptime90d || entry.uptime || 0 };
        return null;
      })
      .filter((e) => e && typeof e.url === "string" && e.url.startsWith("http"));
    withUrls.sort((a, b) => b.uptime - a.uptime);
    const list = withUrls.slice(0, PIPED_MAX_INSTANCES_TRIED).map((e) => e.url.replace(/\/$/, ""));
    if (list.length) {
      _pipedInstanceCache = { list, fetchedAt: now };
      return list;
    }
    throw new Error("daftar instance kosong/format tidak dikenali");
  } catch (e) {
    console.warn(`[Resolver] Gagal ambil daftar instance Piped live (${e.message}) - pakai daftar cadangan.`);
    return PIPED_INSTANCES_FALLBACK;
  }
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const shortsMatch = u.pathname.match(/\/shorts\/([^/?]+)/);
    if (shortsMatch) return shortsMatch[1];
    const embedMatch = u.pathname.match(/\/embed\/([^/?]+)/);
    if (embedMatch) return embedMatch[1];
    return null;
  } catch (e) {
    // not a full URL (e.g. bare video ID was passed) - accept 11-char IDs as-is
    return /^[\w-]{11}$/.test(url) ? url : null;
  }
}

/** Backend 1: yt-dlp (existing binary-based path, unchanged - see youtube.js). */
async function resolveViaYtdlp(url) {
  const { streamUrl, subMap, info } = await youtube.resolvePlayback(url);
  return { streamUrl, subMap, title: info?.title, durationSec: info?.duration, source: "ytdlp" };
}

/**
 * Backend 2: play-dl - pure JS, no binary/subprocess needed.
 *
 * Tries video_info() first (deciphers signed URLs itself), and if that
 * comes back with no directly-playable format (observed in practice on
 * some older/edge-case videos - e.g. very early YouTube uploads that only
 * expose legacy/combined formats play-dl's format list doesn't surface the
 * same way), falls back to play.stream(), which goes through play-dl's
 * separate demuxer-based path and can succeed in some cases video_info()
 * doesn't handle.
 */
async function resolveViaPlayDl(url) {
  let play;
  try {
    play = require("play-dl");
  } catch (e) {
    throw new Error("play-dl belum terinstall (npm install play-dl)");
  }

  const info = await play.video_info(url);
  const formats = (info.format || []).filter((f) => f && f.url);

  if (formats.length) {
    // Prefer audio-only formats (no video track) with the highest bitrate.
    const audioOnly = formats.filter((f) => f.mimeType && f.mimeType.startsWith("audio/"));
    const pool = audioOnly.length ? audioOnly : formats;
    pool.sort((a, b) => (b.bitrate || b.averageBitrate || 0) - (a.bitrate || a.averageBitrate || 0));
    const best = pool[0];
    return {
      streamUrl: best.url,
      subMap: {}, // play-dl doesn't expose captions - subtitles are best-effort anyway
      title: info.video_details?.title,
      durationSec: info.video_details?.durationInSec,
      source: "play-dl",
    };
  }

  // Fallback path: video_info() had nothing playable - try play.stream()
  // instead, which resolves the format internally rather than handing back
  // a format list for us to pick from.
  try {
    const streamed = await play.stream(url);
    if (streamed && streamed.url) {
      return {
        streamUrl: streamed.url,
        subMap: {},
        title: info.video_details?.title,
        durationSec: info.video_details?.durationInSec,
        source: "play-dl(stream)",
      };
    }
  } catch (e) {
    throw new Error(`play-dl: tidak ada format yang bisa diputar (video_info kosong, stream() juga gagal: ${e.message})`);
  }
  throw new Error("play-dl: tidak ada format yang bisa diputar (video_info dan stream() sama-sama kosong)");
}

/** Backend 3: Piped public REST API - zero binary, zero library dependency. */
async function resolveViaPiped(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error("Piped: tidak bisa mengambil video ID dari URL");

  const instances = await getPipedInstances();
  const errors = [];
  for (const instance of instances) {
    try {
      const resp = await fetch(`${instance}/streams/${videoId}`, {
        headers: { "User-Agent": "KanaeDesktop-Resolver" },
        signal: AbortSignal.timeout(PIPED_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const audioStreams = (data.audioStreams || []).filter((s) => s && s.url);
      if (!audioStreams.length) throw new Error("tidak ada audioStreams di response");
      audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      return {
        streamUrl: audioStreams[0].url,
        subMap: {}, // Piped exposes subtitles too, but kept out of scope here (best-effort feature)
        title: data.title,
        durationSec: data.duration,
        source: `piped(${new URL(instance).hostname})`,
      };
    } catch (e) {
      errors.push(`${new URL(instance).hostname}: ${e.message}`);
    }
  }
  throw new Error(`semua instance Piped gagal (${instances.length} dicoba) - ${errors.join("; ")}`);
}


const BACKENDS = { ytdlp: resolveViaYtdlp, "play-dl": resolveViaPlayDl, piped: resolveViaPiped };

/**
 * Tries each backend in `order` until one succeeds. Logs a line per
 * attempt (backend, elapsed ms, ok/fail+reason) so failures - especially
 * rate-limit ones - are visible in the terminal instead of silently
 * falling through. Throws only if every backend in the list failed.
 *
 * `backends` (optional) overrides the {name: fn} map to use - defaults to
 * the real BACKENDS above. This exists mainly so tests can inject mocks
 * without needing to hit the network at all.
 */
async function resolvePlaybackWithFallback(url, { order, backends } = {}) {
  const map = backends || BACKENDS;
  const chain = (order && order.length ? order : DEFAULT_ORDER).filter((name) => map[name]);
  const attempts = [];

  for (const name of chain) {
    const t0 = Date.now();
    try {
      const result = await map[name](url);
      const ms = Date.now() - t0;
      console.log(`[Resolver] ${name} berhasil dalam ${ms}ms`);
      attempts.push({ backend: name, ok: true, ms });
      return { ...result, resolveMs: ms, attempts };
    } catch (e) {
      const ms = Date.now() - t0;
      const rateLimited = /429|too many requests/i.test(e.message || "");
      console.warn(`[Resolver] ${name} gagal setelah ${ms}ms${rateLimited ? " (KENA RATE LIMIT 429)" : ""}: ${e.message}`);
      attempts.push({ backend: name, ok: false, ms, error: e.message, rateLimited });
    }
  }

  const summary = attempts.map((a) => `${a.backend}(${a.ms}ms): ${a.error}`).join(" | ");
  throw new Error(`Semua metode resolusi gagal - ${summary}`);
}

module.exports = {
  resolvePlaybackWithFallback,
  resolveViaYtdlp,
  resolveViaPlayDl,
  resolveViaPiped,
  extractVideoId,
  getPipedInstances,
  DEFAULT_ORDER,
  PIPED_INSTANCES_FALLBACK,
};
