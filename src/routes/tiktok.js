"use strict";
const express = require("express");
const router = express.Router();

const { state } = require("../state");
const config = require("../config");
const tiktok = require("../tiktok");

router.get("/tiktok/status", (req, res) => {
  const settings = config.getSettings();
  res.json({
    library_installed: true,
    connected: state.tiktokConnected,
    username: config.getTiktokUsername(),
    error: state.tiktokError,
    commands: config.getCommands(),
    settings,
    recent_requests: state.recentRequests.slice(0, 10),
    skip_votes: state.skipVotes.size,
    skip_threshold: settings.skip_vote_threshold,
  });
});

router.post("/tiktok/simulate", async (req, res) => {
  const user = req.query.user || "testuser";
  const comment = req.query.comment;
  if (!comment) return res.status(422).json({ detail: "query param 'comment' is required" });
  await tiktok.processTiktokComment(user, user, comment);
  res.json({ message: "Comment simulated", user, comment });
});

router.post("/tiktok/reconnect", (req, res) => {
  tiktok.startTiktokListener();
  res.json({ message: "TikTok listener restarted", username: config.getTiktokUsername() });
});

router.post("/tiktok/disconnect", (req, res) => {
  tiktok.stopTiktokListener();
  res.json({ message: "TikTok listener stopped", connected: false });
});

module.exports = router;
