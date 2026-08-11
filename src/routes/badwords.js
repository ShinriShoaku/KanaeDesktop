"use strict";
const express = require("express");
const router = express.Router();

const config = require("../config");
const paths = require("../paths");

router.get("/badwords", (req, res) => {
  const words = config.loadBadwords();
  res.json({ words, count: words.length, file: paths.BADWORDS_FILE });
});

router.post("/badwords", (req, res) => {
  const words = req.body?.words;
  if (!Array.isArray(words)) return res.status(400).json({ detail: "'words' harus berupa list/array" });
  const cleaned = config.saveBadwords(words.filter((w) => typeof w === "string" && w.trim()));
  res.json({ message: "Filter disimpan", count: cleaned.length });
});

router.post("/badwords/add", (req, res) => {
  const word = (req.body?.word || "").trim().toLowerCase();
  if (!word) return res.status(400).json({ detail: "'word' tidak boleh kosong" });
  const words = config.loadBadwords();
  if (words.includes(word)) return res.json({ message: "Kata sudah ada di filter", word });
  words.push(word);
  config.saveBadwords(words);
  res.json({ message: "Kata ditambahkan", word, count: words.length });
});

router.delete("/badwords/:word", (req, res) => {
  const word = req.params.word.trim().toLowerCase();
  const words = config.loadBadwords();
  if (!words.includes(word)) return res.status(404).json({ detail: `Kata '${word}' tidak ditemukan di filter` });
  const filtered = words.filter((w) => w !== word);
  config.saveBadwords(filtered);
  res.json({ message: "Kata dihapus", word, count: filtered.length });
});

router.post("/badwords/test", (req, res) => {
  const text = req.body?.text || "";
  res.json({ text, blocked: config.containsBadword(text) });
});

module.exports = router;
