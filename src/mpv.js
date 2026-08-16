"use strict";

/**
 * mpv detection + JSON IPC control.
 *
 * KanaeDesktop
 *
 * Playback flow:
 *
 * YouTube URL
 *      ↓
 * resolver / yt-dlp
 *      ↓
 * direct googlevideo audio URL
 *      ↓
 * mpv
 *
 * Important:
 * - mpv is launched with --no-config
 * - audio-only playback
 * - stdout + stderr are captured
 * - mpv uses info logging so playback errors are visible
 * - IPC connection is persistent
 * - invalid legacy --question argument is filtered defensively
 */

const {
  spawn,
  execFileSync,
} = require("child_process");

const net = require("net");
const fs = require("fs");
const path = require("path");

const paths = require("./paths");
const { state } = require("./state");
const ytdlpManager = require("./ytdlpManager");
const cookies = require("./cookies");

// ─────────────────────────────────────────────────────────────
// PLAYER DETECTION
// ─────────────────────────────────────────────────────────────

function findLocalPlayer(name) {
  const candidates = [
    path.join(
      paths.BASE_DIR,
      paths.IS_WINDOWS
        ? `${name}.exe`
        : name
    ),

    path.join(
      paths.BASE_DIR,
      "mpv",
      paths.IS_WINDOWS
        ? `${name}.exe`
        : name
    ),

    path.join(
      paths.BASE_DIR,
      "bin",
      paths.IS_WINDOWS
        ? `${name}.exe`
        : name
    ),
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
 * 1. MPV_PATH
 * 2. bundled mpv from mpvManager
 * 3. BASE_DIR/mpv
 * 4. BASE_DIR/bin/mpv
 * 5. system mpv from PATH
 */
function detectPlayer() {
  // Explicit override.
  if (process.env.MPV_PATH) {
    try {
      if (
        fs.existsSync(
          process.env.MPV_PATH
        )
      ) {
        return process.env.MPV_PATH;
      }
    } catch (e) {
      // Fall through.
    }

    // Allow PATH-style MPV_PATH.
    if (
      !path.isAbsolute(
        process.env.MPV_PATH
      )
    ) {
      return process.env.MPV_PATH;
    }
  }

  // Bundled mpv.
  try {
    const bundled =
      require("./mpvManager").getMpvBin();

    if (bundled) {
      return bundled;
    }
  } catch (e) {
    console.warn(
      `[Player] mpvManager detection failed: ${e.message}`
    );
  }

  // Local manual mpv.
  const local =
    findLocalPlayer("mpv");

  if (local) {
    return local;
  }

  // System PATH.
  try {
    execFileSync(
      paths.IS_WINDOWS
        ? "where"
        : "which",
      ["mpv"],
      {
        stdio: [
          "ignore",
          "pipe",
          "ignore",
        ],
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

function validateMpvBinary(player) {
  if (!player) {
    return {
      valid: false,
      version: null,
      error: "mpv path kosong",
    };
  }

  try {
    if (
      path.isAbsolute(player) &&
      !fs.existsSync(player)
    ) {
      return {
        valid: false,
        version: null,
        error:
          "file mpv tidak ditemukan",
      };
    }
  } catch (e) {
    return {
      valid: false,
      version: null,
      error: e.message,
    };
  }

  try {
    const result =
      execFileSync(
        player,
        [
          "--no-config",
          "--version",
        ],
        {
          encoding: "utf8",
          timeout: 10000,
          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        }
      );

    const output =
      String(result || "").trim();

    if (!output) {
      return {
        valid: false,
        version: null,
        error:
          "mpv tidak memberikan output version",
      };
    }

    const firstLine =
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);

    if (
      !firstLine ||
      !/\bmpv\b/i.test(firstLine)
    ) {
      return {
        valid: false,
        version: null,
        error:
          `Executable bukan mpv: ${firstLine || "(empty)"}`,
      };
    }

    return {
      valid: true,
      version: firstLine,
      error: null,
    };
  } catch (e) {
    return {
      valid: false,
      version: null,
      error:
        e && e.message
          ? e.message
          : String(e),
    };
  }
}

// ─────────────────────────────────────────────────────────────
// ARGUMENT SANITIZATION
// ─────────────────────────────────────────────────────────────

/**
 * mpv does NOT have --question.
 *
 * Keep this filter because old builds / future code / injected
 * arguments should never be able to break playback with this
 * invalid option.
 */
function sanitizeMpvArgs(args) {
  if (!Array.isArray(args)) {
    return [];
  }

  const result = [];

  const removed = [];

  for (const raw of args) {
    const arg = String(raw);

    if (
      arg === "--question" ||
      arg.startsWith(
        "--question="
      )
    ) {
      removed.push(arg);
      continue;
    }

    result.push(arg);
  }

  if (removed.length > 0) {
    console.warn(
      `[Player] Removed invalid mpv option(s): ${removed.join(", ")}`
    );
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// COMMAND FORMATTER
// ─────────────────────────────────────────────────────────────

function shellQuote(value) {
  const text =
    String(value);

  if (
    /^[a-zA-Z0-9_./:=+@%-]+$/.test(
      text
    )
  ) {
    return text;
  }

  return (
    "'" +
    text.replace(
      /'/g,
      "'\\''"
    ) +
    "'"
  );
}

function formatCommand(
  executable,
  args
) {
  return [
    shellQuote(executable),
    ...args.map(shellQuote),
  ].join(" ");
}

// ─────────────────────────────────────────────────────────────
// VOLUME
// ─────────────────────────────────────────────────────────────

function getMusicVolume() {
  const volume =
    Number(
      state.musicVolume
    );

  if (
    !Number.isFinite(volume)
  ) {
    return 100;
  }

  return Math.max(
    0,
    Math.min(
      100,
      volume
    )
  );
}

// ─────────────────────────────────────────────────────────────
// IPC
// ─────────────────────────────────────────────────────────────

let _ipcSocket = null;

let _ipcConnecting = null;

let _ipcBuf = "";

let _pending = [];

// ─────────────────────────────────────────────────────────────
// RESET IPC
// ─────────────────────────────────────────────────────────────

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

  _ipcConnecting = null;

  _ipcBuf = "";

  for (
    const pending of _pending
  ) {
    try {
      clearTimeout(
        pending.timer
      );

      pending.resolve(null);
    } catch (e) {
      // Ignore.
    }
  }

  _pending = [];
}

// ─────────────────────────────────────────────────────────────
// CONNECT IPC
// ─────────────────────────────────────────────────────────────

function _getIpcSocket(
  socketPath
) {
  if (
    _ipcSocket &&
    !_ipcSocket.destroyed
  ) {
    return Promise.resolve(
      _ipcSocket
    );
  }

  if (_ipcConnecting) {
    return _ipcConnecting;
  }

  _ipcConnecting =
    new Promise(
      (resolve, reject) => {
        const sock =
          net.createConnection(
            socketPath
          );

        let failed = false;

        const onFailure =
          (err) => {
            if (failed) {
              return;
            }

            failed = true;

            _ipcConnecting = null;

            _resetIpc();

            reject(
              err ||
                new Error(
                  "mpv IPC connect failed"
                )
            );
          };

        sock.once(
          "error",
          onFailure
        );

        sock.once(
          "connect",
          () => {
            if (failed) {
              return;
            }

            sock.removeListener(
              "error",
              onFailure
            );

            // ─────────────────────────────────
            // MPV IPC DATA
            // ─────────────────────────────────

            sock.on(
              "data",
              (chunk) => {
                _ipcBuf +=
                  chunk.toString(
                    "utf8"
                  );

                const lines =
                  _ipcBuf.split(
                    "\n"
                  );

                _ipcBuf =
                  lines.pop() || "";

                for (
                  const line of lines
                ) {
                  if (
                    !line.trim()
                  ) {
                    continue;
                  }

                  let parsed;

                  try {
                    parsed =
                      JSON.parse(
                        line
                      );
                  } catch (e) {
                    continue;
                  }

                  if (
                    Object.prototype.hasOwnProperty.call(
                      parsed,
                      "error"
                    )
                  ) {
                    const pending =
                      _pending.shift();

                    if (pending) {
                      clearTimeout(
                        pending.timer
                      );

                      pending.resolve(
                        parsed
                      );
                    }
                  }
                }
              }
            );

            sock.on(
              "close",
              () => {
                if (
                  _ipcSocket ===
                  sock
                ) {
                  _ipcSocket =
                    null;
                }
              }
            );

            sock.on(
              "error",
              () => {
                if (
                  _ipcSocket ===
                  sock
                ) {
                  _resetIpc();
                }
              }
            );

            _ipcSocket =
              sock;

            _ipcConnecting =
              null;

            resolve(sock);
          }
        );
      }
    );

  return _ipcConnecting;
}

// ─────────────────────────────────────────────────────────────
// SEND IPC COMMAND
// ─────────────────────────────────────────────────────────────

async function mpvSend(
  command,
  socketPath =
    paths.MPV_SOCKET_ARG,
  timeout = 2000
) {
  let sock;

  try {
    sock =
      await _getIpcSocket(
        socketPath
      );
  } catch (e) {
    return null;
  }

  return new Promise(
    (resolve) => {
      const entry = {
        resolve,
        timer: null,
      };

      entry.timer =
        setTimeout(
          () => {
            const index =
              _pending.indexOf(
                entry
              );

            if (index !== -1) {
              _pending.splice(
                index,
                1
              );
            }

            resolve(null);
          },
          timeout
        );

      _pending.push(entry);

      try {
        sock.write(
          JSON.stringify({
            command,
          }) + "\n"
        );
      } catch (e) {
        clearTimeout(
          entry.timer
        );

        const index =
          _pending.indexOf(
            entry
          );

        if (index !== -1) {
          _pending.splice(
            index,
            1
          );
        }

        resolve(null);
      }
    }
  );
}

// ─────────────────────────────────────────────────────────────
// STOP PLAYER
// ─────────────────────────────────────────────────────────────

async function killServerPlayer() {
  state.playerKilled = true;

  // ─────────────────────────────────────────
  // Kill yt-dlp pipe process first.
  // ─────────────────────────────────────────

  if (state.ytdlpProc) {
    try {
      state.ytdlpProc.kill("SIGTERM");
    } catch (e) {}

    state.ytdlpProc = null;
  }

  // ─────────────────────────────────────────
  // Kill mpv.
  // ─────────────────────────────────────────

  if (state.mpvProc) {
    if (
      state.serverPlayer &&
      state.serverPlayer.includes("mpv")
    ) {
      await mpvSend(
        ["quit"],
        paths.MPV_SOCKET_ARG,
        1000
      );

      await new Promise(
        (resolve) =>
          setTimeout(resolve, 300)
      );
    }

    try {
      state.mpvProc.kill();
    } catch (e) {}

    state.mpvProc = null;
  }

  // ─────────────────────────────────────────
  // Reset IPC.
  // ─────────────────────────────────────────

  _resetIpc();

  if (!paths.IS_WINDOWS) {
    try {
      fs.unlinkSync(
        paths.MPV_SOCKET_ARG
      );
    } catch (e) {}
  }
}

// ─────────────────────────────────────────────────────────────
// PAUSE
// ─────────────────────────────────────────────────────────────

async function pauseServerAudio() {
  if (
    state.mpvProc &&
    state.serverPlayer &&
    state.serverPlayer
      .toLowerCase()
      .includes("mpv")
  ) {
    await mpvSend([
      "set_property",
      "pause",
      true,
    ]);
  }

  state.isPaused =
    true;
}

// ─────────────────────────────────────────────────────────────
// RESUME
// ─────────────────────────────────────────────────────────────

async function resumeServerAudio() {
  if (
    state.mpvProc &&
    state.serverPlayer &&
    state.serverPlayer
      .toLowerCase()
      .includes("mpv")
  ) {
    await mpvSend([
      "set_property",
      "pause",
      false,
    ]);
  }

  state.isPaused =
    false;
}

// ─────────────────────────────────────────────────────────────
// PLAY SERVER AUDIO
// ─────────────────────────────────────────────────────────────

// Serializes playServerAudio() calls so two overlapping requests (e.g. two
// #skip commands arriving from TikTok chat within the same second) can never
// both be mid-resolve/mid-spawn at once. Without this, both calls would race
// past killServerPlayer() before either had spawned anything, each spawn its
// own mpv process, and then stomp on each other's state.mpvProc /
// state.currentSong / state.currentSongStartTime - which is what caused
// orphaned/duplicate audio processes and lyrics that belonged to a
// different song than whatever was actually audible.
let _playbackLock = Promise.resolve();

async function playServerAudio(
  youtubeUrl,
  song = null
) {
  const myToken = ++state.playbackToken;

  const run = _playbackLock.then(() =>
    _playServerAudioLocked(youtubeUrl, song, myToken)
  );

  // Keep the chain alive even if this attempt throws/returns false, so the
  // next queued call still gets its turn.
  _playbackLock = run.catch(() => {});

  return run;
}

async function _playServerAudioLocked(
  youtubeUrl,
  song,
  myToken
) {
  // A newer playServerAudio() call was made while this one was waiting for
  // its turn - it already knows more recent queue state (e.g. a later
  // #skip), so bail out instead of briefly playing/showing lyrics for a
  // song that's already been skipped past.
  if (state.playbackToken !== myToken) {
    return false;
  }

  await killServerPlayer();

  state.playerKilled = false;
  state.isPaused = false;

  // Re-detect player every time so bundled mpv
  // becomes active immediately after download.
  state.serverPlayer =
    detectPlayer();

  const player =
    state.serverPlayer;

  if (!player) {
    console.error(
      "[Player] No local mpv found. Place mpv in the app folder or install it system-wide."
    );

    return false;
  }

  try {
    const resolvers =
      require("./resolvers");

    const config =
      require("./config");

    console.log(
      `[Player] Resolving playback untuk ${youtubeUrl} ...`
    );

    const resolveStart =
      Date.now();

    const {
      streamUrl,
      playbackUrl,
      playbackMode,
      subMap,
      source,
    } =
      await resolvers.resolvePlaybackWithFallback(
        youtubeUrl,
        {
          order:
            config.getResolverOrder(),
        }
      );

    const resolveMs =
      Date.now() -
      resolveStart;

    console.log(
      `[Player] Resolver selesai dalam ${(resolveMs / 1000).toFixed(1)}s via ${source}`
    );

    console.log(
      `[Player] Playback mode: ${
        playbackMode || "direct"
      }`
    );

    // ───────────────────────────────────────
    // Validate result.
    // ───────────────────────────────────────

    const useYtdlpPipe =
      playbackMode ===
      "ytdlp-pipe";

    if (
      !useYtdlpPipe &&
      !streamUrl
    ) {
      throw new Error(
        "Resolver tidak menghasilkan stream URL"
      );
    }

    if (
      useYtdlpPipe &&
      !playbackUrl
    ) {
      throw new Error(
        "yt-dlp pipe membutuhkan playbackUrl"
      );
    }

    // ───────────────────────────────────────
    // Volume.
    // ───────────────────────────────────────

    const musicVol =
      Math.max(
        0,
        Math.min(
          150,
          Number(
            getMusicVolume()
          ) || 100
        )
      );

    const isMpv =
      path
        .basename(player)
        .toLowerCase()
        .includes("mpv");

    let args;

    // ───────────────────────────────────────
    // MPV
    // ───────────────────────────────────────

    if (isMpv) {
      if (!paths.IS_WINDOWS) {
        try {
          fs.unlinkSync(
            paths.MPV_SOCKET_ARG
          );
        } catch (e) {}
      }

      args = [
        "--no-config",

        // IMPORTANT:
        // Never let mpv/ytdl_hook resolve the
        // YouTube URL again.
        "--ytdl=no",

        "--no-video",
        "--no-terminal",

        "--msg-level=all=info",

        `--input-ipc-server=${paths.MPV_SOCKET_ARG}`,

        `--volume=${musicVol}`,

        "--audio-display=no",

        // Input:
        //
        // ytdlp-pipe => stdin
        // direct     => resolved URL
        "--",
        useYtdlpPipe
          ? "-"
          : streamUrl,
      ];

    } else {
      // ffplay fallback.
      //
      // Pipe mode also works here because ffplay
      // accepts stdin as input.
      args = useYtdlpPipe
        ? [
            "-nodisp",
            "-autoexit",
            "-loglevel",
            "info",
            "-volume",
            String(
              musicVol
            ),
            "-",
          ]
        : [
            "-nodisp",
            "-autoexit",
            "-loglevel",
            "quiet",
            "-volume",
            String(
              musicVol
            ),
            streamUrl,
          ];
    }

    console.log(
      `[Player] Executable: ${player}`
    );

    console.log(
      `[Player] Args: ${JSON.stringify(args)}`
    );

    // ───────────────────────────────────────
    // Spawn mpv.
    // ───────────────────────────────────────

    const proc =
      spawn(
        player,
        args,
        {
          stdio: [
            // stdin is PIPE because yt-dlp can
            // stream audio into it.
            "pipe",

            "pipe",
            "pipe",
          ],

          detached: false,
        }
      );

    state.mpvProc =
      proc;

    state.currentSongStartTime =
      Date.now() / 1000;

    const playerName =
      path.basename(
        player
      );

    let outputTail = "";

    const captureOutput =
      (sourceName, chunk) => {
        outputTail =
          (
            outputTail +
            `\n[${sourceName}] ${chunk.toString(
              "utf8"
            )}`
          ).slice(
            -12000
          );
      };

    if (proc.stdout) {
      proc.stdout.on(
        "data",
        (chunk) => {
          captureOutput(
            "stdout",
            chunk
          );
        }
      );
    }

    if (proc.stderr) {
      proc.stderr.on(
        "data",
        (chunk) => {
          captureOutput(
            "stderr",
            chunk
          );
        }
      );
    }

    proc.on(
      "error",
      (e) => {
        console.error(
          `[Player] Gagal spawn ${playerName}:`,
          e.message
        );
      }
    );

    // ───────────────────────────────────────
    // yt-dlp PIPE
    // ───────────────────────────────────────

    if (
      useYtdlpPipe
    ) {
      console.log(
        "[Player] Starting yt-dlp streaming pipe..."
      );

      await ytdlpManager.waitUntilReady();

      const ytdlpBin =
        ytdlpManager.getYtdlpBin();

      console.log(
        `[Player] yt-dlp binary: ${ytdlpBin}`
      );

      const ytdlpArgs = [
        // Auto-loaded cookies (file or browser) + client override to dodge
        // YouTube's SABR-only web clients - see src/cookies.js.
        // Prepended first so nothing below has to know it's there.
        ...cookies.getCookieArgs(),
        ...cookies.getPlayerClientArgs(),
        ...cookies.getJsRuntimeArgs(),

        "--no-warnings",
        "--quiet",
        "--no-progress",
       // "--extractor-args",
        //"youtube:player_client=android,web_safari",
        // Prefer audio-only formats.
        "-f",
        "ba/ba*/bestaudio/b/best",

        // Force raw media stream to stdout.
        "-o",
        "-",

        // Do not write files.
        "--no-part",
        "--no-continue",

        // Input URL.
        "--",
        playbackUrl,
      ];

      console.log(
        `[Player] yt-dlp pipe args: ${JSON.stringify(
          ytdlpArgs
        )}`
      );

      const ytdlpProc =
        spawn(
          ytdlpBin,
          ytdlpArgs,
          {
            stdio: [
              "ignore",
              "pipe",
              "pipe",
            ],

            detached: false,
          }
        );

      state.ytdlpProc =
        ytdlpProc;

      let ytdlpError =
        "";

      if (
        ytdlpProc.stderr
      ) {
        ytdlpProc.stderr.on(
          "data",
          (chunk) => {
            const text =
              chunk.toString(
                "utf8"
              );

            ytdlpError =
              (
                ytdlpError +
                text
              ).slice(
                -8000
              );

            console.log(
              `[yt-dlp] ${text.trim()}`
            );
          }
        );
      }

      ytdlpProc.on(
        "error",
        (e) => {
          console.error(
            "[yt-dlp] Spawn error:",
            e.message
          );

          try {
            if (
              proc.stdin &&
              !proc.stdin.destroyed
            ) {
              proc.stdin.end();
            }
          } catch (err) {}
        }
      );

      // ─────────────────────────────────────
      // THE IMPORTANT PART:
      //
      // yt-dlp stdout -> mpv stdin
      // ─────────────────────────────────────

      ytdlpProc.stdout.pipe(
        proc.stdin
      );

      ytdlpProc.on(
        "exit",
        (
          code,
          signal
        ) => {
          if (
            state.ytdlpProc ===
            ytdlpProc
          ) {
            state.ytdlpProc =
              null;
          }

          if (
            state.playerKilled
          ) {
            return;
          }

          if (
            code !== 0 &&
            !signal
          ) {
            console.error(
              `[yt-dlp] Streaming gagal (code=${code})`
            );

            if (
              ytdlpError.trim()
            ) {
              console.error(
                `[yt-dlp] ${ytdlpError.trim()}`
              );
            }
          }

          // IMPORTANT:
          // Do NOT kill mpv immediately when yt-dlp
          // exits normally. mpv may have buffered data.
          //
          // Closing stdin is enough.
          try {
            if (
              proc.stdin &&
              !proc.stdin.destroyed
            ) {
              proc.stdin.end();
            }
          } catch (e) {}
        }
      );
    } else {
      // Direct URL mode:
      // mpv does not need stdin.
      try {
        if (
          proc.stdin &&
          !proc.stdin.destroyed
        ) {
          proc.stdin.end();
        }
      } catch (e) {}
    }

    // ───────────────────────────────────────
    // MPV EXIT
    // ───────────────────────────────────────

    proc.on(
      "exit",
      (
        code,
        signal
      ) => {
        const elapsed =
          (
            Date.now() /
              1000 -
            state.currentSongStartTime
          ).toFixed(1);

        if (
          state.playerKilled
        ) {
          return;
        }

        if (
          state.mpvProc ===
          proc
        ) {
          state.mpvProc =
            null;

          // Tell the watcher a song just ended (naturally or otherwise) so
          // it can advance the queue. Must be set here, not left for the
          // watcher to infer from state.mpvProc, because state.mpvProc is
          // already null by the time the watcher's next tick runs.
          state.mpvExited =
            true;
        }

        if (
          code !== 0 ||
          signal ||
          Number(elapsed) < 3
        ) {
          console.error(
            `[Player] ${playerName} playback FAILED after ${elapsed}s ` +
            `(code=${code}, signal=${
              signal || "-"
            }).`
          );

          if (
            outputTail.trim()
          ) {
            console.error(
              `[Player] mpv output:\n${outputTail.trim()}`
            );
          }

          if (
            useYtdlpPipe
          ) {
            console.error(
              `[Player] Playback used yt-dlp PIPE mode.`
            );
          }
        } else {
          console.log(
            `[Player] ${playerName} selesai memutar setelah ${elapsed}s.`
          );
        }
      }
    );

    // ───────────────────────────────────────
    // SUBTITLE
    // ───────────────────────────────────────

    // Use the `song` this specific call resolved subMap for - NOT
    // state.currentSong. By this point state.currentSong may already have
    // been moved on to a *different* song (e.g. a #skip that landed while
    // this resolve was still in flight), even though this call is the one
    // that ended up actually spawning mpv. Broadcasting subtitles for
    // state.currentSong in that case would show lyrics for a song other
    // than the one actually playing.
    const subtitleSong = song || state.currentSong;

    // Also double-check we weren't superseded while resolving/spawning
    // above (killServerPlayer + resolvers.resolvePlaybackWithFallback can
    // both take a while). If a newer call already grabbed the lock behind
    // us, our own audio is about to get killed anyway - don't bother
    // starting a subtitle broadcast for it.
    if (
      subtitleSong &&
      state.playbackToken === myToken
    ) {
      try {
        require("./subtitles")
          .startSubtitleBroadcaster(
            subtitleSong,
            state.currentSongStartTime,
            subMap
          );
      } catch (e) {
        // Subtitle is best-effort.
      }
    }

    return true;

  } catch (e) {
    console.error(
      "[Player] Error starting playback:",
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