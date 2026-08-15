"use strict";
/**
 * Resolves which --cookies / --cookies-from-browser args yt-dlp should use,
 * so every yt-dlp invocation in the app (search, info, subtitles, and the
 * actual ytdlp-pipe stream in mpv.js) authenticates the same way without
 * each call site having to know the details.
 *
 * Why cookies at all: YouTube increasingly 403s "anonymous" requests
 * (see PO Token Guide - https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide).
 * A logged-in session's cookies are usually enough on their own, no PO
 * token provider required.
 *
 * Priority (first match wins), all optional - with nothing configured this
 * resolves to no extra args, same as before:
 *
 *   1. YTDLP_COOKIES_FILE env var - explicit path to a Netscape-format
 *      cookies.txt (e.g. exported with the "Get cookies.txt LOCALLY"
 *      browser extension).
 *   2. <BASE_DIR>/cookies.txt - auto-picked up with ZERO configuration if
 *      the user just drops a cookies.txt next to config.json. This is the
 *      recommended path: a file survives app/browser restarts and doesn't
 *      need the browser to be closed, unlike --cookies-from-browser.
 *   3. YTDLP_COOKIES_FROM_BROWSER env var - passed straight through to
 *      yt-dlp's --cookies-from-browser (e.g. "chrome", "firefox:Default",
 *      "edge:ProfileName"). Reads the browser's live cookie store, so the
 *      browser usually needs to be closed first on some platforms/OSes.
 *
 * Re-checks the filesystem lazily (mtime-based, like config.js) so editing
 * or dropping in cookies.txt while the app is running is picked up on the
 * next yt-dlp call without a restart.
 */
const fs = require("fs");
const path = require("path");
const paths = require("./paths");

const DEFAULT_COOKIES_FILE = path.join(paths.BASE_DIR, "cookies.txt");

let _lastLoggedSource = undefined; // undefined = never logged yet

function _logSourceChange(source, detail) {
  if (source === _lastLoggedSource) return;
  _lastLoggedSource = source;
  if (source === "none") {
    console.log(
      "[Cookies] Tidak ada cookies dikonfigurasi - yt-dlp jalan tanpa login. " +
        `Kalau kena 403 terus, taruh cookies.txt di ${DEFAULT_COOKIES_FILE} ` +
        "(export pakai extension \"Get cookies.txt LOCALLY\" saat login YouTube), " +
        "atau set env YTDLP_COOKIES_FROM_BROWSER=chrome."
    );
  } else {
    console.log(`[Cookies] Pakai ${source}: ${detail}`);
  }
}

/**
 * Returns the yt-dlp CLI args to prepend for authentication, e.g.
 * ["--cookies", "/path/to/cookies.txt"] or
 * ["--cookies-from-browser", "chrome"], or [] if nothing is configured.
 */
function getCookieArgs() {
  // 1. Explicit file override.
  const explicitFile = (process.env.YTDLP_COOKIES_FILE || "").trim();
  if (explicitFile) {
    if (fs.existsSync(explicitFile)) {
      _logSourceChange("cookies file (YTDLP_COOKIES_FILE)", explicitFile);
      return ["--cookies", explicitFile];
    }
    console.warn(
      `[Cookies] YTDLP_COOKIES_FILE=${explicitFile} diset tapi file tidak ditemukan - dilewati.`
    );
  }

  // 2. Zero-config default: cookies.txt sitting next to config.json.
  if (fs.existsSync(DEFAULT_COOKIES_FILE)) {
    _logSourceChange("cookies file (default)", DEFAULT_COOKIES_FILE);
    return ["--cookies", DEFAULT_COOKIES_FILE];
  }

  // 3. Live browser cookie store.
  const fromBrowser = (process.env.YTDLP_COOKIES_FROM_BROWSER || "").trim();
  if (fromBrowser) {
    _logSourceChange("browser cookies (YTDLP_COOKIES_FROM_BROWSER)", fromBrowser);
    return ["--cookies-from-browser", fromBrowser];
  }

  _logSourceChange("none", null);
  return [];
}

// Default yt-dlp player_client priority as of 2026 leans on the `web`
// client when cookies are present (to use the logged-in session) - but
// YouTube now force-routes `web`/`web_safari`/`mweb` to SABR-only formats
// with no direct HTTPS URL, so those get dropped entirely and format
// selection fails with "Requested format is not available"
// (https://github.com/yt-dlp/yt-dlp/issues/12482). `tv` and `android`
// still hand back plain HTTPS URLs without needing a PO token, so those
// are forced instead, unless overridden via YTDLP_PLAYER_CLIENT.
const DEFAULT_PLAYER_CLIENT = "tv,android";

/**
 * Returns ["--extractor-args", "youtube:player_client=..."] to keep yt-dlp
 * off the SABR-only web clients. Override with env YTDLP_PLAYER_CLIENT
 * (comma-separated, same syntax yt-dlp itself takes) if YouTube's rollout
 * shifts again and a different client combo works better.
 */
function getPlayerClientArgs() {
  const clients = (process.env.YTDLP_PLAYER_CLIENT || DEFAULT_PLAYER_CLIENT).trim();
  if (!clients) return [];
  return ["--extractor-args", `youtube:player_client=${clients}`];
}

// yt-dlp needs an external JS runtime (Deno/Node/Bun/QuickJS) to solve
// YouTube's signature/"n" challenges - without one, https format URLs
// can't be de-obfuscated and get silently dropped, which then LOOKS like
// the SABR-only-formats issue (same "missing a URL" symptom) but isn't -
// see https://github.com/yt-dlp/yt-dlp/wiki/EJS. Deno is yt-dlp's
// recommended/sandboxed choice and is auto-detected with zero flags if
// it's on PATH, but Node is what's actually guaranteed to be present here
// (KanaeDesktop is a Node/Electron app), so that's the explicit default -
// override with YTDLP_JS_RUNTIME (same syntax as yt-dlp's own
// --js-runtimes, e.g. "deno" or "node:/custom/path/to/node").
const DEFAULT_JS_RUNTIME = "node";

function getJsRuntimeArgs() {
  const runtime = (process.env.YTDLP_JS_RUNTIME || DEFAULT_JS_RUNTIME).trim();
  if (!runtime) return [];
  return ["--js-runtimes", runtime];
}

module.exports = { getCookieArgs, getPlayerClientArgs, getJsRuntimeArgs, DEFAULT_COOKIES_FILE };
