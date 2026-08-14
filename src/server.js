"use strict";
const express = require("express");
const cors = require("cors");
const fs = require("fs");

const paths = require("./paths");
const config = require("./config");
const mpv = require("./mpv");
const tiktok = require("./tiktok");
const versionMod = require("./version");
const ytdlpManager = require("./ytdlpManager");
const playerService = require("./playerService");
const { state, flushQueueSync } = require("./state");

// Ensure data dir + queue.json + badwords.txt exist
if (!fs.existsSync(paths.DATA_DIR)) fs.mkdirSync(paths.DATA_DIR, { recursive: true });
if (!fs.existsSync(paths.QUEUE_FILE)) fs.writeFileSync(paths.QUEUE_FILE, "[]", "utf-8");
if (!fs.existsSync(paths.BADWORDS_FILE)) fs.writeFileSync(paths.BADWORDS_FILE, "", "utf-8");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "5mb" }));

app.use(require("./routes/system"));
app.use(require("./routes/youtube"));
app.use(require("./routes/queue"));
app.use(require("./routes/player"));
app.use(require("./routes/tiktok"));
app.use(require("./routes/config"));
app.use(require("./routes/badwords"));
app.use(require("./routes/overlay"));

// Generic error handler so a thrown error never crashes the process.
app.use((err, req, res, next) => {
  console.error("[Server] Unhandled error:", err);
  if (!res.headersSent) res.status(500).json({ detail: err.message || "Internal server error" });
});

const PORT = parseInt(process.env.PORT || "8000", 10);

async function main() {
  // Load persisted volume settings before anything plays.
  const cfg = config.loadConfig();
  const musicRaw = cfg.settings?.music_volume;
  state.musicVolume = Number.isFinite(parseInt(musicRaw, 10)) ? Math.max(0, Math.min(150, parseInt(musicRaw, 10))) : 100;
  const ttsPct = cfg.tts?.volume_pct;
  state.ttsVolumePct = Number.isFinite(parseInt(ttsPct, 10)) ? Math.max(-50, Math.min(100, parseInt(ttsPct, 10))) : 0;

  // Download yt-dlp on first run, or update it if a newer release is out.
  // Best-effort: if this fails (offline, GitHub down, etc.) startup still
  // continues using whatever yt-dlp is already available (bundled or PATH).
  await ytdlpManager.ensureYtdlp();

  const found = mpv.detectPlayer();
  if (found) {
    state.serverPlayer = found;
    console.log(`[Startup] Player found: ${found}`);
  } else {
    console.warn("[Startup] WARNING: mpv/ffplay not found. Install mpv, or place mpv(.exe) in the app folder.");
  }

  console.log("[TikTok] Auto-connect disabled. Use the Web UI Settings tab (or POST /tiktok/reconnect) to connect manually.");

  const upd = await versionMod.checkForUpdate();
  if (upd.update_available) {
    console.log("");
    console.log("+" + "-".repeat(53) + "+");
    console.log(`|  UPDATE TERSEDIA v${upd.latest_version_name} (kamu: v${upd.current_version_name})`.padEnd(54) + "|");
    if (upd.update_message) console.log(`|  ${upd.update_message.slice(0, 50)}`.padEnd(54) + "|");
    console.log("|  https://github.com/ShinriShoaku/YTP".padEnd(54) + "|");
    console.log("+" + "-".repeat(53) + "+");
    console.log("");
  } else if (upd.error) {
    console.log(`[Update] Cek versi gagal: ${upd.error}`);
  } else {
    console.log(`[Update] Versi kamu v${upd.current_version_name} - sudah up-to-date (latest: v${upd.latest_version_name})`);
  }

  playerService.startMpvWatcher();

  app.listen(PORT, "0.0.0.0", () => {
    console.log("=".repeat(56));
    console.log("  YTPlayer (Node.js port) - YouTube Audio Player + OBS Overlay");
    console.log("=".repeat(56));
    console.log(`  Base dir  : ${paths.BASE_DIR}`);
    console.log(`  Overlays  : ${paths.OVERLAYS_DIR}`);
    console.log(`  Config    : ${paths.CONFIG_FILE}`);
    console.log(`  Queue     : ${paths.QUEUE_FILE}`);
    console.log(`  Platform  : ${paths.IS_WINDOWS ? "Windows" : process.platform}`);
    console.log(`  MPV       : ${state.serverPlayer || "not found - place mpv in the app folder"}`);
    console.log(`  Web UI    : http://localhost:${PORT}/player`);
    console.log(`  OBS (all) : http://localhost:${PORT}/obs`);
    console.log(`  OBS Chat  : http://localhost:${PORT}/obs/chat`);
    console.log("=".repeat(56));
  });
}

process.on("SIGINT", async () => {
  console.log("\n[Shutdown] Stopping player + TikTok listener...");
  try {
    tiktok.stopTiktokListener();
  } catch (e) {}
  try {
    await mpv.killServerPlayer();
  } catch (e) {}
  flushQueueSync();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  try {
    tiktok.stopTiktokListener();
  } catch (e) {}
  try {
    await mpv.killServerPlayer();
  } catch (e) {}
  flushQueueSync();
  process.exit(0);
});

main().catch((e) => {
  console.error("[Startup] Fatal error:", e);
  process.exit(1);
});
