"use strict";
/**
 * mpv detection + JSON IPC control.
 * Ported from: _find_local_player, _detect_player, _mpv_send_unix, _mpv_send_windows,
 *              _mpv_send, _kill_server_player, _pause_server_audio, _resume_server_audio,
 *              _play_server_audio (main.py)
 *
 * Node's net module can connect to a Windows named pipe the same way it connects to a
 * POSIX unix-domain socket (net.createConnection(path)), so this port doesn't need the
 * manual win32file branching the Python version required.
 *
 * IPC connection is kept persistent and reused across commands (play/pause/volume/etc)
 * instead of opening+closing a new socket per command, which cuts per-command latency
 * and avoids repeated connect/teardown overhead.
 */
const { spawn, execFileSync } = require("child_process");
const net = require("net");
const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const { state } = require("./state");

function findLocalPlayer(name) {
  const candidates = [
    path.join(paths.BASE_DIR, paths.IS_WINDOWS ? `${name}.exe` : name),
    path.join(paths.BASE_DIR, "mpv", paths.IS_WINDOWS ? `${name}.exe` : name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function detectPlayer() {
  const local = findLocalPlayer("mpv");
  if (local) return local;
  // Try system PATH
  try {
    execFileSync(paths.IS_WINDOWS ? "where" : "which", ["mpv"], { stdio: ["ignore", "pipe", "ignore"] });
    return "mpv";
  } catch (e) {
    return null;
  }
}

function getMusicVolume() {
  return state.musicVolume;
}

// ── Persistent IPC connection ────────────────────────────────────
let _ipcSocket = null;
let _ipcConnecting = null;
let _ipcBuf = "";
let _pending = []; // FIFO of {resolve, timer} - mpv replies to commands in the order sent

function _resetIpc() {
  if (_ipcSocket) {
    try {
      _ipcSocket.removeAllListeners();
      _ipcSocket.destroy();
    } catch (e) {}
  }
  _ipcSocket = null;
  _ipcBuf = "";
  for (const p of _pending) {
    clearTimeout(p.timer);
    p.resolve(null);
  }
  _pending = [];
}

function _getIpcSocket(socketPath) {
  if (_ipcSocket && !_ipcSocket.destroyed) return Promise.resolve(_ipcSocket);
  if (_ipcConnecting) return _ipcConnecting;

  _ipcConnecting = new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const onFailure = (err) => {
      _ipcConnecting = null;
      _resetIpc();
      reject(err || new Error("mpv IPC connect failed"));
    };
    sock.once("error", onFailure);
    sock.once("connect", () => {
      sock.removeListener("error", onFailure);
      sock.on("data", (chunk) => {
        _ipcBuf += chunk.toString("utf-8");
        const lines = _ipcBuf.split("\n");
        _ipcBuf = lines.pop(); // keep any incomplete trailing line buffered
        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch (e) {
            continue;
          }
          // Only command *replies* carry an "error" field; unsolicited mpv
          // event notifications don't, so this is how we tell them apart.
          if (Object.prototype.hasOwnProperty.call(parsed, "error")) {
            const p = _pending.shift();
            if (p) {
              clearTimeout(p.timer);
              p.resolve(parsed);
            }
          }
        }
      });
      sock.on("close", () => _resetIpc());
      sock.on("error", () => _resetIpc());
      _ipcSocket = sock;
      _ipcConnecting = null;
      resolve(sock);
    });
  });

  return _ipcConnecting;
}

/** Send a JSON IPC command to a running mpv instance. Resolves to parsed response or null. */
async function mpvSend(command, socketPath = paths.MPV_SOCKET_ARG, timeout = 2000) {
  let sock;
  try {
    sock = await _getIpcSocket(socketPath);
  } catch (e) {
    return null;
  }
  return new Promise((resolve) => {
    const entry = { resolve, timer: null };
    entry.timer = setTimeout(() => {
      const idx = _pending.indexOf(entry);
      if (idx !== -1) _pending.splice(idx, 1);
      resolve(null);
    }, timeout);
    _pending.push(entry);
    try {
      sock.write(JSON.stringify({ command }) + "\n");
    } catch (e) {
      clearTimeout(entry.timer);
      const idx = _pending.indexOf(entry);
      if (idx !== -1) _pending.splice(idx, 1);
      resolve(null);
    }
  });
}

async function killServerPlayer() {
  state.playerKilled = true;
  if (state.mpvProc) {
    if (state.serverPlayer && state.serverPlayer.includes("mpv")) {
      await mpvSend(["quit"], paths.MPV_SOCKET_ARG, 1000);
      await new Promise((r) => setTimeout(r, 300));
    }
    try {
      state.mpvProc.kill();
    } catch (e) {
      /* ignore */
    }
    state.mpvProc = null;
  }
  _resetIpc(); // the mpv process (and its IPC endpoint) is gone - drop the stale connection
  if (!paths.IS_WINDOWS) {
    try {
      fs.unlinkSync(paths.MPV_SOCKET_ARG);
    } catch (e) {}
  }
}

async function pauseServerAudio() {
  if (state.mpvProc && state.serverPlayer && state.serverPlayer.includes("mpv")) {
    await mpvSend(["set_property", "pause", true]);
  }
  state.isPaused = true;
}

async function resumeServerAudio() {
  if (state.mpvProc && state.serverPlayer && state.serverPlayer.includes("mpv")) {
    await mpvSend(["set_property", "pause", false]);
  }
  state.isPaused = false;
}

/**
 * Start playing a YouTube URL: resolve the direct audio stream via yt-dlp,
 * then hand that stream URL to mpv/ffplay as a server-side subprocess.
 * Mirrors _play_server_audio in main.py.
 */
async function playServerAudio(youtubeUrl) {
  await killServerPlayer();
  state.playerKilled = false;
  state.isPaused = false;

  if (!state.serverPlayer) {
    state.serverPlayer = detectPlayer();
  }
  const player = state.serverPlayer;
  if (!player) {
    console.error("[Player] No local mpv found. Place mpv in the app folder or install it system-wide.");
    return false;
  }

  try {
    const youtube = require("./youtube"); // lazy require avoids cycles
    const streamUrl = await youtube.getAudioStreamUrl(youtubeUrl);
    const musicVol = getMusicVolume();
    const isMpv = path.basename(player).includes("mpv");

    let args;
    if (isMpv) {
      if (!paths.IS_WINDOWS) {
        try {
          fs.unlinkSync(paths.MPV_SOCKET_ARG);
        } catch (e) {}
      }
      args = [
        "--no-video",
        "--really-quiet",
        "--no-terminal",
        `--input-ipc-server=${paths.MPV_SOCKET_ARG}`,
        `--volume=${musicVol}`,
        streamUrl,
      ];
    } else {
      // ffplay fallback
      args = ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", String(musicVol), streamUrl];
    }

    const proc = spawn(player, args, { stdio: "ignore", detached: false });
    state.mpvProc = proc;
    state.currentSongStartTime = Date.now() / 1000;
    proc.on("error", (e) => console.error("[Player] spawn error:", e.message));

    if (state.currentSong) {
      try {
        require("./subtitles").startSubtitleBroadcaster(state.currentSong, state.currentSongStartTime);
      } catch (e) {
        /* subtitles are best-effort */
      }
    }
    return true;
  } catch (e) {
    console.error("[Player] Error starting player:", e.message);
    return false;
  }
}

module.exports = {
  findLocalPlayer,
  detectPlayer,
  mpvSend,
  killServerPlayer,
  pauseServerAudio,
  resumeServerAudio,
  playServerAudio,
};
