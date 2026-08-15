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
  // Opens the "login into YouTube" window; cookies.txt is auto-synced when
  // it's closed. onLoginStatus fires once after that with { ok, count } or
  // { ok: false, error }.
  loginYoutube: () => ipcRenderer.send("youtube:login"),
  onYoutubeLoginStatus: (cb) => ipcRenderer.on("youtube:login-status", (_event, status) => cb(status)),
  platform: process.platform,
});
