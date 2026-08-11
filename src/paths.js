"use strict";
const path = require("path");
const os = require("os");

const BASE_DIR = path.resolve(__dirname, "..");
const OVERLAYS_DIR = path.join(BASE_DIR, "overlays");
const DATA_DIR = path.join(BASE_DIR, "data");
const CONFIG_FILE = path.join(BASE_DIR, "config.json");
const QUEUE_FILE = path.join(DATA_DIR, "queue.json");
const BADWORDS_FILE = path.join(BASE_DIR, "badwords.txt");

const IS_WINDOWS = os.platform() === "win32";

// mpv IPC endpoints: Node's net module can connect to a Windows named pipe
// (\\.\pipe\name) the same way it connects to a POSIX unix-domain socket,
// which is why this port doesn't need the manual win32file branching that
// the Python original required.
const MPV_SOCKET_ARG = IS_WINDOWS ? "\\\\.\\pipe\\ytp-mpv" : path.join(os.tmpdir(), "ytp-mpv.sock");
const MPV_TTS_SOCKET_ARG = IS_WINDOWS ? "\\\\.\\pipe\\ytp-mpv-tts" : path.join(os.tmpdir(), "ytp-mpv-tts.sock");

module.exports = {
  BASE_DIR,
  OVERLAYS_DIR,
  DATA_DIR,
  CONFIG_FILE,
  QUEUE_FILE,
  BADWORDS_FILE,
  IS_WINDOWS,
  MPV_SOCKET_ARG,
  MPV_TTS_SOCKET_ARG,
  APP_VERSION_NAME: "4.0.0",
};
