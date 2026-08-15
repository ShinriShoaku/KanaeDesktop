"use strict";

/**
 * mpv detection + JSON IPC control.
 *
 * Patch:
 * - Defensive removal of invalid "--question" option.
 * - Validate mpv executable before playback.
 * - Log exact executable + arguments.
 * - Keep stdout/stderr diagnostics.
 * - Prevent stale/broken mpv binaries from silently failing.
 * - Keep persistent IPC connection.
 */

const { spawn, execFileSync } = require("child_process");
const net = require("net");
const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const { state } = require("./state");

// ─────────────────────────────────────────────────────────────
// PLAYER DETECTION
// ─────────────────────────────────────────────────────────────

function findLocalPlayer(name) {
  const candidates = [
    path.join(paths.BASE_DIR, paths.IS_WINDOWS ? `${name}.exe` : name),
    path.join(paths.BASE_DIR, "mpv", paths.IS_WINDOWS ? `${name}.exe` : name),
    path.join(paths.BASE_DIR, "bin", paths.IS_WINDOWS ? `${name}.exe` : name),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return p;
      }
    } catch (e) {
      // Ignore inaccessible candidates.
    }
  }

  return null;
}

/**
 * Resolution order:
 *
 * 1. MPV_PATH override / bundled mpv from mpvManager.
 * 2. Local mpv.
 * 3. System PATH.
 */
function detectPlayer() {
  // Explicit MPV_PATH always wins.
  if (process.env.MPV_PATH) {
    const configured = process.env.MPV_PATH;

    try {
      if (fs.existsSync(configured)) {
        return configured;
      }
    } catch (e) {
      // Fall through.
    }

    // On PATH-style values, still allow spawn to resolve it.
    if (!path.isAbsolute(configured)) {
      return configured;
    }

    console.warn(`[Player] MPV_PATH diset tetapi file tidak ditemukan: ${configured}`);
  }

  try {
    const bundled = require("./mpvManager").getMpvBin();

    if (bundled) {
      return bundled;
    }
  } catch (e) {
    console.warn(`[Player] mpvManager tidak dapat digunakan: ${e.message}`);
  }

  const local = findLocalPlayer("mpv");

  if (local) {
    return local;
  }

  // Try system PATH.
  try {
    execFileSync(
      paths.IS_WINDOWS ? "where" : "which",
      ["mpv"],
      {
        stdio: ["ignore", "pipe", "ignore"],
      }
    );

    return "mpv";
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// MPV VALIDATION
// ─────────────────────────────────────────────────────────────

/**
 * Validate that the executable is actually mpv and can start.
 *
 * Returns:
 *   {
 *     valid: true,
 *     version: "...",
 *     path: "..."
 *   }
 *
 * or:
 *   {
 *     valid: false,
 *     error: "..."
 *   }
 */
function validateMpvBinary(player) {
  if (!player) {
    return {
      valid: false,
      error: "Path mpv kosong",
    };
  }

  try {
    const result = execFileSync(
      player,
      [
        "--no-config",
        "--version",
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    const output = String(result || "").trim();

    if (!output) {
      return {
        valid: false,
        error: "mpv tidak mengembalikan output versi",
      };
    }

    const firstLine = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    if (!firstLine || !/\bmpv\b/i.test(firstLine)) {
      return {
        valid: false,
        error: `Executable bukan mpv: ${firstLine || "(empty)"}`,
      };
    }

    return {
      valid: true,
      version: firstLine,
      path: player,
    };
  } catch (e) {
    return {
      valid: false,
      error: e && e.message
        ? e.message
        : String(e),
    };
  }
}

/**
 * Defensive sanitizer.
 *
 * "--question" is NOT a valid mpv option.
 *
 * If an old build, injected argument, or future code accidentally
 * adds it, remove it before spawning mpv.
 */
function sanitizeMpvArgs(args) {
  if (!Array.isArray(args)) {
    return [];
  }

  const sanitized = [];
  const removed = [];

  for (const rawArg of args) {
    const arg = String(rawArg);

    // Exact:
    //   --question
    //
    // Also catches:
    //   --question=...
    if (
      arg === "--question" ||
      arg.startsWith("--question=")
    ) {
      removed.push(arg);
      continue;
    }

    sanitized.push(arg);
  }

  if (removed.length > 0) {
    console.warn(
      `[Player] Removed invalid mpv option(s): ${removed.join(", ")}`
    );
  }

  return sanitized;
}

/**
 * Format command for diagnostics.
 */
function formatCommand(player, args) {
  const quote = (value) => {
    const text = String(value);

    if (
      /^[a-zA-Z0-9_./:=+@%-]+$/.test(text)
    ) {
      return text;
    }

    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  };

  return `${quote(player)} ${args.map(quote).join(" ")}`;
}

// ─────────────────────────────────────────────────────────────
// VOLUME
// ─────────────────────────────────────────────────────────────

function getMusicVolume() {
  return state.musicVolume;
}

// ─────────────────────────────────────────────────────────────
// PERSISTENT IPC CONNECTION
// ─────────────────────────────────────────────────────────────

let _ipcSocket = null;
let _ipcConnecting = null;
let _ipcBuf = "";

// FIFO:
// { resolve, timer }
let _pending = [];

function _resetIpc() {
  if (_ipcSocket) {
    try {
      _ipcSocket.removeAllListeners();
      _ipcSocket.destroy();
    } catch (e) {
      // Ignore.
    }
  }

  _ipcSocket = null;
  _ipcBuf = "";

  for (const p of _pending) {
    try {
      clearTimeout(p.timer);
      p.resolve(null);
    } catch (e) {
      // Ignore.
    }
  }

  _pending = [];
}

function _getIpcSocket(socketPath) {
  if (_ipcSocket && !_ipcSocket.destroyed) {
    return Promise.resolve(_ipcSocket);
  }

  if (_ipcConnecting) {
    return _ipcConnecting;
  }

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

        // Keep incomplete trailing line.
        _ipcBuf = lines.pop();

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          let parsed;

          try {
            parsed = JSON.parse(line);
          } catch (e) {
            continue;
          }

          // Command replies have an "error" field.
          if (
            Object.prototype.hasOwnProperty.call(
              parsed,
              "error"
            )
          ) {
            const p = _pending.shift();

            if (p) {
              clearTimeout(p.timer);
              p.resolve(parsed);
            }
          }
        }
      });

      sock.on("close", () => {
        _resetIpc();
      });

      sock.on("error", () => {
        _resetIpc();
      });

      _ipcSocket = sock;
      _ipcConnecting = null;

      resolve(sock);
    });
  });

  return _ipcConnecting;
}

/**
 * Send JSON IPC command to running mpv.
 */
async function mpvSend(
  command,
  socketPath = paths.MPV_SOCKET_ARG,
  timeout = 2000
) {
  let sock;

  try {
    sock = await _getIpcSocket(socketPath);
  } catch (e) {
    return null;
  }

  return new Promise((resolve) => {
    const entry = {
      resolve,
      timer: null,
    };

    entry.timer = setTimeout(() => {
      const idx = _pending.indexOf(entry);

      if (idx !== -1) {
        _pending.splice(idx, 1);
      }

      resolve(null);
    }, timeout);

    _pending.push(entry);

    try {
      sock.write(
        JSON.stringify({ command }) + "\n"
      );
    } catch (e) {
      clearTimeout(entry.timer);

      const idx = _pending.indexOf(entry);

      if (idx !== -1) {
        _pending.splice(idx, 1);
      }

      resolve(null);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// STOP
// ─────────────────────────────────────────────────────────────

async function killServerPlayer() {
  state.playerKilled = true;

  if (state.mpvProc) {
    if (
      state.serverPlayer &&
      state.serverPlayer.toLowerCase().includes("mpv")
    ) {
      try {
        await mpvSend(
          ["quit"],
          paths.MPV_SOCKET_ARG,
          1000
        );
      } catch (e) {
        // Ignore.
      }

      await new Promise((r) => setTimeout(r, 300));
    }

    try {
      state.mpvProc.kill();
    } catch (e) {
      // Ignore.
    }

    state.mpvProc = null;
  }

  _resetIpc();

  if (!paths.IS_WINDOWS) {
    try {
      fs.unlinkSync(paths.MPV_SOCKET_ARG);
    } catch (e) {
      // Socket may not exist.
    }
  }
}

// ─────────────────────────────────────────────────────────────
// PAUSE / RESUME
// ─────────────────────────────────────────────────────────────

async function pauseServerAudio() {
  if (
    state.mpvProc &&
    state.serverPlayer &&
    state.serverPlayer.toLowerCase().includes("mpv")
  ) {
    await mpvSend([
      "set_property",
      "pause",
      true,
    ]);
  }

  state.isPaused = true;
}

async function resumeServerAudio() {
  if (
    state.mpvProc &&
    state.serverPlayer &&
    state.serverPlayer.toLowerCase().includes("mpv")
  ) {
    await mpvSend([
      "set_property",
      "pause",
      false,
    ]);
  }

  state.isPaused = false;
}

// ─────────────────────────────────────────────────────────────
// PLAY
// ─────────────────────────────────────────────────────────────

async function playServerAudio(youtubeUrl) {
  await killServerPlayer();

  state.playerKilled = false;
  state.isPaused = false;

  // Re-detect every playback.
  state.serverPlayer = detectPlayer();

  const player = state.serverPlayer;

  if (!player) {
    console.error(
      "[Player] No local mpv found. " +
      "Place mpv in the app folder or install it system-wide."
    );

    return false;
  }

  // ───────────────────────────────────────────────
  // Validate executable BEFORE resolving stream.
  // ───────────────────────────────────────────────

  const playerBaseName = path.basename(player);
  const isMpv =
    playerBaseName.toLowerCase().includes("mpv");

  if (isMpv) {
    const validation = validateMpvBinary(player);

    if (!validation.valid) {
      console.error(
        `[Player] Invalid mpv binary: ${player}`
      );

      console.error(
        `[Player] Validation error: ${validation.error}`
      );

      // If bundled binary is broken, try system mpv.
      if (
        !process.env.MPV_PATH &&
        player !== "mpv"
      ) {
        console.warn(
          "[Player] Mencoba fallback ke mpv system PATH..."
        );

        try {
          execFileSync(
            paths.IS_WINDOWS ? "where" : "which",
            ["mpv"],
            {
              stdio: [
                "ignore",
                "pipe",
                "ignore",
              ],
            }
          );

          state.serverPlayer = "mpv";
        } catch (e) {
          console.error(
            "[Player] mpv system juga tidak tersedia."
          );

          return false;
        }
      } else {
        return false;
      }
    } else {
      console.log(
        `[Player] Validated: ${validation.version}`
      );
      console.log(
        `[Player] Binary: ${validation.path}`
      );
    }
  }

  const activePlayer = state.serverPlayer;

  try {
    const resolvers = require("./resolvers");
    const config = require("./config");

    console.log(
      `[Player] Resolving playback link untuk ${youtubeUrl} ...`
    );

    const resolveStart = Date.now();

    const {
      streamUrl,
      subMap,
      source,
    } =
      await resolvers.resolvePlaybackWithFallback(
        youtubeUrl,
        {
          order: config.getResolverOrder(),
        }
      );

    console.log(
      `[Player] Link siap dalam ${(
        (Date.now() - resolveStart) /
        1000
      ).toFixed(1)}s via ${source} (${
        Object.keys(subMap || {}).length
      } bahasa subtitle tersedia)`
    );

    if (!streamUrl) {
      console.error(
        "[Player] Resolver tidak menghasilkan stream URL."
      );

      return false;
    }

    const musicVol = getMusicVolume();

    const activePlayerName =
      path.basename(activePlayer);

    const activeIsMpv =
      activePlayerName
        .toLowerCase()
        .includes("mpv");

    let args;

    if (activeIsMpv) {
      if (!paths.IS_WINDOWS) {
        try {
          fs.unlinkSync(paths.MPV_SOCKET_ARG);
        } catch (e) {
          // Socket does not exist.
        }
      }

      args = [
        "--no-config",
        "--no-video",
        "--no-terminal",
        "--msg-level=all=error",

        `--input-ipc-server=${paths.MPV_SOCKET_ARG}`,

        `--volume=${musicVol}`,

        // Explicit end-of-options marker.
        "--",

        streamUrl,
      ];
    } else {
      // ffplay fallback.
      args = [
        "-nodisp",
        "-autoexit",
        "-loglevel",
        "quiet",
        "-volume",
        String(musicVol),
        streamUrl,
      ];
    }

    // ───────────────────────────────────────────────
    // CRITICAL PATCH
    // ───────────────────────────────────────────────
    //
    // Remove "--question" if an old build / external
    // code accidentally injects it.
    //
    // mpv does NOT support --question.
    // ───────────────────────────────────────────────

    if (activeIsMpv) {
      args = sanitizeMpvArgs(args);
    }

    // ───────────────────────────────────────────────
    // Full command diagnostics.
    // ───────────────────────────────────────────────

    console.log(
      `[Player] Executable: ${activePlayer}`
    );

    console.log(
      `[Player] Args: ${JSON.stringify(args)}`
    );

    console.log(
      `[Player] Command: ${formatCommand(
        activePlayer,
        args
      )}`
    );

    // ───────────────────────────────────────────────
    // Spawn
    // ───────────────────────────────────────────────

    const proc = spawn(
      activePlayer,
      args,
      {
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
        detached: false,

        // Do not allow inherited MPV_OPTIONS-like
        // application environment variables to alter
        // normal process behavior.
        env: {
          ...process.env,
        },
      }
    );

    state.mpvProc = proc;

    state.currentSongStartTime =
      Date.now() / 1000;

    // ───────────────────────────────────────────────
    // Capture stdout/stderr
    // ───────────────────────────────────────────────

    const playerName =
      path.basename(activePlayer);

    let outputTail = "";

    const captureOutput = (chunk) => {
      outputTail = (
        outputTail +
        chunk.toString("utf-8")
      ).slice(-8000);
    };

    if (proc.stdout) {
      proc.stdout.on(
        "data",
        captureOutput
      );
    }

    if (proc.stderr) {
      proc.stderr.on(
        "data",
        captureOutput
      );
    }

    const reproCmd =
      formatCommand(
        activePlayer,
        args
      );

    proc.on("error", (e) => {
      console.error(
        `[Player] Gagal spawn ${playerName}:`,
        e.message
      );

      console.error(
        `[Player] Executable: ${activePlayer}`
      );

      console.error(
        `[Player] Args: ${JSON.stringify(args)}`
      );
    });

    proc.on(
      "exit",
      (code, signal) => {
        const elapsed = (
          Date.now() / 1000 -
          state.currentSongStartTime
        ).toFixed(1);

        if (state.playerKilled) {
          return;
        }

        if (
          code !== 0 ||
          signal ||
          Number(elapsed) < 3
        ) {
          console.error(
            `[Player] ${playerName} berhenti nggak wajar ` +
            `setelah ${elapsed}s ` +
            `(exit code=${code}, signal=${signal || "-"}) ` +
            `[pid=${proc.pid}].`
          );

          console.error(
            `[Player] Executable: ${activePlayer}`
          );

          console.error(
            `[Player] Args: ${JSON.stringify(args)}`
          );

          if (outputTail.trim()) {
            console.error(
              `[Player] ${playerName} output:\n` +
              outputTail.trim()
            );
          } else {
            console.error(
              `[Player] Tidak ada output dari ${playerName}.`
            );
          }

          console.error(
            `[Player] Reproduce command:\n${reproCmd}`
          );
        } else {
          console.log(
            `[Player] ${playerName} selesai memutar ` +
            `setelah ${elapsed}s (code=${code}).`
          );
        }
      }
    );

    if (state.currentSong) {
      try {
        require("./subtitles")
          .startSubtitleBroadcaster(
            state.currentSong,
            state.currentSongStartTime,
            subMap
          );
      } catch (e) {
        // Subtitles are best-effort.
      }
    }

    return true;
  } catch (e) {
    console.error(
      "[Player] Error starting player:",
      e.message
    );

    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────

module.exports = {
  findLocalPlayer,
  detectPlayer,
  validateMpvBinary,
  sanitizeMpvArgs,
  mpvSend,
  killServerPlayer,
  pauseServerAudio,
  resumeServerAudio,
  playServerAudio,
};