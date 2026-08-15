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

/**
 * Pulls the next song off the queue into state.currentSong (or clears state
 * if the queue is empty). Pure state manipulation, no playback side effects -
 * callers are responsible for actually starting playback afterwards. Shared
 * by doSkip(), the mpv-exit watcher, and playCurrentOrAdvance() below so all
 * three "move to the next song" paths behave identically.
 */
function popNextSongIntoState() {
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
}

/**
 * Starts playback for state.currentSong and, if it fails to actually start
 * (e.g. yt-dlp got rate-limited with a 429, network hiccup, mpv missing,
 * etc.), automatically advances to the next queued song instead of leaving
 * playback silently stuck.
 *
 * This matters because mpv.playServerAudio() resolving to `false` used to
 * just get dropped by every caller - state.currentSong stayed set and
 * state.isPlaying stayed true, but no mpv process ever actually started.
 * The background watcher in startMpvWatcher() only advances when it sees an
 * mpv PROCESS exit, so with no process ever spawned it never noticed
 * anything was wrong: the "current song" would sit there marked as playing
 * forever, silently blocking every song queued behind it, with the
 * requester seeing nothing happen. From a viewer's perspective the request
 * just vanishes before ever audibly playing - which matches "sudah hilang
 * padahal belum diplay" (gone before it even played).
 *
 * A handful of attempts are made across the head of the queue (skipping
 * whichever songs fail) rather than giving up after just one, since a
 * single bad/region-locked/rate-limited entry shouldn't stall everything
 * behind it. Each failure is broadcast over SSE (`playback_failed`) so the
 * UI/overlay can show what happened instead of just going quiet.
 */
async function playCurrentOrAdvance({ maxAttempts = 5 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!state.currentSong) {
      await mpv.killServerPlayer();
      broadcastPlayerState();
      return;
    }

    const song = state.currentSong;
    const started = await mpv.playServerAudio(song.youtube_url);
    if (started) {
      broadcastPlayerState();
      return;
    }

    console.error(`[Player] Gagal memutar "${song.title}" - lanjut ke lagu berikutnya di antrian.`);
    sse.broadcast("playback_failed", {
      title: song.title,
      reason: "Gagal memuat audio (kemungkinan rate-limit/koneksi) - dilewati",
    });
    popNextSongIntoState();
  }

  // Exhausted maxAttempts in a row without a single successful start -
  // stop cleanly instead of silently looping/spamming yt-dlp forever.
  console.error(`[Player] ${maxAttempts} lagu berturut-turut gagal diputar - berhenti sementara.`);
  state.currentSong = null;
  state.isPlaying = false;
  state.isPaused = false;
  await mpv.killServerPlayer();
  broadcastPlayerState();
}

/** Play immediately if idle, otherwise append to (or shuffle-insert into) the queue. */
async function addOrAutoplay(song) {
  let willAutoplay = false;
  let result = {};

  if (!state.isPlaying && !state.currentSong) {
    state.currentSong = song;
    state.isPlaying = true;
    state.isPaused = false;
    willAutoplay = true;
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

  if (willAutoplay) {
    // Runs the same fail-and-advance logic as skip/watcher, so a request
    // that happens to hit a rate-limited/unplayable link doesn't just get
    // stuck - it'll fall through to the next queued song automatically.
    await playCurrentOrAdvance();
    result.server_audio = !!state.mpvProc;
  }
  return result;
}

/** Advance to the next queued song (or clear if empty). Used by skip / TikTok skip votes. */
async function doSkip(triggeredBy = "") {
  popNextSongIntoState();
  state.skipVotes = new Set();
  state.userRequestCount = {};

  await playCurrentOrAdvance();
  sse.broadcast("skip_executed", { triggered_by: triggeredBy });
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
    popNextSongIntoState();
    await playCurrentOrAdvance();
  }, 3000);
}

module.exports = { makeSong, broadcastPlayerState, addOrAutoplay, doSkip, startMpvWatcher };
