"use strict";
const { state } = require("./state");

const APP_VERSION_CODE = 6;
const APP_VERSION_NAME = "6.0.0";
const VERSION_JSON_URL = "https://raw.githubusercontent.com/ShinriShoaku/YTP/main/version.json";

function parseVersion(v) {
  const parts = String(v)
    .trim()
    .split(".")
    .map((seg) => {
      const n = parseInt(seg, 10);
      return Number.isNaN(n) ? 0 : n;
    });
  while (parts.length < 3) parts.push(0);
  return parts;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkForUpdate() {
  try {
    const resp = await fetch(VERSION_JSON_URL, {
      headers: { "User-Agent": "YTPlayer-UpdateChecker/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json();

    const latestCode = parseInt(data.versionCode || 0, 10);
    const latestName = String(data.versionName || "?");
    const message = String(data.updateMessage || "");

    const verCur = parseVersion(APP_VERSION_NAME);
    const verLat = parseVersion(latestName);
    const available = latestCode > APP_VERSION_CODE || compareVersions(verLat, verCur) > 0;

    state.updateInfo = {
      current_version_code: APP_VERSION_CODE,
      current_version_name: APP_VERSION_NAME,
      latest_version_code: latestCode,
      latest_version_name: latestName,
      update_message: message,
      update_available: available,
    };
  } catch (e) {
    state.updateInfo = {
      current_version_code: APP_VERSION_CODE,
      current_version_name: APP_VERSION_NAME,
      latest_version_code: APP_VERSION_CODE,
      latest_version_name: APP_VERSION_NAME,
      update_message: "",
      update_available: false,
      error: e.message,
    };
  }
  return state.updateInfo;
}

module.exports = { checkForUpdate, APP_VERSION_CODE, APP_VERSION_NAME };
