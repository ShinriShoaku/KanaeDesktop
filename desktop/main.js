"use strict";
/**
 * Electron entry point for the compact desktop player.
 * Spawns the existing Express backend (src/server.js) as a child process,
 * waits for it to come up, then opens a small frameless "mp3 player style"
 * window (desktop/renderer/compact.html) that talks to it over
 * http://localhost:PORT - the exact same REST/SSE API the browser version
 * (/player) already uses, so the backend code didn't need to change at all.
 */
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = parseInt(process.env.PORT || "8000", 10);
const API_BASE = `http://localhost:${PORT}`;

let backendProc = null;
let win = null;

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

function createWindow() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  const iconPath = path.join(__dirname, "renderer", "icon.png");

  win = new BrowserWindow({
    width: 380,
    height: 600,
    minWidth: 320,
    minHeight: 460,
    x: screenW - 400,
    y: screenH - 640,
    frame: false,
    resizable: true,
    backgroundColor: "#0e0e14",
    show: false,
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
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
  win.on("closed", () => (win = null));
}

// ── Window control IPC (frameless window needs its own titlebar buttons) ──
ipcMain.on("win:minimize", () => win && win.minimize());
ipcMain.on("win:close", () => win && win.close());
ipcMain.handle("win:toggle-always-on-top", () => {
  if (!win) return false;
  const next = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(next);
  return next;
});
ipcMain.handle("win:get-api-base", () => API_BASE);

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
