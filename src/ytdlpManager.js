"use strict";
/**
 * Manages the yt-dlp binary lifecycle so the user never has to install or
 * update it manually:
 *
 *   1. First run (no local binary yet)  -> downloads the latest yt-dlp
 *      standalone release straight from GitHub into <BASE_DIR>/bin/.
 *   2. Every subsequent run             -> compares the installed version
 *      (via `yt-dlp --version`) against the latest GitHub tag, and
 *      silently updates the local binary if a newer one is out.
 *   3. Offline / GitHub unreachable     -> falls back to whatever binary
 *      is already there (or "yt-dlp" on PATH) instead of failing startup.
 *
 * The actual binary download always goes through GitHub's stable
 * ".../releases/latest/download/<asset>" redirect, NOT the GitHub REST
 * API - that endpoint doesn't count against the (fairly low, 60/hr)
 * unauthenticated API rate limit, so first-run bootstrapping still works
 * even from a shared/NAT'd IP that has used up its API quota. The REST
 * API is only used for the lightweight "is there a newer tag" check.
 *
 * IMPORTANT - this runs in the BACKGROUND, non-blocking:
 * startEnsureYtdlp() kicks the whole process off and returns immediately;
 * it does NOT block server startup (a first-run download of a ~20-30MB
 * binary can take longer than the Electron desktop shell's
 * backend-readiness timeout, so awaiting it before the HTTP server starts
 * listening would make the desktop app think the backend crashed).
 * Anything that actually needs to *run* yt-dlp should `await
 * waitUntilReady()` first - that resolves as soon as a usable binary
 * exists, whether that's instant (already up to date) or after the
 * download finishes.
 *
 * Progress is reported two ways:
 *   - console.log, for the terminal (kept for parity with the rest of the app)
 *   - onStatus(callback), for the desktop/web UI - server.js wires this to
 *     an SSE broadcast ("ytdlp_status") so compact.html can show a toast.
 *
 * Set YTDLP_PATH to point at your own yt-dlp install to skip all of this
 * (e.g. a system package you keep updated yourself).
 *
 * youtube.js calls getYtdlpBin() (instead of hardcoding a path) so it
 * always picks up whichever binary this manager last resolved.
 */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const paths = require("./paths");

const BIN_DIR = path.join(paths.BASE_DIR, "bin");
const GITHUB_REPO = "yt-dlp/yt-dlp";
const GITHUB_API_LATEST = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const API_TIMEOUT_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 180000; // standalone builds are ~20-30MB

function targetAssetName() {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === "win32") return "yt-dlp.exe";
  if (plat === "darwin") return "yt-dlp_macos";
  // linux and anything else falls through to the linux standalone builds
  if (arch === "arm64") return "yt-dlp_linux_aarch64";
  if (arch === "arm") return "yt-dlp_linux_armv7l";
  return "yt-dlp_linux";
}

function directDownloadUrl() {
  return `https://github.com/${GITHUB_REPO}/releases/latest/download/${targetAssetName()}`;
}

function localBinPath() {
  const name = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  return path.join(BIN_DIR, name);
}

// ── Status event bus (for UI notifications) ──────────────────────
// Statuses: "checking" | "downloading" | "updating" | "ready" | "up_to_date"
//         | "skipped" (YTDLP_PATH override) | "error"
const _statusListeners = new Set();

function onStatus(cb) {
  _statusListeners.add(cb);
  return () => _statusListeners.delete(cb);
}

function emitStatus(status, data = {}) {
  for (const cb of _statusListeners) {
    try {
      cb(status, data);
    } catch (e) {
      /* a bad listener shouldn't break the download */
    }
  }
}

// Resolved once ensureYtdlp() has run; getYtdlpBin() falls back sanely before/without it.
let _resolvedPath = null;
// Cached in-flight/completed run, so startEnsureYtdlp() is safe to call more
// than once (e.g. a manual re-check from the UI) without starting a second
// download on top of one already in progress.
let _readyPromise = null;

/** The path youtube.js should invoke yt-dlp with. Safe to call at any time. */
function getYtdlpBin() {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  if (_resolvedPath) return _resolvedPath;
  const local = localBinPath();
  if (fs.existsSync(local)) return local;
  return "yt-dlp"; // last resort: hope it's on PATH
}

/** Latest release tag from the GitHub API, or null if unreachable/rate-limited. yt-dlp tags exactly match its `--version` output (e.g. "2024.08.06"). */
async function fetchLatestTag() {
  try {
    const resp = await fetch(GITHUB_API_LATEST, {
      headers: { "User-Agent": "KanaeDesktop-ytdlpManager" },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.tag_name ? String(data.tag_name).trim() : null;
  } catch (e) {
    return null;
  }
}

async function downloadLatestBinary(destPath) {
  const resp = await fetch(directDownloadUrl(), {
    headers: { "User-Agent": "KanaeDesktop-ytdlpManager" },
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!resp.ok || !resp.body) throw new Error(`Download failed with HTTP ${resp.status}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.download`;
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, destPath);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(destPath, 0o755);
    } catch (e) {
      /* best effort */
    }
  }
}

/** Runs `<binPath> --version`, returns the trimmed output or null if it fails. */
function getInstalledVersion(binPath) {
  return new Promise((resolve) => {
    execFile(binPath, ["--version"], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout).trim() || null);
    });
  });
}

/**
 * Does the actual work. Never throws - any failure just falls back to the
 * best already-available option, the same "best effort" philosophy as the
 * app's own update checker (version.js). Prefer startEnsureYtdlp() /
 * waitUntilReady() over calling this directly from app code.
 */
async function ensureYtdlp() {
  if (process.env.YTDLP_PATH) {
    console.log(`[yt-dlp] YTDLP_PATH diset manual -> pakai: ${process.env.YTDLP_PATH}`);
    emitStatus("skipped", { path: process.env.YTDLP_PATH });
    return { path: process.env.YTDLP_PATH, updated: false };
  }

  const local = localBinPath();
  const existsLocally = fs.existsSync(local);

  // ── First run: nothing local yet, just grab the latest build ──
  if (!existsLocally) {
    console.log(`[yt-dlp] Belum ada yt-dlp - downloading ${targetAssetName()} (first run)...`);
    emitStatus("downloading", { firstRun: true });
    try {
      await downloadLatestBinary(local);
      _resolvedPath = local;
      const ver = await getInstalledVersion(local);
      console.log(`[yt-dlp] Siap dipakai${ver ? ` (versi ${ver})` : ""}: ${local}`);
      emitStatus("ready", { version: ver, firstRun: true });
      return { path: local, updated: true };
    } catch (e) {
      console.error(
        `[yt-dlp] Download gagal (${e.message}). Install manual: pip install yt-dlp (atau taruh binary "yt-dlp" di PATH), lalu restart.`
      );
      emitStatus("error", { message: e.message, firstRun: true });
      return { path: getYtdlpBin(), updated: false };
    }
  }

  // ── Already installed: check whether a newer release exists ──
  emitStatus("checking", {});
  const [localVer, latestTag] = await Promise.all([getInstalledVersion(local), fetchLatestTag()]);

  if (!latestTag) {
    _resolvedPath = local;
    console.log(
      `[yt-dlp] Cek update gagal (GitHub tidak bisa dihubungi/rate limit) - pakai versi lokal${localVer ? ` (${localVer})` : ""}.`
    );
    emitStatus("up_to_date", { version: localVer, checkFailed: true });
    return { path: local, updated: false };
  }

  if (localVer && localVer === latestTag) {
    _resolvedPath = local;
    console.log(`[yt-dlp] Versi ${localVer} - sudah versi terbaru.`);
    emitStatus("up_to_date", { version: localVer });
    return { path: local, updated: false };
  }

  console.log(`[yt-dlp] Update tersedia: ${localVer || "?"} -> ${latestTag}. Downloading...`);
  emitStatus("updating", { from: localVer, to: latestTag });
  try {
    await downloadLatestBinary(local);
    _resolvedPath = local;
    const ver = await getInstalledVersion(local);
    console.log(`[yt-dlp] Berhasil update ke ${ver || latestTag}.`);
    emitStatus("ready", { version: ver || latestTag, updated: true });
    return { path: local, updated: true };
  } catch (e) {
    _resolvedPath = local;
    console.error(`[yt-dlp] Download update gagal (${e.message}) - tetap pakai versi lokal${localVer ? ` (${localVer})` : ""}.`);
    emitStatus("error", { message: e.message, version: localVer });
    return { path: local, updated: false };
  }
}

/**
 * Kicks off ensureYtdlp() in the background and caches the promise so
 * repeated calls (e.g. a manual "check for update" button) reuse the same
 * in-flight run instead of starting a second download. Does NOT block -
 * call this after the HTTP server is already listening.
 */
function startEnsureYtdlp() {
  if (!_readyPromise) {
    _readyPromise = ensureYtdlp();
  }
  return _readyPromise;
}

/** Resolves once a yt-dlp binary is ready to use. Starts the check/download if it hasn't been started yet. Never rejects. */
function waitUntilReady() {
  return startEnsureYtdlp();
}

module.exports = { ensureYtdlp, startEnsureYtdlp, waitUntilReady, onStatus, getYtdlpBin, localBinPath };
