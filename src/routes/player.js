"use strict";
const express = require("express");
const router = express.Router();

const { state, loadQueue, saveQueue, queueLen } = require("../state");
const youtube = require("../youtube");
const mpv = require("../mpv");
const sse = require("../sse");
const playerService = require("../playerService");
const config = require("../config");
const paths = require("../paths");

router.get("/player/state", (req, res) => {
  const running = !!(state.mpvProc && state.mpvProc.exitCode === null && !state.mpvProc.killed);
  let elapsedMs = 0;
  if (running && state.isPlaying && !state.isPaused && state.currentSongStartTime > 0) {
    elapsedMs = Math.round((Date.now() / 1000 - state.currentSongStartTime) * 1000);
  }
  res.json({
    is_playing: state.isPlaying,
    is_paused: state.isPaused,
    server_audio_running: running,
    shuffle_mode: state.shuffleMode,
    current_song: state.currentSong,
    elapsed_ms: elapsedMs,
    queue_count: queueLen(),
    queue: require("../state").queueSnapshot(),
  });
});

router.post("/player/play", async (req, res) => {
  const youtubeUrl = req.body?.youtube_url;
  if (!youtubeUrl) return res.status(422).json({ detail: "youtube_url is required" });
  let info;
  try {
    info = await youtube.getInfo(youtubeUrl);
  } catch (e) {
    return res.status(500).json({ detail: e.message });
  }
  const song = playerService.makeSong(info, youtubeUrl);
  state.currentSong = song;
  state.isPlaying = true;
  state.isPaused = false;
  const serverPlaying = await mpv.playServerAudio(youtubeUrl);
  playerService.broadcastPlayerState();
  res.json({ message: "Playing now", song, server_audio: serverPlaying });
});

router.post("/player/pause", async (req, res) => {
  await mpv.pauseServerAudio();
  playerService.broadcastPlayerState();
  res.json({ message: "Paused", is_paused: state.isPaused });
});

router.post("/player/resume", async (req, res) => {
  await mpv.resumeServerAudio();
  playerService.broadcastPlayerState();
  res.json({ message: "Resumed", is_paused: state.isPaused });
});

router.post("/player/song-ended", async (req, res) => {
  const finished = state.currentSong;
  const q = loadQueue();
  if (q.length) {
    let songDict;
    if (state.shuffleMode) {
      const idx = Math.floor(Math.random() * q.length);
      songDict = q.splice(idx, 1)[0];
    } else {
      songDict = q.shift();
    }
    saveQueue(q);
    state.currentSong = songDict;
    state.isPlaying = true;
    state.isPaused = false;
  } else {
    state.currentSong = null;
    state.isPlaying = false;
    state.isPaused = false;
  }
  let serverPlaying = false;
  if (state.currentSong) {
    serverPlaying = await mpv.playServerAudio(state.currentSong.youtube_url);
  }
  playerService.broadcastPlayerState();
  res.json({
    auto_cleared: true,
    finished_song: finished,
    next_song: state.currentSong,
    queue_remaining: queueLen(),
    is_playing: state.isPlaying,
    is_paused: state.isPaused,
    server_audio: serverPlaying,
  });
});

router.post("/player/stop", async (req, res) => {
  state.currentSong = null;
  state.isPlaying = false;
  state.isPaused = false;
  await mpv.killServerPlayer();
  sse.broadcast("player_stopped", {});
  playerService.broadcastPlayerState();
  res.json({ message: "Player stopped" });
});

router.get("/player/volume", (req, res) => {
  res.json({ music: state.musicVolume, tts: state.ttsVolumePct });
});

router.post("/player/volume", async (req, res) => {
  let changed = false;
  const { music, tts } = req.body || {};
  if (music !== undefined && music !== null) {
    const val = Math.max(0, Math.min(150, parseInt(music, 10)));
    state.musicVolume = val;
    changed = true;
    if (state.mpvProc && state.serverPlayer && state.serverPlayer.includes("mpv")) {
      await mpv.mpvSend(["set_property", "volume", val]);
    }
  }
  if (tts !== undefined && tts !== null) {
    state.ttsVolumePct = Math.max(-50, Math.min(100, parseInt(tts, 10)));
    changed = true;
  }
  if (changed) {
    const cfg = config.loadConfig();
    cfg.settings = cfg.settings || {};
    cfg.settings.music_volume = state.musicVolume;
    cfg.tts = cfg.tts || {};
    const sign = state.ttsVolumePct >= 0 ? "+" : "";
    cfg.tts.volume = `${sign}${state.ttsVolumePct}%`;
    cfg.tts.volume_pct = state.ttsVolumePct;
    try {
      config.saveRawConfig(cfg);
    } catch (e) {
      console.error("[Volume] Failed to save config:", e.message);
    }
  }
  res.json({ music: state.musicVolume, tts: state.ttsVolumePct });
});

router.get("/player/mpv/status", async (req, res) => {
  const running = !!(state.mpvProc && state.mpvProc.exitCode === null && !state.mpvProc.killed);
  let paused = false;
  if (running && state.serverPlayer && state.serverPlayer.includes("mpv")) {
    const resp = await mpv.mpvSend(["get_property", "pause"]);
    if (resp && "data" in resp) paused = resp.data;
  }
  res.json({
    server_player: state.serverPlayer || mpv.detectPlayer() || "none",
    is_running: running,
    is_paused: paused,
    current_song: state.currentSong,
    platform: paths.IS_WINDOWS ? "windows" : process.platform,
    mpv_socket: paths.MPV_SOCKET_ARG,
  });
});

router.post("/player/mpv/stop", async (req, res) => {
  await mpv.killServerPlayer();
  res.json({ message: "Server audio stopped" });
});

module.exports = router;
