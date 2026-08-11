"use strict";
/**
 * Text-to-speech: generate audio with edge-tts (via the `msedge-tts` npm package,
 * which talks to the same Microsoft Edge TTS service as Python's edge-tts) and
 * play it back with a system audio player subprocess.
 * Mirrors _speak_text / _tts_volume_to_mpv (main.py). Node has no pygame/winsound
 * equivalent, so playback here always goes through ffplay/afplay - functionally
 * equivalent, just one fewer fallback tier than the Python original.
 */
const os = require("os");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
// msedge-tts is lazy-required inside speakText() so it's only loaded into
// memory once TTS is actually enabled and used, not at server startup.
const paths = require("./paths");
const config = require("./config");

const MAX_CONCURRENT_TTS = 2;
let activeTts = 0;

function ttsVolumeToMpv(edgeVolume) {
  try {
    const val = parseInt(String(edgeVolume).replace("%", "").replace("+", "").trim(), 10);
    if (Number.isNaN(val)) return 100;
    return Math.max(0, Math.min(130, 100 + val));
  } catch (e) {
    return 100;
  }
}

function playFile(filePath, volPct) {
  return new Promise((resolve) => {
    const candidates = [];
    if (process.platform === "darwin") {
      candidates.push(["afplay", ["-v", String(Math.max(0, Math.min(1, volPct / 100)).toFixed(2)), filePath]]);
    }
    candidates.push([
      "ffplay",
      ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", String(volPct), filePath],
    ]);
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return resolve(false);
      const [bin, args] = candidates[i++];
      execFile(bin, args, { timeout: 30000 }, (err) => {
        if (err) return tryNext();
        resolve(true);
      });
    };
    tryNext();
  });
}

/**
 * Generate TTS audio for `text` and play it back.
 * Runs fire-and-forget (mirrors the Python daemon-thread behaviour).
 */
async function speakText(text) {
  if (activeTts >= MAX_CONCURRENT_TTS) {
    console.log("[TTS] Skipping - too many TTS active");
    return;
  }
  const ttsCfg = config.getTtsConfig();
  if (!ttsCfg.enabled) return;

  const maxLen = parseInt(ttsCfg.max_length, 10) || 100;
  if (text.length > maxLen) {
    console.log(`[TTS] Skipping - text too long (${text.length} > ${maxLen})`);
    return;
  }

  activeTts += 1;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytp-tts-"));
  try {
    const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
    const tts = new MsEdgeTTS();
    await tts.setMetadata(ttsCfg.voice || "id-ID-ArdiNeural", OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioFilePath } = await tts.toFile(tmpDir, text, {
      rate: ttsCfg.rate || "+0%",
      volume: "+0%", // volume is applied at playback time (see below), matching Python behaviour
    });

    const volPct = ttsVolumeToMpv(ttsCfg.volume || "+0%");
    const played = await playFile(audioFilePath, volPct);
    if (!played) {
      console.log("[TTS] No playback method worked. Install ffmpeg (provides ffplay): sudo apt install ffmpeg");
    }
  } catch (e) {
    console.error("[TTS] Error:", e.message);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
    activeTts -= 1;
  }
}

module.exports = { speakText, ttsVolumeToMpv };
