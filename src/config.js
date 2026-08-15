"use strict";
/**
 * Config & bad-word filter helpers.
 */
const fs = require("fs");
const path = require("path");
const paths = require("./paths");

let _configCache = null;
let _configMtime = 0.0;

const DEFAULT_CONFIG = {
  tiktok_username: "",
  tiktok_provider: "tiktool", // "tiktool" (api.tik.tools) | "connector" (tiktok-live-connector via Euler Stream)
  euler_api_key: "", // tik.tools API key — used when tiktok_provider = "tiktool"
  eulerstream_api_key: "", // eulerstream.com API key — OPTIONAL, used when tiktok_provider = "connector" (works anonymously without it, just with a lower rate limit)
  commands: {
    request: ["#req", "#request", "#lagu", "#song", "#minta"],
    skip: ["#skip", "#next", "#lewat", "#ganti"],
    stop: ["#stop"],
    queue: ["#queue", "#antrian", "#q", "#list"],
  },
  settings: {
    max_queue_per_user: 3,
    enable_skip_vote: true,
    skip_vote_threshold: 5,
    tiktok_warmup_seconds: 5,
    music_volume: 100,
  },
  tts: {
    enabled: false,
    voice: "id-ID-ArdiNeural",
    rate: "+0%",
    volume: "+0%",
    max_length: 100,
    volume_pct: 0,
  },
  // Order of audio-resolving backends to try, first to last, with automatic
  // fallback to the next one on failure. See src/resolvers.js. Valid values:
  // "ytdlp" (binary, most complete/gets subtitles too), "play-dl" (pure JS
  // library, no binary), "piped" (public REST API, zero dependency). Drop
  // an entry to disable that backend entirely, or reorder based on your own
  // results from `npm run benchmark-resolvers`.
  resolver_order: ["ytdlp", "play-dl", "piped"],
  overlay: {},
};

function _deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object") {
      out[k] = _deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig() {
  try {
    const stat = fs.statSync(paths.CONFIG_FILE);
    if (_configCache && stat.mtimeMs === _configMtime) {
      return _configCache;
    }
    const raw = fs.readFileSync(paths.CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    _configCache = _deepMerge(DEFAULT_CONFIG, parsed);
    _configMtime = stat.mtimeMs;
    return _configCache;
  } catch (e) {
    if (!_configCache) {
      _configCache = { ...DEFAULT_CONFIG };
    }
    return _configCache;
  }
}

function saveConfigMerged(body) {
  const existing = loadConfig();

  function mergeComments(src, dest) {
    const out = { ...dest };
    for (const [k, v] of Object.entries(src)) {
      if (k.startsWith("_comment") || k.startsWith("_obs_")) {
        if (!(k in out)) out[k] = v;
      } else if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object") {
        out[k] = mergeComments(v, out[k]);
      }
    }
    return out;
  }

  const merged = mergeComments(existing, body);
  fs.writeFileSync(paths.CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
  _configCache = merged;
  _configMtime = fs.statSync(paths.CONFIG_FILE).mtimeMs;
  return merged;
}

function saveRawConfig(cfg) {
  fs.writeFileSync(paths.CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  _configCache = cfg;
  _configMtime = fs.statSync(paths.CONFIG_FILE).mtimeMs;
}

function getCommands() {
  const cfg = loadConfig();
  return { ...DEFAULT_CONFIG.commands, ...(cfg.commands || {}) };
}

function getTiktokUsername() {
  const cfg = loadConfig();
  let u = (cfg.tiktok_username || "").trim();
  if (u.startsWith("@")) u = u.slice(1);
  if (u.startsWith("masukan-username")) return "";
  return u;
}

function getEulerApiKey() {
  const cfg = loadConfig();
  return (cfg.euler_api_key || "").trim();
}

function getTiktokProvider() {
  const cfg = loadConfig();
  const p = (cfg.tiktok_provider || "tiktool").trim().toLowerCase();
  return p === "connector" ? "connector" : "tiktool";
}

function getEulerStreamApiKey() {
  const cfg = loadConfig();
  return (cfg.eulerstream_api_key || "").trim();
}

function getSettings() {
  const cfg = loadConfig();
  return { ...DEFAULT_CONFIG.settings, ...(cfg.settings || {}) };
}

function getTtsConfig() {
  const cfg = loadConfig();
  return { ...DEFAULT_CONFIG.tts, ...(cfg.tts || {}) };
}

function getResolverOrder() {
  const cfg = loadConfig();
  const order = Array.isArray(cfg.resolver_order) ? cfg.resolver_order : null;
  return order && order.length ? order : DEFAULT_CONFIG.resolver_order;
}

// ── Bad word filter ──────────────────────────────────────────
let _badwordsCache = null;
let _badwordsMtime = 0;
let _badwordsRegex = null;

function _escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\$&");
}

function _loadBadwordsFresh() {
  try {
    const stat = fs.statSync(paths.BADWORDS_FILE);
    if (_badwordsCache && stat.mtimeMs === _badwordsMtime) {
      return _badwordsCache;
    }
    const raw = fs.readFileSync(paths.BADWORDS_FILE, "utf-8");
    const words = raw
      .split("\n")
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w && !w.startsWith("#"));
    _badwordsCache = words;
    _badwordsMtime = stat.mtimeMs;
    _badwordsRegex = words.length ? new RegExp(words.map(_escapeRegex).join("|"), "i") : null;
    return words;
  } catch (e) {
    _badwordsCache = [];
    _badwordsRegex = null;
    return [];
  }
}

function loadBadwords() {
  return _loadBadwordsFresh();
}

function saveBadwords(words) {
  const cleaned = [...new Set(words.map((w) => String(w).trim().toLowerCase()).filter(Boolean))];
  fs.writeFileSync(paths.BADWORDS_FILE, cleaned.join("\n") + "\n", "utf-8");
  _badwordsCache = cleaned;
  _badwordsMtime = fs.statSync(paths.BADWORDS_FILE).mtimeMs;
  _badwordsRegex = cleaned.length ? new RegExp(cleaned.map(_escapeRegex).join("|"), "i") : null;
  return cleaned;
}

function containsBadword(text) {
  if (!text) return false;
  _loadBadwordsFresh();
  if (!_badwordsRegex) return false;
  return _badwordsRegex.test(text);
}

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfigMerged,
  saveRawConfig,
  getCommands,
  getTiktokUsername,
  getEulerApiKey,
  getTiktokProvider,
  getEulerStreamApiKey,
  getSettings,
  getTtsConfig,
  getResolverOrder,
  loadBadwords,
  saveBadwords,
  containsBadword,
};