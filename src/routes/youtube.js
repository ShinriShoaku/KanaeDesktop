"use strict";
const express = require("express");
const { spawn } = require("child_process");
const router = express.Router();

const youtube = require("../youtube");
const playerService = require("../playerService");
const { state } = require("../state");

router.get("/search", async (req, res) => {
  const q = req.query.q;
  const limit = Math.max(1, Math.min(20, parseInt(req.query.limit, 10) || 10));
  if (!q) return res.status(422).json({ detail: "query param 'q' is required" });
  try {
    const results = await youtube.searchYoutube(q, limit);
    res.json({ query: q, count: results.length, results });
  } catch (e) {
    res.status(500).json({ detail: e.message });
  }
});

router.post("/search/add-top", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(422).json({ detail: "query param 'q' is required" });
  let results;
  try {
    results = await youtube.searchYoutube(q, 1);
  } catch (e) {
    return res.status(500).json({ detail: `Search error: ${e.message}` });
  }
  if (!results.length) return res.status(404).json({ detail: "No results found" });
  const top = results[0];
  let info;
  try {
    info = await youtube.getInfo(top.url);
  } catch (e) {
    return res.status(500).json({ detail: `Info fetch error: ${e.message}` });
  }
  const song = playerService.makeSong(info, top.url);
  const result = await playerService.addOrAutoplay(song);
  result.search_query = q;
  result.top_result = top;
  playerService.broadcastPlayerState();
  res.json(result);
});

router.get("/info", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(422).json({ detail: "query param 'url' is required" });
  try {
    const info = await youtube.getInfo(url);
    res.json({
      id: info.id,
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      channel: info.channel || info.uploader,
      view_count: info.view_count,
      description: (info.description || "").slice(0, 500),
      url,
    });
  } catch (e) {
    res.status(500).json({ detail: e.message });
  }
});

router.get("/subtitles", async (req, res) => {
  const url = req.query.url;
  const lang = req.query.lang || "en";
  if (!url) return res.status(422).json({ detail: "query param 'url' is required" });
  try {
    const { subMap, info } = await youtube.fetchSubtitleMap(url);
    const available = Object.keys(subMap);
    const usedLang = youtube.pickLanguage(subMap, lang);
    const result = {
      url,
      title: info.title,
      available_languages: available,
      requested_language: lang,
      used_language: usedLang,
      subtitles: {},
    };
    if (usedLang) {
      const resp = await fetch(subMap[usedLang].url);
      const raw = await resp.json();
      const events = youtube.parseJson3Subtitle(raw);
      result.subtitles = { type: subMap[usedLang].type, language: usedLang, event_count: events.length, events };
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ detail: e.message });
  }
});

router.get("/subtitles/list", async (req, res) => {
  if (!state.currentSong) return res.status(404).json({ detail: "Nothing is currently playing" });
  const url = state.currentSong.youtube_url;
  try {
    const { subMap } = await youtube.fetchSubtitleMap(url);
    const available = Object.keys(subMap);
    res.json({
      url,
      title: state.currentSong.title,
      song_id: state.currentSong.id,
      available_languages: available,
      languages_detail: available.map((k) => ({ code: k, type: subMap[k].type })),
      count: available.length,
    });
  } catch (e) {
    res.json({
      url,
      title: state.currentSong ? state.currentSong.title : null,
      song_id: state.currentSong ? state.currentSong.id : null,
      available_languages: [],
      languages_detail: [],
      count: 0,
      error: e.message,
    });
  }
});

router.get("/subtitles/current", async (req, res) => {
  if (!state.currentSong) return res.status(404).json({ detail: "Nothing is currently playing" });
  const url = state.currentSong.youtube_url;
  const lang = req.query.lang || "en";
  try {
    const { subMap, info } = await youtube.fetchSubtitleMap(url);
    const available = Object.keys(subMap);
    const usedLang = youtube.pickLanguage(subMap, lang);
    const result = {
      url,
      title: info.title,
      song_id: state.currentSong.id,
      available_languages: available,
      requested_language: lang,
      used_language: usedLang,
      subtitles: {},
    };
    if (!usedLang) return res.json(result);
    const resp = await fetch(subMap[usedLang].url);
    const raw = await resp.json();
    const events = youtube.parseJson3Subtitle(raw);
    result.subtitles = { type: subMap[usedLang].type, language: usedLang, event_count: events.length, events };
    res.json(result);
  } catch (e) {
    res.json({
      url,
      title: state.currentSong ? state.currentSong.title : null,
      song_id: state.currentSong ? state.currentSong.id : null,
      available_languages: [],
      requested_language: lang,
      used_language: null,
      subtitles: {},
      error: e.message,
    });
  }
});

router.get("/audio/url", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(422).json({ detail: "query param 'url' is required" });
  try {
    const [info, streamUrl] = await Promise.all([youtube.getInfo(url), youtube.getAudioStreamUrl(url)]);
    res.json({
      title: info.title,
      audio_url: streamUrl,
      duration: info.duration,
      thumbnail: info.thumbnail,
      note: "URL expires - re-fetch if playback fails",
    });
  } catch (e) {
    res.status(500).json({ detail: e.message });
  }
});

router.get("/audio/stream", async (req, res) => {
  const url = req.query.url;
  const bitrate = req.query.bitrate || "192k";
  if (!url) return res.status(422).json({ detail: "query param 'url' is required" });
  let streamUrl;
  try {
    streamUrl = await youtube.getAudioStreamUrl(url);
  } catch (e) {
    return res.status(500).json({ detail: `yt-dlp error: ${e.message}` });
  }

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-re",
    "-fflags",
    "+nobuffer",
    "-thread_queue_size",
    "512",
    "-i",
    streamUrl,
    "-vn",
    "-c:a",
    "libmp3lame",
    "-b:a",
    bitrate,
    "-bufsize",
    "64k",
    "-f",
    "mp3",
    "pipe:1",
  ];

  let proc;
  try {
    proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    return res.status(500).json({ detail: "ffmpeg not found" });
  }
  proc.on("error", () => {
    if (!res.headersSent) res.status(500).json({ detail: "ffmpeg not found" });
  });

  res.set({
    "Content-Type": "audio/mpeg",
    "Content-Disposition": 'inline; filename="audio.mp3"',
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Accept-Ranges": "none",
  });

  proc.stdout.pipe(res);
  const cleanup = () => {
    try {
      proc.kill();
    } catch (e) {}
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
});

router.get("/audio/curl-cmd", (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(422).json({ detail: "query param 'url' is required" });
  const encoded = encodeURIComponent(url);
  const base = `http://localhost:${process.env.PORT || 8000}`;
  res.json({
    mpv_direct: `mpv '${base}/audio/stream?url=${encoded}&bitrate=192k'`,
    ffplay_direct: `ffplay -nodisp -autoexit '${base}/audio/stream?url=${encoded}&bitrate=192k'`,
    stream_url: `${base}/audio/stream?url=${encoded}&bitrate=192k`,
  });
});

module.exports = router;
