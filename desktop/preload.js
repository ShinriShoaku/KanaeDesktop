"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  minimize: () => ipcRenderer.send("win:minimize"),
  close: () => ipcRenderer.send("win:close"),
  toggleAlwaysOnTop: () => ipcRenderer.invoke("win:toggle-always-on-top"),
  getApiBase: () => ipcRenderer.invoke("win:get-api-base"),
  platform: process.platform,
});
