"use strict";
const { v4: uuidv4 } = require("uuid");
const { state, loadQueue, saveQueue, queueSnapshot, queueLen } = require("./state");
const mpv = require("./mpv");
const sse = require("./sse");

function makeSong(info, url) {
  return {
    id: uuidv4(),
    title: info.title || "Unknown",
    youtube_url: url,
    thumbnail: info.thumbnail || null,
    duration: info.duration ?? null,
    channel: info.channel || info.uploader || null,
    added_at: new Date().toISOString(),
    requested_by: null,
  };
}

function broadcastPlayerState() {
  sse.broadcast("player_state", {
    current_song: state.currentSong,
    is_playing: state.isPlaying,
    is_paused: state.isPaused,
    queue_count: queueLen(),
    queue: queueSnapshot()
      .slice(0, 5)
      .map((item) => item.song.title),
  });
}

/** Play immediately if idle, otherwise append to (or shuffle-insert into) the queue. */
async function addOrAutoplay(song) {
  let autoplayUrl = null;
  let result = {};

  if (!state.isPlaying && !state.currentSong) {
    state.currentSong = song;
    state.isPlaying = true;
    state.isPaused = false;
    autoplayUrl = song.youtube_url;
    result = {
      auto_played: true,
      message: "Auto-playing - player was idle",
      song,
      queue_count: queueLen(),
      server_audio: false,
    };
  } else {
    const q = loadQueue();
    let queuePosition;
    if (state.shuffleMode && q.length) {
      queuePosition = Math.floor(Math.random() * (q.length + 1));
      q.splice(queuePosition, 0, song);
    } else {
      q.push(song);
      queuePosition = q.length - 1;
    }
    saveQueue(q);
    result = {
      auto_played: false,
      message: "Added to queue",
      song,
      queue_position: queuePosition,
      queue_count: q.length,
    };
  }

  if (autoplayUrl) {
    result.server_audio = await mpv.playServerAudio(autoplayUrl);
  }
  return result;
}

/** Advance to the next queued song (or clear if empty). Used by skip / TikTok skip votes. */
async function doSkip(triggeredBy = "") {
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
  state.skipVotes = new Set();
  state.userRequestCount = {};

  if (state.currentSong) {
    await mpv.playServerAudio(state.currentSong.youtube_url);
  } else {
    await mpv.killServerPlayer();
  }
  sse.broadcast("skip_executed", { triggered_by: triggeredBy });
  broadcastPlayerState();
}

/** Background watcher: auto-advance when mpv exits naturally (mirrors _mpv_watcher). */
function startMpvWatcher() {
  let tick = 0;
  setInterval(async () => {
    tick += 1;
    if (tick % 200 === 0) state.userRequestCount = {};

    if (!state.mpvProc) {
      if (state.playerKilled) state.playerKilled = false;
      return;
    }
    if (state.mpvProc.exitCode === null && !state.mpvProc.killed) return; // still running
    if (state.playerKilled) {
      state.playerKilled = false;
      return;
    }

    // mpv died naturally -> advance
    state.skipVotes = new Set();
    state.userRequestCount = {};
    const q = loadQueue();
    let nextUrl = null;
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
      nextUrl = state.currentSong.youtube_url;
    } else {
      state.currentSong = null;
      state.isPlaying = false;
      state.isPaused = false;
    }
    if (nextUrl) await mpv.playServerAudio(nextUrl);
    broadcastPlayerState();
  }, 3000);
}

module.exports = { makeSong, broadcastPlayerState, addOrAutoplay, doSkip, startMpvWatcher };
