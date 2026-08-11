"use strict";
const express = require("express");
const router = express.Router();

const { state, loadQueue, saveQueue, queueSnapshot, queueLen } = require("../state");
const youtube = require("../youtube");
const playerService = require("../playerService");

router.get("/queue", (req, res) => {
  res.json({
    is_playing: state.isPlaying,
    is_paused: state.isPaused,
    shuffle_mode: state.shuffleMode,
    current_song: state.currentSong,
    queue_count: queueLen(),
    queue: queueSnapshot(),
  });
});

router.post("/queue/add", async (req, res) => {
  const youtubeUrl = req.body?.youtube_url;
  if (!youtubeUrl) return res.status(422).json({ detail: "youtube_url is required" });
  let info;
  try {
    info = await youtube.getInfo(youtubeUrl);
  } catch (e) {
    return res.status(500).json({ detail: e.message });
  }
  const song = playerService.makeSong(info, youtubeUrl);
  const result = await playerService.addOrAutoplay(song);
  playerService.broadcastPlayerState();
  res.json(result);
});

router.post("/queue/shuffle", (req, res) => {
  state.shuffleMode = !state.shuffleMode;
  const q = loadQueue();
  if (state.shuffleMode && q.length) {
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    saveQueue(q);
  }
  playerService.broadcastPlayerState();
  res.json({
    shuffle_mode: state.shuffleMode,
    message: `Shuffle ${state.shuffleMode ? "ON - queue shuffled" : "OFF"}`,
    queue_count: queueLen(),
    queue: queueSnapshot(),
  });
});

router.delete("/queue/:position", (req, res) => {
  const position = parseInt(req.params.position, 10);
  const q = loadQueue();
  if (Number.isNaN(position) || position < 0 || position >= q.length) {
    return res.status(404).json({ detail: `Position ${position} not found (size: ${q.length})` });
  }
  const removed = q.splice(position, 1)[0];
  saveQueue(q);
  playerService.broadcastPlayerState();
  res.json({ message: "Removed", removed_song: removed, queue_count: q.length });
});

router.put("/queue/reorder", (req, res) => {
  const { from_position: from, to_position: to } = req.body || {};
  const q = loadQueue();
  const n = q.length;
  if (!(Number.isInteger(from) && from >= 0 && from < n)) {
    return res.status(400).json({ detail: "from_position out of range" });
  }
  if (!(Number.isInteger(to) && to >= 0 && to < n)) {
    return res.status(400).json({ detail: "to_position out of range" });
  }
  const [song] = q.splice(from, 1);
  q.splice(to, 0, song);
  saveQueue(q);
  playerService.broadcastPlayerState();
  res.json({ message: `Moved ${from} -> ${to}`, queue: queueSnapshot() });
});

router.put("/queue/swap", (req, res) => {
  const { position_a: a, position_b: b } = req.body || {};
  const q = loadQueue();
  const n = q.length;
  if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a < n && b >= 0 && b < n)) {
    return res.status(400).json({ detail: "Position out of range" });
  }
  [q[a], q[b]] = [q[b], q[a]];
  saveQueue(q);
  playerService.broadcastPlayerState();
  res.json({ message: `Swapped ${a} <-> ${b}`, queue: queueSnapshot() });
});

router.post("/queue/next", async (req, res) => {
  await playerService.doSkip("api");
  res.json({
    message: state.currentSong ? "Playing next" : "Queue is empty",
    current_song: state.currentSong,
    is_playing: state.isPlaying,
    queue_remaining: queueLen(),
  });
});

router.post("/queue/clear", (req, res) => {
  saveQueue([]);
  playerService.broadcastPlayerState();
  res.json({ message: "Queue cleared", queue_count: 0 });
});

module.exports = router;
