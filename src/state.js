"use strict";
const fs = require("fs");
const paths = require("./paths");

// ── In-memory queue, persisted to disk asynchronously ───────────
// The old implementation did a synchronous readFileSync+JSON.parse and
// writeFileSync+JSON.stringify on *every* queue operation (add/remove/
// reorder/skip/autoplay - i.e. on nearly every request and every TikTok
// chat command). That's blocking disk I/O on the event loop for something
// that's really just small in-memory state. Now the queue lives in memory
// as the source of truth and is flushed to disk async + debounced, so
// bursts of rapid changes (e.g. several TikTok requests in a row) collapse
// into a single write instead of one write each.
let _queue = [];
let _queueLoaded = false;
let _flushTimer = null;
const FLUSH_DEBOUNCE_MS = 400;

function _loadQueueFromDisk() {
  try {
    const raw = fs.readFileSync(paths.QUEUE_FILE, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function _ensureLoaded() {
  if (!_queueLoaded) {
    _queue = _loadQueueFromDisk();
    _queueLoaded = true;
  }
}

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    const snapshot = _queue;
    fs.writeFile(paths.QUEUE_FILE, JSON.stringify(snapshot, null, 2), "utf-8", (err) => {
      if (err) console.error("[Queue] Failed to persist queue.json:", err.message);
    });
  }, FLUSH_DEBOUNCE_MS);
}

/** Flush immediately and synchronously (used on shutdown). */
function flushQueueSync() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  if (!_queueLoaded) return;
  try {
    fs.writeFileSync(paths.QUEUE_FILE, JSON.stringify(_queue, null, 2), "utf-8");
  } catch (e) {
    console.error("[Queue] Failed to flush queue.json on shutdown:", e.message);
  }
}

/** Returns the live in-memory queue array (mutate + call saveQueue to persist). */
function loadQueue() {
  _ensureLoaded();
  return _queue;
}

/** Replace the queue and schedule a debounced async write-through to disk. */
function saveQueue(q) {
  _queue = q;
  _queueLoaded = true;
  _scheduleFlush();
}

function queueSnapshot() {
  return loadQueue().map((song, i) => ({ position: i, song }));
}

function queueLen() {
  return loadQueue().length;
}

// ── In-memory player / session state (single-process, mirrors Python module globals) ──
const state = {
  currentSong: null, // Song-like object or null
  isPlaying: false,
  isPaused: false,
  shuffleMode: false,
  currentSongStartTime: 0, // epoch seconds

  // mpv / server audio
  mpvProc: null, // child_process handle
  serverPlayer: null, // resolved binary path/name
  playerKilled: false,
  // Set by mpv.js's process "exit" handler the moment mpv stops (naturally
  // finishing a song or crashing). state.mpvProc itself gets nulled out in
  // that same handler, so the background watcher in playerService.js can't
  // rely on inspecting mpvProc/exitCode after the fact - it watches this
  // flag instead and clears it once it has advanced to the next song.
  mpvExited: false,
  ytdlpProc: null,
  // skip votes / per-user throttling
  skipVotes: new Set(),
  userRequestCount: {}, // user_id -> count

  // recent TikTok requests (ring buffer, most-recent-first)
  recentRequests: [],

  // TikTok listener state
  tiktokConnected: false,
  tiktokError: "",
  tiktokReadyAt: 0, // epoch seconds; comments before this are ignored (warmup)
  tiktokStopFlag: true,
  tiktokConnection: null,
  tiktokWs: null, // active WebSocket handle when tiktok_provider = "tiktool"
  tiktokConnector: null, // active TikTokLiveConnection instance when tiktok_provider = "connector"
  tiktokReconnectTimer: null,

  // subtitle broadcaster guard
  subtitleSongId: null,

  // playback request generation counter. Bumped on every playServerAudio()
  // call so overlapping calls (e.g. several #skip commands arriving from
  // TikTok chat back-to-back) can tell whether they've been superseded by a
  // newer request before they commit to spawning mpv / broadcasting
  // subtitles - see mpv.js playServerAudio().
  playbackToken: 0,

  // volume (loaded/persisted via config.js in server bootstrap)
  musicVolume: 100,
  ttsVolumePct: 0,

  // version/update info
  updateInfo: {},
};

function addRecentRequest(entry) {
  state.recentRequests.unshift(entry);
  if (state.recentRequests.length > 50) state.recentRequests.length = 50;
}

module.exports = {
  state,
  loadQueue,
  saveQueue,
  queueSnapshot,
  queueLen,
  addRecentRequest,
  flushQueueSync,
};