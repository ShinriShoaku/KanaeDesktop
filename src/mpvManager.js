"use strict";
/**
 * Manages a portable/bundled mpv binary, mirroring ytdlpManager.js, so
 * playback doesn't depend on whatever mpv build happens to be installed
 * system-wide.
 *
 * Why this exists: a system mpv can misbehave in ways that are basically
 * impossible to diagnose from inside this app - a user's own
 * ~/.config/mpv/mpv.conf or ~/.config/mpv/scripts/*.lua (e.g. the
 * built-in ytdl_hook trying to re-resolve a URL we already resolved),
 * distro patches, snap/flatpak sandboxing, etc. can all make mpv exit
 * near-instantly with zero output on either stdout or stderr - which is
 * exactly the "exit code=2, no output at all" symptom this was built to
 * rule out. A bundled mpv is launched with --no-config (see mpv.js) so
 * none of the user's own mpv config/scripts get a chance to interfere.
 *
 *   1. First run (no local binary yet)  -> downloads a portable mpv
 *      build into <BASE_DIR>/bin/ and prefers it over anything on PATH.
 *   2. Every subsequent run             -> compares the installed
 *      version against the latest upstream release and silently updates
 *      if a newer one is out (same policy as ytdlpManager).
 *   3. Offline / source unreachable     -> falls back to whatever binary
 *      is already there, and ultimately to system-wide detection in
 *      mpv.js, instead of failing startup.
 *
 * Sources (mpv itself doesn't publish official portable Linux/Windows
 * binaries, so these are the community builds mpv.io's own install page
 * points people to / that are widely used for this purpose):
 *   - Linux:   pkgforge-dev/mpv-AppImage - single-file x86_64/aarch64
 *     AppImage, no FUSE required (bundled uruntime), so it can just be
 *     chmod +x'd and spawned directly like a normal binary.
 *   - Windows/macOS: no similarly simple single-file community build
 *     exists yet for this manager - falls through to system-wide
 *     detection there for now (unaffected: this whole class of bug was
 *     Linux-config-script specific).
 *
 * Set MPV_PATH to point at your own mpv install to skip all of this.
 */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const paths = require("./paths");

const BIN_DIR = path.join(paths.BASE_DIR, "bin");
const API_TIMEOUT_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 300000; // mpv AppImages are ~60-90MB

// Only Linux has a source wired up right now (see file header). Windows/
// macOS simply never get a local candidate, so getMpvBin() returns null
// and mpv.js's existing system-wide detectPlayer() logic takes over
// exactly as it did before this file existed.
const GITHUB_REPO = "pkgforge-dev/mpv-AppImage";
const RELEASES_LATEST_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;

function isSupportedPlatform() {
  return process.platform === "linux";
}

function archPattern() {
  // pkgforge-dev's asset names embed both the mpv version and the arch
  // (e.g. "mpv-v0.41.0-anylinux-x86_64.AppImage") - match loosely on arch
  // rather than hardcoding a full filename, since the version segment
  // changes on every release.
  if (process.arch === "arm64") return /(aarch64|arm64)/i;
  return /(x86_64|amd64|x64)/i;
}

function localBinPath() {
  return path.join(BIN_DIR, "mpv");
}

// ── Status event bus (mirrors ytdlpManager's, for UI notifications) ──
// Statuses: "checking" | "downloading" | "updating" | "ready" | "up_to_date"
//         | "skipped" (MPV_PATH override) | "unsupported_platform" | "error"
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

let _readyPromise = null;

/**
 * The bundled mpv path if one is actually present on disk right now, or
 * null otherwise. Deliberately does a fresh fs.existsSync() check every
 * call (cheap) instead of trusting a cached flag, so mpv.js picks up a
 * background-downloaded binary on the very next song without needing an
 * app restart.
 */
function getMpvBin() {
  if (process.env.MPV_PATH) return process.env.MPV_PATH;
  const local = localBinPath();
  if (fs.existsSync(local)) return local;
  return null;
}

/**
 * Finds the latest release's matching AppImage asset WITHOUT touching
 * api.github.com - that REST endpoint has a low (60/hr) unauthenticated
 * rate limit that's easy to exhaust on a shared/NAT'd IP, which would
 * make mpv startup unreliable for no good reason. Instead:
 *   1. Follow the redirect on /releases/latest (a normal webpage, not
 *      the API) to read the actual latest tag out of the final URL.
 *   2. Fetch /releases/expanded_assets/<tag> - the small HTML fragment
 *      GitHub's own release page fetches client-side to render the
 *      asset list - and regex out the real download filenames. Neither
 *      of these counts against the API rate limit.
 *   3. Build the final download URL via the *stable*
 *      /releases/latest/download/<filename> redirect (same trick
 *      ytdlpManager.js's directDownloadUrl() uses), so the actual binary
 *      fetch always gets whatever is current even if this info goes
 *      slightly stale.
 */
async function findLatestAsset() {
  const latestResp = await fetch(RELEASES_LATEST_PAGE, {
    headers: { "User-Agent": "KanaeDesktop-mpvManager" },
    redirect: "follow",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!latestResp.ok) throw new Error(`GitHub releases page responded with HTTP ${latestResp.status}`);
  const tagMatch = latestResp.url.match(/\/releases\/tag\/([^/]+)$/);
  if (!tagMatch) throw new Error("Tidak bisa membaca tag rilis terbaru dari GitHub");
  const tag = decodeURIComponent(tagMatch[1]);

  const assetsResp = await fetch(`https://github.com/${GITHUB_REPO}/releases/expanded_assets/${encodeURIComponent(tag)}`, {
    headers: { "User-Agent": "KanaeDesktop-mpvManager" },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!assetsResp.ok) throw new Error(`GitHub expanded_assets responded with HTTP ${assetsResp.status}`);
  const html = await assetsResp.text();
  const names = [...new Set([...html.matchAll(/\/releases\/download\/[^"]*\/([^"/]+)/g)].map((m) => m[1]))];

  const arch = archPattern();
  const name = names.find((n) => /\.AppImage$/i.test(n) && !/\.zsync$/i.test(n) && arch.test(n));
  if (!name) throw new Error(`Tidak ada AppImage yang cocok untuk arch ${process.arch} di release terbaru (${tag})`);

  return { url: `https://github.com/${GITHUB_REPO}/releases/latest/download/${name}`, tag, name };
}

async function downloadAsset(url, destPath) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "KanaeDesktop-mpvManager" },
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!resp.ok || !resp.body) throw new Error(`Download failed with HTTP ${resp.status}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.download`;
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, destPath);
  try {
    fs.chmodSync(destPath, 0o755);
  } catch (e) {
    /* best effort */
  }
}

/** Runs `<binPath> --version`, returns the trimmed first line or null if it fails. Used only for the startup log line, not version comparison. */
function getInstalledVersion(binPath) {
  return new Promise((resolve) => {
    execFile(binPath, ["--no-config", "--version"], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      const firstLine = String(stdout).trim().split("\n")[0];
      resolve(firstLine || null);
    });
  });
}

function markerPath() {
  return `${localBinPath()}.version`;
}

/** The release tag recorded at the last successful download, or null if unknown/never recorded. */
function getInstalledTag() {
  try {
    return fs.readFileSync(markerPath(), "utf-8").trim() || null;
  } catch (e) {
    return null;
  }
}

function writeInstalledTag(tag) {
  try {
    fs.writeFileSync(markerPath(), tag || "", "utf-8");
  } catch (e) {
    /* best effort - worst case we just re-download next run */
  }
}

/**
 * Does the actual work. Never throws - any failure just falls back to
 * whatever's already available (bundled or system), matching
 * ytdlpManager's "best effort" philosophy. Prefer startEnsureMpv() /
 * waitUntilReady() over calling this directly.
 */
async function ensureMpv() {
  if (process.env.MPV_PATH) {
    console.log(`[mpv] MPV_PATH diset manual -> pakai: ${process.env.MPV_PATH}`);
    emitStatus("skipped", { path: process.env.MPV_PATH });
    return { path: process.env.MPV_PATH, updated: false };
  }

  if (!isSupportedPlatform()) {
    // Nothing to do - mpv.js's system-wide detection handles this platform.
    emitStatus("unsupported_platform", { platform: process.platform });
    return { path: null, updated: false };
  }

  const local = localBinPath();
  const existsLocally = fs.existsSync(local);

  // ── First run: nothing local yet, just grab the latest build ──
  if (!existsLocally) {
    console.log("[mpv] Belum ada mpv bundled - downloading portable mpv (first run)...");
    emitStatus("downloading", { firstRun: true });
    try {
      const { url, tag, name } = await findLatestAsset();
      await downloadAsset(url, local);
      writeInstalledTag(tag);
      const ver = await getInstalledVersion(local);
      console.log(`[mpv] Siap dipakai${ver ? ` (${ver})` : ` (${name})`}: ${local}`);
      emitStatus("ready", { version: ver || name, firstRun: true });
      return { path: local, updated: true };
    } catch (e) {
      console.error(
        `[mpv] Download bundled mpv gagal (${e.message}) - fallback ke mpv sistem/PATH kalau ada.`
      );
      emitStatus("error", { message: e.message, firstRun: true });
      return { path: null, updated: false };
    }
  }

  // ── Already installed: check whether a newer release exists ──
  emitStatus("checking", {});
  let latest;
  try {
    latest = await findLatestAsset();
  } catch (e) {
    console.log(`[mpv] Cek update gagal (${e.message}) - pakai binary lokal.`);
    emitStatus("up_to_date", { checkFailed: true });
    return { path: local, updated: false };
  }

  const installedTag = getInstalledTag();
  if (installedTag && installedTag === latest.tag) {
    console.log(`[mpv] ${latest.name} - sudah versi terbaru.`);
    emitStatus("up_to_date", { version: latest.name });
    return { path: local, updated: false };
  }

  console.log(`[mpv] Update tersedia (${latest.name}). Downloading...`);
  emitStatus("updating", { to: latest.name });
  try {
    await downloadAsset(latest.url, local);
    writeInstalledTag(latest.tag);
    const ver = await getInstalledVersion(local);
    console.log(`[mpv] Berhasil update ke ${ver || latest.name}.`);
    emitStatus("ready", { version: ver || latest.name, updated: true });
    return { path: local, updated: true };
  } catch (e) {
    console.error(`[mpv] Download update gagal (${e.message}) - tetap pakai binary lokal.`);
    emitStatus("error", { message: e.message });
    return { path: local, updated: false };
  }
}

/**
 * Kicks off ensureMpv() in the background and caches the promise, same
 * non-blocking pattern as ytdlpManager: never call this before
 * app.listen(), a first-run download must not delay startup / trip the
 * desktop shell's backend-readiness timeout.
 */
function startEnsureMpv() {
  if (!_readyPromise) {
    _readyPromise = ensureMpv();
  }
  return _readyPromise;
}

/** Resolves once ensureMpv() has finished at least once. Never rejects. */
function waitUntilReady() {
  return startEnsureMpv();
}

module.exports = { ensureMpv, startEnsureMpv, waitUntilReady, onStatus, getMpvBin, localBinPath };
