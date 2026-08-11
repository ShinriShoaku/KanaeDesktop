"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  minimize: () => ipcRenderer.send("win:minimize"),
  close: () => ipcRenderer.send("win:close"),
  toggleAlwaysOnTop: () => ipcRenderer.invoke("win:toggle-always-on-top"),
  getApiBase: () => ipcRenderer.invoke("win:get-api-base"),
  // Opens (or focuses, if already open) a secondary window.
  // name: "settings" | "tiktok" | "search"
  openWindow: (name) => ipcRenderer.send("win:open", name),
  platform: process.platform,
});
