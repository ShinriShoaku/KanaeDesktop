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

/**
 * Resolution order:
 *   1. A bundled mpv downloaded by mpvManager.js (src/bin/mpv[.exe]) -
 *      checked fresh every call so a background first-run download
 *      becomes active on the very next song without an app restart.
 *      Preferred over system mpv because it's launched with --no-config
 *      (see playServerAudio), fully isolated from whatever's in the
 *      user's own ~/.config/mpv/ - which is otherwise a very common,
 *      very hard-to-diagnose source of mpv exiting near-instantly with
 *      zero log output (a misbehaving script/config option, not an
 *      actual playback failure).
 *   2. The old BASE_DIR-relative locations, for anyone who already
 *      drops their own mpv binary next to the app manually.
 *   3. Whatever "mpv" resolves to on PATH.
 */
function detectPlayer() {
  try {
    const bundled = require("./mpvManager").getMpvBin();
    if (bundled) return bundled;
  } catch (e) {
    /* mpvManager is best-effort - fall through to the old detection */
  }
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

  // Re-detect on every call rather than only when unset: this is what lets
  // a bundled mpv that finishes downloading in the background (see
  // mpvManager.js) take over on the very next song, without needing an
  // app restart. detectPlayer() is cheap (just fs.existsSync checks plus
  // one `which`/`where` call as a last resort).
  state.serverPlayer = detectPlayer();
  const player = state.serverPlayer;
  if (!player) {
    console.error("[Player] No local mpv found. Place mpv in the app folder or install it system-wide.");
    return false;
  }

  try {
    const resolvers = require("./resolvers"); // lazy require avoids cycles
    const config = require("./config");
    // Tries yt-dlp, then play-dl, then Piped (order configurable via
    // config.json's resolver_order) - falls through to the next backend
    // automatically if one fails/times out, instead of the whole playback
    // attempt failing just because e.g. yt-dlp got rate-limited (429).
    console.log(`[Player] Resolving playback link untuk ${youtubeUrl} ...`);
    const resolveStart = Date.now();
    const { streamUrl, subMap, source } = await resolvers.resolvePlaybackWithFallback(youtubeUrl, {
      order: config.getResolverOrder(),
    });
    console.log(
      `[Player] Link siap dalam ${((Date.now() - resolveStart) / 1000).toFixed(1)}s via ${source} (${
        Object.keys(subMap || {}).length
      } bahasa subtitle tersedia)`
    );
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
        "--no-config",
        // Prevents mpv from loading ~/.config/mpv/mpv.conf and any
        // scripts in ~/.config/mpv/scripts/ (e.g. the stock ytdl_hook.lua
        // trying to re-resolve a URL we've already resolved, or any
        // other user customization). A misbehaving config/script is a
        // very plausible explanation for mpv exiting almost instantly
        // with a non-zero code and *zero* output on either stdout or
        // stderr - a real internal playback error (bad stream, missing
        // codec, etc.) virtually always prints something first.
        "--no-video",
        "--no-terminal",
        // NOT --really-quiet: that suppresses mpv's error output entirely,
        // which is exactly the information we need when playback fails
        // (e.g. "Failed to open stream: 403/429", codec issues, etc).
        // all=error keeps normal operation silent but still surfaces
        // anything that actually goes wrong, and we now capture+log it
        // below instead of throwing it away (stdio was "ignore" before).
        "--msg-level=all=error",
        `--input-ipc-server=${paths.MPV_SOCKET_ARG}`,
        `--volume=${musicVol}`,
        streamUrl,
      ];
    } else {
      // ffplay fallback
      args = ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", String(musicVol), streamUrl];
    }

    const proc = spawn(player, args, { stdio: ["ignore", "pipe", "pipe"], detached: false });
    state.mpvProc = proc;
    state.currentSongStartTime = Date.now() / 1000;

    // Both stdout AND stderr were previously discarded/half-discarded, so
    // whenever mpv failed to actually play something (expired/rate-limited
    // stream URL, network error, bad option, etc.) there was zero
    // visibility into why - the song just silently died.
    //
    // IMPORTANT: unlike most CLI tools, mpv writes its actual log/error
    // messages to STDOUT, not stderr (stderr is mostly used for its
    // interactive status line). Piping only stderr - as this used to do -
    // meant the real failure reason was thrown away every time, and only
    // the unhelpful "no error output - probably killed externally" guess
    // ever got logged. Capture both and print whichever has content.
    const playerName = path.basename(player);
    let outputTail = "";
    const captureOutput = (chunk) => {
      outputTail = (outputTail + chunk.toString("utf-8")).slice(-4000);
    };
    if (proc.stdout) proc.stdout.on("data", captureOutput);
    if (proc.stderr) proc.stderr.on("data", captureOutput);

    // If mpv still exits with ZERO output on both streams, that's no longer
    // something we can diagnose from inside Node - it means mpv never got a
    // chance to log anything at all (killed by something external: AV/
    // Defender, sandboxing, an audio-driver crash, OOM, etc). Log the exact
    // command so it can be re-run by hand, directly in a terminal, to see
    // mpv's real behavior with zero Node involvement.
    const reproCmd = `${player} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`;

    proc.on("error", (e) => console.error(`[Player] Gagal spawn ${playerName}:`, e.message));

    proc.on("exit", (code, signal) => {
      const elapsed = (Date.now() / 1000 - state.currentSongStartTime).toFixed(1);
      if (state.playerKilled) {
        // Intentional stop/skip - not an error, nothing to log.
        return;
      }
      if (code !== 0 || signal || Number(elapsed) < 3) {
        console.error(
          `[Player] ${playerName} berhenti nggak wajar setelah ${elapsed}s (exit code=${code}, signal=${signal || "-"}) [pid=${proc.pid}].` +
            (outputTail.trim()
              ? ` ${playerName} output:\n${outputTail.trim()}`
              : ` (tidak ada output sama sekali dari ${playerName} - kemungkinan proses ke-kill paksa dari luar, misal antivirus/OOM/driver audio crash.` +
                ` Coba jalankan manual buat lihat penyebab aslinya:\n${reproCmd})`)
        );
      } else {
        console.log(`[Player] ${playerName} selesai memutar setelah ${elapsed}s (code=${code}).`);
      }
    });

    if (state.currentSong) {
      try {
        require("./subtitles").startSubtitleBroadcaster(state.currentSong, state.currentSongStartTime, subMap);
      } catch (e) {
        /* subtitles are best-effort */
      }
    }
    return true;
  } catch (e) {
    console.error("[Player] Error starting player (gagal resolve link sebelum sempat mutar):", e.message);
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
