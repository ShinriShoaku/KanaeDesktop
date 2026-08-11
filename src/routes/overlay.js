"use strict";
const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();

const { state, queueSnapshot, queueLen } = require("../state");
const sse = require("../sse");
const config = require("../config");
const paths = require("../paths");
const { DEFAULT_OVERLAY_CONFIG } = require("../overlayDefaults");

// ── SSE stream ──────────────────────────────────────────────────
router.get("/overlay/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders?.();

  sse.addClient(res);

  const initData = {
    current_song: state.currentSong,
    is_playing: state.isPlaying,
    is_paused: state.isPaused,
    queue_count: queueLen(),
    queue: queueSnapshot()
      .slice(0, 5)
      .map((item) => item.song.title),
    tiktok_connected: state.tiktokConnected,
    recent_requests: state.recentRequests.slice(0, 10),
    commands: config.getCommands(),
  };
  sse.sendEvent(res, "init", initData);

  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch (e) {}
  }, 15000);

  req.on("close", () => {
    clearInterval(ping);
    sse.removeClient(res);
  });
});

router.get("/overlay/state", (req, res) => {
  const settings = config.getSettings();
  res.json({
    current_song: state.currentSong,
    is_playing: state.isPlaying,
    is_paused: state.isPaused,
    queue_count: queueLen(),
    queue: queueSnapshot()
      .slice(0, 5)
      .map((item) => item.song),
    tiktok_connected: state.tiktokConnected,
    recent_requests: state.recentRequests.slice(0, 10),
    skip_votes: state.skipVotes.size,
    skip_threshold: settings.skip_vote_threshold,
    elapsed_ms:
      state.isPlaying && !state.isPaused && state.currentSongStartTime > 0
        ? Math.round((Date.now() / 1000 - state.currentSongStartTime) * 1000)
        : 0,
  });
});

// ── HTML Remote UI ────────────────────────────────────────────
router.get("/player", (req, res) => {
  const p = path.join(paths.BASE_DIR, "player.html");
  if (!fs.existsSync(p)) return res.status(404).json({ detail: "player.html not found in base directory" });
  res.type("html").send(fs.readFileSync(p, "utf-8"));
});

// ── Overlay display config ─────────────────────────────────────
router.get("/overlay/config", (req, res) => {
  const cfg = config.loadConfig();
  res.json({ ...DEFAULT_OVERLAY_CONFIG, ...(cfg.overlay || {}) });
});

router.put("/overlay/config", (req, res) => {
  const cfg = config.loadConfig();
  const current = cfg.overlay || {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (k in DEFAULT_OVERLAY_CONFIG) current[k] = v;
  }
  cfg.overlay = current;
  try {
    config.saveRawConfig(cfg);
  } catch (e) {
    return res.status(500).json({ detail: `Could not save config: ${e.message}` });
  }
  const merged = { ...DEFAULT_OVERLAY_CONFIG, ...current };
  sse.broadcast("overlay_config", merged);
  res.json({ message: "Config saved", overlay: merged });
});

// ── Avatar proxy (bypass CORS for TikTok profile pictures) ─────
const avatarCache = new Map(); // url -> {data:Buffer, contentType, ts}
const MAX_CACHE_ENTRIES = 100;
const MAX_CACHE_BYTES = 20 * 1024 * 1024;

router.get("/proxy/avatar", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(422).json({ detail: "query param 'url' is required" });

  const cached = avatarCache.get(url);
  if (cached) {
    res.set({ "Cache-Control": "public,max-age=3600", "Access-Control-Allow-Origin": "*" });
    return res.type(cached.contentType).send(cached.data);
  }

  let data, contentType;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OBSOverlay/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    data = buf;
    contentType = (resp.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  } catch (e) {
    return res.status(502).json({ detail: `Could not fetch avatar: ${e.message}` });
  }

  let totalBytes = [...avatarCache.values()].reduce((sum, v) => sum + v.data.length, 0);
  while (avatarCache.size >= MAX_CACHE_ENTRIES || totalBytes > MAX_CACHE_BYTES) {
    if (!avatarCache.size) break;
    const oldestKey = [...avatarCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0][0];
    totalBytes -= avatarCache.get(oldestKey).data.length;
    avatarCache.delete(oldestKey);
  }
  avatarCache.set(url, { data, contentType, ts: Date.now() });

  res.set({ "Cache-Control": "public,max-age=3600", "Access-Control-Allow-Origin": "*" });
  res.type(contentType).send(data);
});

// ── OBS overlay HTML pages ──────────────────────────────────────
function serveHtml(res, filename) {
  const p = path.join(paths.OVERLAYS_DIR, filename);
  if (!fs.existsSync(p)) return res.status(404).json({ detail: `${filename} not found in overlays/ directory` });
  res.type("html").send(fs.readFileSync(p, "utf-8"));
}

router.get("/obs", (req, res) => serveHtml(res, "obs_overlay.html"));
router.get("/obs/nowplaying", (req, res) => serveHtml(res, "obs_nowplaying.html"));
router.get("/obs/queue", (req, res) => serveHtml(res, "obs_queue.html"));
router.get("/obs/commands", (req, res) => serveHtml(res, "obs_commands.html"));
router.get("/obs/subtitle", (req, res) => serveHtml(res, "obs_subtitle.html"));
router.get("/obs/requests", (req, res) => serveHtml(res, "obs_requests.html"));
router.get("/obs/chat", (req, res) => serveHtml(res, "obs_chat.html"));

module.exports = router;
