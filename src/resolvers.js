"use strict";

/**
 * KanaeDesktop playback resolvers.
 *
 * IMPORTANT:
 * yt-dlp TIDAK lagi menyerahkan direct googlevideo.com URL ke mpv.
 *
 * yt-dlp backend sekarang mengembalikan:
 *
 * {
 *   playbackMode: "ytdlp-pipe",
 *   playbackUrl: original YouTube URL
 * }
 *
 * sehingga mpv.js dapat menjalankan:
 *
 *   yt-dlp ... -o -
 *          |
 *          +---- stdout ----> mpv stdin
 *
 * Ini menghindari HTTP 403 yang terjadi ketika direct GVS URL
 * hasil extractor dipakai ulang oleh mpv/FFmpeg.
 */

const youtube = require("./youtube");

const DEFAULT_ORDER = [
  "ytdlp",
  "play-dl",
  "piped",
];

// ─────────────────────────────────────────────
// PIPED
// ─────────────────────────────────────────────

const PIPED_INSTANCES_FALLBACK = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.private.coffee",
  "https://pipedapi.reallyaweso.me",
];

const PIPED_INSTANCE_LIST_URL =
  "https://piped-instances.kavin.rocks/";

const PIPED_INSTANCE_LIST_TTL_MS =
  30 * 60 * 1000;

const PIPED_TIMEOUT_MS = 8000;

const PIPED_MAX_INSTANCES_TRIED = 6;

let _pipedInstanceCache = null;

async function getPipedInstances() {
  const now = Date.now();

  if (
    _pipedInstanceCache &&
    now - _pipedInstanceCache.fetchedAt <
      PIPED_INSTANCE_LIST_TTL_MS
  ) {
    return _pipedInstanceCache.list;
  }

  try {
    const resp = await fetch(
      PIPED_INSTANCE_LIST_URL,
      {
        headers: {
          "User-Agent":
            "KanaeDesktop-Resolver",
        },
        signal:
          AbortSignal.timeout(6000),
      }
    );

    if (!resp.ok) {
      throw new Error(
        `HTTP ${resp.status}`
      );
    }

    const data = await resp.json();

    const withUrls = (
      Array.isArray(data)
        ? data
        : []
    )
      .map((entry) => {
        if (Array.isArray(entry)) {
          return {
            url: entry[1],
            uptime:
              typeof entry[4] ===
              "number"
                ? entry[4]
                : 0,
          };
        }

        if (
          entry &&
          typeof entry === "object"
        ) {
          return {
            url: entry.api_url,
            uptime:
              entry.uptime90d ||
              entry.uptime ||
              0,
          };
        }

        return null;
      })
      .filter(
        (e) =>
          e &&
          typeof e.url === "string" &&
          e.url.startsWith("http")
      );

    withUrls.sort(
      (a, b) =>
        b.uptime - a.uptime
    );

    const list = withUrls
      .slice(
        0,
        PIPED_MAX_INSTANCES_TRIED
      )
      .map((e) =>
        e.url.replace(/\/$/, "")
      );

    if (!list.length) {
      throw new Error(
        "daftar instance kosong/format tidak dikenali"
      );
    }

    _pipedInstanceCache = {
      list,
      fetchedAt: now,
    };

    return list;

  } catch (e) {
    console.warn(
      `[Resolver] Gagal ambil daftar instance Piped live (${e.message}) - pakai daftar cadangan.`
    );

    return PIPED_INSTANCES_FALLBACK;
  }
}

// ─────────────────────────────────────────────
// VIDEO ID
// ─────────────────────────────────────────────

function extractVideoId(url) {
  try {
    const u = new URL(url);

    if (
      u.hostname ===
      "youtu.be"
    ) {
      return (
        u.pathname
          .slice(1)
          .split("/")[0] ||
        null
      );
    }

    if (u.searchParams.get("v")) {
      return u.searchParams.get(
        "v"
      );
    }

    const shortsMatch =
      u.pathname.match(
        /\/shorts\/([^/?]+)/
      );

    if (shortsMatch) {
      return shortsMatch[1];
    }

    const embedMatch =
      u.pathname.match(
        /\/embed\/([^/?]+)/
      );

    if (embedMatch) {
      return embedMatch[1];
    }

    return null;

  } catch (e) {
    return /^[\w-]{11}$/.test(url)
      ? url
      : null;
  }
}

// ─────────────────────────────────────────────
// YT-DLP
// ─────────────────────────────────────────────

/**
 * yt-dlp resolver.
 *
 * IMPORTANT:
 * Do NOT return fmt.url.
 *
 * fmt.url is a short-lived googlevideo URL and can be
 * rejected with HTTP 403 when opened by another HTTP
 * client/process.
 *
 * Instead return the original YouTube URL and tell
 * mpv.js to use yt-dlp pipe mode.
 */
async function resolveViaYtdlp(url) {
  const {
    subMap,
    info,
  } = await youtube.resolvePlayback(
    url
  );

  return {
    streamUrl: null,

    // Original YouTube URL.
    playbackUrl: url,

    // Tell mpv.js how this stream must be played.
    playbackMode: "ytdlp-pipe",

    subMap,

    title: info?.title,

    durationSec:
      info?.duration,

    source: "ytdlp",
  };
}

// ─────────────────────────────────────────────
// PLAY-DL
// ─────────────────────────────────────────────

async function resolveViaPlayDl(
  url
) {
  let play;

  try {
    play = require(
      "play-dl"
    );
  } catch (e) {
    throw new Error(
      "play-dl belum terinstall (npm install play-dl)"
    );
  }

  const info =
    await play.video_info(
      url
    );

  const formats = (
    info.format || []
  ).filter(
    (f) =>
      f &&
      f.url
  );

  if (formats.length) {
    const audioOnly =
      formats.filter(
        (f) =>
          f.mimeType &&
          f.mimeType.startsWith(
            "audio/"
          )
      );

    const pool =
      audioOnly.length
        ? audioOnly
        : formats;

    pool.sort(
      (a, b) =>
        (
          b.bitrate ||
          b.averageBitrate ||
          0
        ) -
        (
          a.bitrate ||
          a.averageBitrate ||
          0
        )
    );

    const best =
      pool[0];

    return {
      streamUrl:
        best.url,

      playbackUrl: null,

      playbackMode:
        "direct",

      subMap: {},

      title:
        info.video_details
          ?.title,

      durationSec:
        info.video_details
          ?.durationInSec,

      source: "play-dl",
    };
  }

  try {
    const streamed =
      await play.stream(
        url
      );

    if (
      streamed &&
      streamed.url
    ) {
      return {
        streamUrl:
          streamed.url,

        playbackUrl: null,

        playbackMode:
          "direct",

        subMap: {},

        title:
          info.video_details
            ?.title,

        durationSec:
          info.video_details
            ?.durationInSec,

        source:
          "play-dl(stream)",
      };
    }

  } catch (e) {
    throw new Error(
      `play-dl: stream() gagal: ${e.message}`
    );
  }

  throw new Error(
    "play-dl: tidak ada format yang bisa diputar"
  );
}

// ─────────────────────────────────────────────
// PIPED
// ─────────────────────────────────────────────

async function resolveViaPiped(
  url
) {
  const videoId =
    extractVideoId(url);

  if (!videoId) {
    throw new Error(
      "Piped: tidak bisa mengambil video ID dari URL"
    );
  }

  const instances =
    await getPipedInstances();

  const errors = [];

  for (
    const instance of instances
  ) {
    try {
      const resp =
        await fetch(
          `${instance}/streams/${videoId}`,
          {
            headers: {
              "User-Agent":
                "KanaeDesktop-Resolver",
            },
            signal:
              AbortSignal.timeout(
                PIPED_TIMEOUT_MS
              ),
          }
        );

      if (!resp.ok) {
        throw new Error(
          `HTTP ${resp.status}`
        );
      }

      const data =
        await resp.json();

      const audioStreams =
        (
          data.audioStreams ||
          []
        ).filter(
          (s) =>
            s &&
            s.url
        );

      if (
        !audioStreams.length
      ) {
        throw new Error(
          "tidak ada audioStreams di response"
        );
      }

      audioStreams.sort(
        (a, b) =>
          (b.bitrate || 0) -
          (a.bitrate || 0)
      );

      return {
        streamUrl:
          audioStreams[0].url,

        playbackUrl: null,

        playbackMode:
          "direct",

        subMap: {},

        title:
          data.title,

        durationSec:
          data.duration,

        source:
          `piped(${new URL(instance).hostname})`,
      };

    } catch (e) {
      errors.push(
        `${new URL(instance).hostname}: ${e.message}`
      );
    }
  }

  throw new Error(
    `semua instance Piped gagal (${instances.length} dicoba) - ${errors.join("; ")}`
  );
}

// ─────────────────────────────────────────────
// BACKENDS
// ─────────────────────────────────────────────

const BACKENDS = {
  ytdlp:
    resolveViaYtdlp,

  "play-dl":
    resolveViaPlayDl,

  piped:
    resolveViaPiped,
};

// ─────────────────────────────────────────────
// FALLBACK
// ─────────────────────────────────────────────

async function resolvePlaybackWithFallback(
  url,
  {
    order,
    backends,
  } = {}
) {
  const map =
    backends ||
    BACKENDS;

  const chain = (
    order &&
    order.length
      ? order
      : DEFAULT_ORDER
  ).filter(
    (name) =>
      map[name]
  );

  const attempts = [];

  for (
    const name of chain
  ) {
    const t0 =
      Date.now();

    try {
      const result =
        await map[name](
          url
        );

      const ms =
        Date.now() -
        t0;

      console.log(
        `[Resolver] ${name} berhasil dalam ${ms}ms`
      );

      attempts.push({
        backend: name,
        ok: true,
        ms,
      });

      return {
        ...result,

        resolveMs: ms,

        attempts,
      };

    } catch (e) {
      const ms =
        Date.now() -
        t0;

      const rateLimited =
        /429|too many requests/i.test(
          e.message || ""
        );

      console.warn(
        `[Resolver] ${name} gagal setelah ${ms}ms${
          rateLimited
            ? " (KENA RATE LIMIT 429)"
            : ""
        }: ${e.message}`
      );

      attempts.push({
        backend: name,
        ok: false,
        ms,
        error:
          e.message,
        rateLimited,
      });
    }
  }

  const summary =
    attempts
      .map(
        (a) =>
          `${a.backend}(${a.ms}ms): ${a.error}`
      )
      .join(" | ");

  throw new Error(
    `Semua metode resolusi gagal - ${summary}`
  );
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