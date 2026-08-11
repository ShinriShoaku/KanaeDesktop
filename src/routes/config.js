"use strict";
const express = require("express");
const router = express.Router();

const config = require("../config");
const sse = require("../sse");
const { DEFAULT_OVERLAY_CONFIG } = require("../overlayDefaults");

router.get("/config", (req, res) => {
  res.json(config.loadConfig());
});

router.post("/config", (req, res) => {
  try {
    const merged = config.saveConfigMerged(req.body || {});
    const overlayMerged = { ...DEFAULT_OVERLAY_CONFIG, ...(merged.overlay || {}) };
    sse.broadcast("overlay_config", overlayMerged);
    res.json({ message: "Config saved", config: merged });
  } catch (e) {
    res.status(500).json({ detail: `Could not save config: ${e.message}` });
  }
});

module.exports = router;
