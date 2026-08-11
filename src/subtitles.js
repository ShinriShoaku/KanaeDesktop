"use strict";
const youtube = require("./youtube");
const sse = require("./sse");
const { state } = require("./state");

/**
 * Spawn a background task that broadcasts subtitle SSE events timed to playback.
 * Mirrors _start_subtitle_broadcaster (main.py).
 */
function startSubtitleBroadcaster(song, songStartTime) {
  const songId = song.id;
  state.subtitleSongId = songId;

  (async () => {
    const events = await youtube.fetchSubtitleEventsForUrl(song.youtube_url);
    if (!events.length) return;

    for (const evt of events) {
      if (state.subtitleSongId !== songId) return; // song changed - abort

      const fireAt = songStartTime + evt.start_ms / 1000;
      const now = Date.now() / 1000;
      const delay = fireAt - now;

      if (delay < -1.5) continue; // already past

      if (delay > 0) {
        let slept = 0;
        while (slept < delay) {
          if (state.subtitleSongId !== songId) return;
          const chunk = Math.min(150, (delay - slept) * 1000);
          await new Promise((r) => setTimeout(r, chunk));
          slept += chunk / 1000;
        }
      }

      if (state.subtitleSongId !== songId) return;

      sse.broadcast("subtitle", {
        text: evt.text,
        duration_ms: Math.min(evt.duration_ms + 400, 7000),
      });
    }

    if (state.subtitleSongId === songId) {
      await new Promise((r) => setTimeout(r, 1000));
      sse.broadcast("subtitle_clear", {});
    }
  })().catch((e) => console.error("[Subtitle] broadcaster error:", e.message));
}

module.exports = { startSubtitleBroadcaster };
