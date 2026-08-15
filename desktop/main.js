"use strict";
/**
 * Electron entry point for the compact desktop player.
 * Spawns the existing Express backend (src/server.js) as a child process,
 * waits for it to come up, then opens a small frameless "mp3 player style"
 * main window (desktop/renderer/compact.html) that talks to it over
 * http://localhost:PORT - the exact same REST/SSE API the browser version
 * (/player) already uses, so the backend code didn't need to change at all.
 *
 * Settings / TikTok Live (chat & requests) / Music search now live in their
 * own separate frameless windows (desktop/renderer/settings.html,
 * tiktok.html, search.html) opened on demand from the main window, so the
 * main window itself stays small and compact.
 */
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// Chromium's Wayland/Vulkan GPU path (color-management, image-transfer-function
// warnings, "not compatible with Vulkan" for --ozone-platform=wayland) is still
// rough around the edges in this Electron version. Forcing the X11 backend on
// Linux avoids all of that noise; XWayland handles it transparently on Wayland
// desktops (GNOME/KDE etc.) so there's no visible difference for the user,
// just a cleaner terminal. No-op on Windows/macOS (Ozone is Linux/Chromium-only).


const PORT = parseInt(process.env.PORT || "8000", 10);
const API_BASE = `http://localhost:${PORT}`;

let backendProc = null;
let win = null;

// name -> BrowserWindow, for the secondary popup windows (settings/tiktok/search)
const childWindows = {};

const CHILD_WINDOW_CONFIG = {
  settings: { file: "settings.html", width: 640, height: 720, minWidth: 520, minHeight: 480 },
  tiktok: { file: "tiktok.html", width: 380, height: 640, minWidth: 320, minHeight: 420 },
  search: { file: "search.html", width: 400, height: 560, minWidth: 320, minHeight: 380 },
};

function startBackend() {
  const serverPath = path.join(__dirname, "..", "src", "server.js");
  backendProc = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "inherit",
    windowsHide: true,
    // Own process group on POSIX (Linux/macOS) so shutdownBackend() below
    // can reliably force-kill the WHOLE tree - server.js AND any mpv/ffplay
    // it spawned - in one shot via a negative-PID kill, instead of relying
    // on server.js's own SIGTERM handler to clean mpv up in time.
    detached: process.platform !== "win32",
  });
  backendProc.on("exit", (code) => {
    console.log(`[Desktop] Backend process exited (code ${code})`);
    backendProc = null;
  });
}

function waitForBackend(retries = 40, delayMs = 250) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      fetch(`${API_BASE}/`)
        .then(() => resolve())
        .catch(() => {
          if (n <= 0) return reject(new Error("Backend did not start in time"));
          setTimeout(() => attempt(n - 1), delayMs);
        });
    };
    attempt(retries);
  });
}

function iconOpt() {
  const iconPath = path.join(__dirname, "renderer", "icon.png");
  return fs.existsSync(iconPath) ? { icon: iconPath } : {};
}

function createWindow() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: 300,
    height: 480,
    minWidth: 260,
    minHeight: 380,
    x: screenW - 320,
    y: screenH - 520,
    frame: false,
    resizable: true,
    backgroundColor: "#0e0e14",
    show: false,
    ...iconOpt(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "renderer", "compact.html"), { query: { port: String(PORT) } });

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    win = null;
    // Main window gone - close any popups with it (window-all-closed handles quit).
    Object.values(childWindows).forEach((w) => {
      if (w && !w.isDestroyed()) w.close();
    });
  });
}

/** Open (or focus, if already open) one of the secondary popup windows. */
function openChildWindow(name) {
  const cfg = CHILD_WINDOW_CONFIG[name];
  if (!cfg) return;

  const existing = childWindows[name];
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }

  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  let x, y;
  if (win && !win.isDestroyed()) {
    const b = win.getBounds();
    // Prefer opening to the left of the main window; fall back to the right
    // if there isn't enough room, so popups never spawn off-screen.
    x = b.x - cfg.width - 12;
    if (x < 0) x = Math.min(screenW - cfg.width, b.x + b.width + 12);
    y = b.y;
  }

  const child = new BrowserWindow({
    width: cfg.width,
    height: cfg.height,
    minWidth: cfg.minWidth,
    minHeight: cfg.minHeight,
    x,
    y,
    frame: false,
    resizable: true,
    backgroundColor: "#0e0e14",
    show: false,
    ...iconOpt(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  child.setMenuBarVisibility(false);
  child.loadFile(path.join(__dirname, "renderer", cfg.file), { query: { port: String(PORT) } });
  child.once("ready-to-show", () => child.show());
  child.on("closed", () => {
    delete childWindows[name];
  });

  childWindows[name] = child;
}

// ── Window control IPC ──────────────────────────────────────────
// Every popup shares the same preload.js, so these resolve the *actual*
// window that sent the request instead of always targeting the main window -
// that way minimize/close/pin work correctly from any window.
ipcMain.on("win:minimize", (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (w) w.minimize();
});
ipcMain.on("win:close", (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (w) w.close();
});
ipcMain.handle("win:toggle-always-on-top", (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (!w) return false;
  const next = !w.isAlwaysOnTop();
  w.setAlwaysOnTop(next);
  return next;
});
ipcMain.handle("win:get-api-base", () => API_BASE);
ipcMain.on("win:open", (event, name) => openChildWindow(name));

app.whenReady().then(async () => {
  startBackend();
  try {
    await waitForBackend();
  } catch (e) {
    console.error("[Desktop] " + e.message);
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * Stops mpv/ffplay and the backend server when the app closes.
 *
 * Two steps, in order:
 *   1. Best-effort GRACEFUL stop: POST /player/stop, the same endpoint the
 *      UI's own Stop button uses. This lets mpv exit cleanly via its own
 *      IPC "quit" command (src/mpv.js killServerPlayer()) instead of being
 *      killed mid-buffer. Short timeout - must never hold up app close.
 *   2. GUARANTEED force-kill of the entire process TREE (server.js + any
 *      mpv/ffplay it spawned), regardless of whether step 1 worked.
 *
 * Step 2 is the actual fix for mpv lingering after the app closes ("mpv
 * nyangkut"): previously this only called backendProc.kill() on the
 * direct child (server.js) and relied on ITS OWN SIGTERM handler to clean
 * up mpv in turn. That's not reliable enough on its own:
 *   - On Windows, Node's child.kill() terminates the target process
 *     immediately at the OS level and its SIGTERM/SIGINT handlers never
 *     run at all - so mpv.killServerPlayer() inside server.js was simply
 *     never reached, and mpv (a grandchild of Electron) kept running as
 *     an orphaned process in the background indefinitely.
 *   - Even where signal handlers DO run, Electron has no way to "wait"
 *     for a grandchild process's cleanup to finish before it exits.
 * Killing the whole process tree/group directly removes that dependency
 * entirely - mpv gets killed no matter what server.js's own shutdown code
 * did or didn't manage to do in time.
 */
async function shutdownBackend() {
  if (!backendProc) return;
  const proc = backendProc;
  backendProc = null;

  console.log("[Desktop] Menutup aplikasi - menghentikan player + backend...");

  try {
    await Promise.race([
      fetch(`${API_BASE}/player/stop`, { method: "POST" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
    ]);
  } catch (e) {
    // fine - the force-kill below is the actual guarantee, this was just
    // a best-effort attempt at a cleaner mpv exit.
  }

  try {
    if (process.platform === "win32") {
      // /T = kill the whole process tree (server.js + mpv/ffplay), /F = force.
      require("child_process").exec(`taskkill /pid ${proc.pid} /T /F`, () => {});
    } else {
      // Negative PID = kill the entire process group (works because
      // startBackend() spawned this with detached:true on POSIX).
      process.kill(-proc.pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch (e) {
          /* group already gone */
        }
      }, 1000);
    }
  } catch (e) {
    try {
      proc.kill();
    } catch (e2) {
      /* nothing more we can do */
    }
  }

  console.log("[Desktop] Backend + player dihentikan.");
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let _quitting = false;
app.on("before-quit", (e) => {
  if (_quitting || !backendProc) return; // already handled / nothing running
  e.preventDefault();
  _quitting = true;
  shutdownBackend().finally(() => app.quit());
});

// Last-resort synchronous safety net (e.g. an unexpected crash that skips
// the async before-quit path above) - can't await here, so this just fires
// the force-kill and hopes for the best rather than the graceful HTTP step.
process.on("exit", () => {
  if (!backendProc) return;
  try {
    if (process.platform === "win32") {
      require("child_process").execSync(`taskkill /pid ${backendProc.pid} /T /F`, { stdio: "ignore" });
    } else {
      process.kill(-backendProc.pid, "SIGKILL");
    }
  } catch (e) {
    /* best effort */
  }
});
