"use strict";
/**
 * yt-dlp helpers. The Python original used the `yt_dlp` library directly;
 * Node has no equivalent binding, so this shells out to the `yt-dlp` CLI
 * (same binary the Python lib wraps) and parses its --dump-json output,
 * which has the same field names as yt_dlp's Python `extract_info()` dict.
 * Requires yt-dlp to be installed and on PATH (or set YTDLP_PATH env var).
 *
 * search/info results are cached briefly with a small TTL cache, and
 * identical in-flight lookups are de-duplicated. yt-dlp spawns a fresh
 * Python process per call (slow, ~1-2s), so this avoids re-running it for
 * repeat/duplicate queries - e.g. several TikTok viewers requesting the
 * same song within a few minutes only triggers one yt-dlp call.
 * Stream URLs (getAudioStreamUrl) are intentionally NOT cached since they
 * expire quickly and must stay fresh.
 */
const { execFile } = require("child_process");

const YTDLP_BIN = process.env.YTDLP_PATH || "yt-dlp";

function run(args, { timeout = 30000, maxBuffer = 1024 * 1024 * 32 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_BIN, args, { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === "ENOENT") {
          return reject(new Error("yt-dlp not found on PATH. Install it: pip install yt-dlp (or see https://github.com/yt-dlp/yt-dlp)."));
        }
        return reject(new Error(stderr?.trim() || err.message));
      }
      resolve(stdout);
    });
  });
}

// ── Small TTL cache + in-flight de-duplication ───────────────────
const _cache = new Map(); // key -> { value, expiresAt }
const _inflight = new Map(); // key -> Promise
const CACHE_MAX_ENTRIES = 300;

function _cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    _cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function _cacheSet(key, value, ttlMs) {
  if (_cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = _cache.keys().next().value;
    _cache.delete(oldestKey);
  }
  _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function _cached(key, ttlMs, fn) {
  const hit = _cacheGet(key);
  if (hit !== undefined) return Promise.resolve(hit);
  if (_inflight.has(key)) return _inflight.get(key);

  const p = fn()
    .then((val) => {
      _cacheSet(key, val, ttlMs);
      _inflight.delete(key);
      return val;
    })
    .catch((err) => {
      _inflight.delete(key);
      throw err;
    });
  _inflight.set(key, p);
  return p;
}

async function searchYoutube(query, limit = 10) {
  return _cached(`search:${limit}:${query}`, 5 * 60 * 1000, () => _searchYoutubeUncached(query, limit));
}

async function _searchYoutubeUncached(query, limit) {
  const stdout = await run(["--quiet", "--no-warnings", "--flat-playlist", "-J", `ytsearch${limit}:${query}`]);
  const raw = JSON.parse(stdout);
  const entries = raw.entries || [];
  return entries
    .filter(Boolean)
    .map((e) => {
      const vidId = e.id || "";
      return {
        id: vidId,
        title: e.title || "Unknown",
        url: e.url && e.url.startsWith("http") ? e.url : `https://www.youtube.com/watch?v=${vidId}`,
        thumbnail: e.thumbnail || `https://i.ytimg.com/vi/${vidId}/hqdefault.jpg`,
        duration: e.duration ?? null,
        channel: e.channel || e.uploader || "",
        view_count: e.view_count ?? null,
      };
    });
}

async function getInfo(url) {
  return _cached(`info:${url}`, 10 * 60 * 1000, () => _getInfoUncached(url));
}

async function _getInfoUncached(url) {
  const stdout = await run(["--quiet", "--no-warnings", "--skip-download", "-J", url]);
  return JSON.parse(stdout);
}

async function getAudioStreamUrl(url) {
  const stdout = await run([
    "--quiet",
    "--no-warnings",
    "-f",
    "bestaudio[ext=m4a]/bestaudio/best",
    "-J",
    url,
  ]);
  const info = JSON.parse(stdout);
  for (const fmt of info.formats || []) {
    const hasAudio = fmt.acodec && fmt.acodec !== "none";
    const noVideo = !fmt.vcodec || fmt.vcodec === "none";
    if (hasAudio && noVideo) return fmt.url;
  }
  return info.url || info.webpage_url || url;
}

/**
 * Try getInfo() on each search result in order until one succeeds.
 * Used so that a single unplayable result (age-restricted, private,
 * region-locked, removed, etc.) doesn't fail the whole request — it
 * just falls through to the next candidate from the same search.
 * Returns { info, candidate } on success, or throws if all fail.
 */
async function findPlayableInfo(results, { maxAttempts = 5 } = {}) {
  const attempts = results.slice(0, maxAttempts);
  const failures = [];
  for (const candidate of attempts) {
    try {
      const info = await getInfo(candidate.url);
      return { info, candidate };
    } catch (e) {
      console.log(`[YouTube] Skipping unplayable result "${candidate.title}": ${e.message}`);
      failures.push({ title: candidate.title, url: candidate.url, error: e.message });
    }
  }
  const err = new Error(`All ${attempts.length} result(s) were unplayable`);
  err.failures = failures;
  throw err;
}

// User-Agent used for fetching signed subtitle URLs — without a real
// browser-like UA, YouTube sometimes returns an HTML block/consent page
// instead of the expected JSON, which fails JSON.parse with a confusing
// "Unexpected token '<'" error.
const SUBTITLE_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

/** Fetch a subtitle URL and safely parse it as JSON, with a clear error if it isn't. */
async function fetchSubtitleJson(url) {
  const resp = await fetch(url, { headers: SUBTITLE_FETCH_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!resp.ok) {
    throw new Error(`Subtitle server responded with status ${resp.status}`);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.includes("json")) {
    throw new Error(`Subtitle URL returned non-JSON response (content-type: ${contentType || "unknown"}) — likely an expired/blocked link`);
  }
  return resp.json();
}

function msToTimecode(ms) {
  const total = Math.max(0, Math.floor(ms));
  const rem = total % 1000;
  let s = Math.floor(total / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(rem, 3)}`;
}

function parseJson3Subtitle(raw) {
  const events = [];
  for (const evt of raw.events || []) {
    const segs = evt.segs;
    if (!segs) continue;
    const text = segs.map((seg) => seg.utf8 || "").join("").trim();
    if (text) {
      events.push({
        start_ms: evt.tStartMs || 0,
        duration_ms: evt.dDurationMs || 0,
        start_time: msToTimecode(evt.tStartMs || 0),
        text,
      });
    }
  }
  return events;
}

/** Fetch { subMap, info } where subMap[lang] = {type:'manual'|'auto', url}. */
async function fetchSubtitleMap(url) {
  const stdout = await run([
    "--quiet",
    "--no-warnings",
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-format",
    "json3",
    "--sub-langs",
    "all",
    "-J",
    url,
  ]);
  const info = JSON.parse(stdout);
  const subMap = {};
  for (const [langCode, entries] of Object.entries(info.subtitles || {})) {
    const hit = (entries || []).find((e) => e.ext === "json3");
    if (hit) subMap[langCode] = { type: "manual", url: hit.url };
  }
  for (const [langCode, entries] of Object.entries(info.automatic_captions || {})) {
    if (subMap[langCode]) continue;
    const hit = (entries || []).find((e) => e.ext === "json3");
    if (hit) subMap[langCode] = { type: "auto", url: hit.url };
  }
  return { subMap, info };
}

function pickLanguage(subMap, preferred) {
  if (preferred && subMap[preferred]) return preferred;
  if (preferred) {
    const prefixMatch = Object.keys(subMap).find(
      (k) => k.startsWith(preferred + "-") || k.startsWith(preferred + ".")
    );
    if (prefixMatch) return prefixMatch;
  }
  const available = Object.keys(subMap);
  return available[0] || null;
}

async function fetchSubtitleEventsForUrl(url) {
  try {
    const { subMap } = await fetchSubtitleMap(url);
    if (!Object.keys(subMap).length) return [];
    let usedLang = null;
    for (const pref of ["id", "en", "en-US", "en-GB", "en-orig"]) {
      if (subMap[pref]) {
        usedLang = pref;
        break;
      }
    }
    if (!usedLang) {
      for (const pref of ["id", "en"]) {
        const match = Object.keys(subMap).find((k) => k.startsWith(pref));
        if (match) {
          usedLang = match;
          break;
        }
      }
    }
    if (!usedLang) usedLang = Object.keys(subMap)[0];

    const raw = await fetchSubtitleJson(subMap[usedLang].url);
    return parseJson3Subtitle(raw);
  } catch (e) {
    console.error("[Subtitle] Fetch error:", e.message);
    return [];
  }
}

module.exports = {
  searchYoutube,
  getInfo,
  getAudioStreamUrl,
  findPlayableInfo,
  msToTimecode,
  parseJson3Subtitle,
  fetchSubtitleMap,
  fetchSubtitleJson,
  pickLanguage,
  fetchSubtitleEventsForUrl,
};