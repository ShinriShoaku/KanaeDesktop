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

function shutdownBackend() {
  if (backendProc) {
    try {
      backendProc.kill();
    } catch (e) {}
    backendProc = null;
  }
}

app.on("window-all-closed", () => {
  shutdownBackend();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", shutdownBackend);
process.on("exit", shutdownBackend);
