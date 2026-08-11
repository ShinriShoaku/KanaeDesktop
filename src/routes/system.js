"use strict";
const express = require("express");
const router = express.Router();

const { state } = require("../state");
const config = require("../config");
const mpv = require("../mpv");
const paths = require("../paths");
const versionMod = require("../version");

router.get("/", (req, res) => {
  res.json({
    app: "YouTube Audio Player API",
    version: "4.0.0",
    docs: "/docs",
    player: "/player",
    obs_overlay: "/obs",
    platform: paths.IS_WINDOWS ? "windows" : process.platform,
    player_found: mpv.detectPlayer() || "not found",
    tiktok_available: true,
    tiktok_connected: state.tiktokConnected,
    tiktok_username: config.getTiktokUsername(),
  });
});

const FEEDBACK_SHEET_URL =
  "https://script.google.com/macros/s/AKfycbwVs6bpXUpc5xkxt3mpXykKmMTkze89_3iL4cU4VSzlJ8el0xEi0u_Mi7OJoi-U-ZcjQQ/exec";

router.post("/feedback", async (req, res) => {
  const { username, feedback, type } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ detail: "Username tidak boleh kosong." });
  if (!feedback || !feedback.trim()) return res.status(400).json({ detail: "Pesan feedback tidak boleh kosong." });

  const payload = {
    username: username.trim(),
    feedback: feedback.trim(),
    type: type || "feedback",
    version: paths.APP_VERSION_NAME,
    timestamp: new Date().toISOString(),
  };

  try {
    const resp = await fetch(FEEDBACK_SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const result = await resp.text();
    console.log(`[Feedback] Terkirim dari '${username}' - ${result.slice(0, 80)}`);
    res.json({ message: "Feedback berhasil dikirim! Terima kasih 🙏" });
  } catch (e) {
    res.status(502).json({ detail: `Gagal mengirim feedback: ${e.message}` });
  }
});

router.get("/version", async (req, res) => {
  if (!state.updateInfo || !Object.keys(state.updateInfo).length) {
    await versionMod.checkForUpdate();
  }
  res.json(state.updateInfo);
});

module.exports = router;
