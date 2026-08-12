"use strict";
/**
 * TikTok Live integration via Euler Stream (TikTool) Managed WebSocket.
 * No tiktok-live-connector library needed — pure ws + axios.
 *
 * Flow:
 *   1. Read euler_api_key from config.json
 *   2. Open WebSocket to wss://api.tik.tools/ws?key=<key>&username=<user>
 *   3. Receive clean JSON events (chat, gift, like, follow, member)
 *   4. Process commands (!req, !skip, !queue) and broadcast via SSE
 *
 * Setup:
 *   1. Sign up at https://www.eulerstream.com (free tier: 2,500 req/day + 25 WS)
 *   2. Create an API key in the dashboard
 *   3. Paste the key into config.json as "euler_api_key": "your-key-here"
 */

const EMOTES = require("./tiktokEmotes.json");
const config = require("./config");
const { state, addRecentRequest, queueLen } = require("./state");
const sse = require("./sse");
const youtube = require("./youtube");
const playerService = require("./playerService");
const tts = require("./tts");
const axios = require("axios");
const WebSocket = require("ws");

const EULER_WS_URL = "wss://api.tik.tools/ws";
const EULER_REST_URL = "https://api.eulerstream.com";

function now() {
  return new Date().toISOString().substr(11, 8);
}

function convertTiktokEmotes(text) {
  return text.replace(/\[\[^\]\]{1,20}\]/g, (m) => EMOTES[m.toLowerCase()] || m);
}

function extractUser(u) {
  if (!u) return { uid: "unknown", nick: "unknown", avatar: "" };
  const uid = String(u.uniqueId || u.displayId || u.id || u.userId || "").trim() || "unknown";
  const nick = String(u.nickname || u.nickName || uid).trim() || uid;
  let avatar = "";
  const avatarObj = u.avatarThumb || u.avatarMedium || u.avatarLarger || u.avatarLarge || null;
  if (avatarObj) {
    const urls = avatarObj.urlList || avatarObj.url_list || avatarObj.mUrls || [];
    if (urls.length) avatar = String(urls[0]);
  }
  if (!avatar && typeof u.profilePictureUrl === "string") avatar = u.profilePictureUrl;
  return { uid, nick, avatar };
}

async function processTiktokComment(userId, nickname, comment, avatarUrl = "") {
  comment = (comment || "").trim();
  const commentLower = comment.toLowerCase();
  const cmds = config.getCommands();
  const settings = config.getSettings();

  // ── Skip command ──
  for (const prefix of cmds.skip) {
    if (commentLower === prefix || commentLower.startsWith(prefix + " ")) {
      const adminUsername = config.getTiktokUsername();
      const isAdmin =
        adminUsername &&
        (userId.toLowerCase() === adminUsername.toLowerCase() || nickname.toLowerCase() === adminUsername.toLowerCase());

      if (isAdmin) {
        console.log(`[TikTok] Admin skip by @${nickname} - skipping instantly`);
        sse.broadcast("skip_vote", {
          user: nickname,
          votes: settings.skip_vote_threshold,
          threshold: settings.skip_vote_threshold,
          admin: true,
        });
        addRecentRequest({ type: "skip", user: nickname, text: comment, time: now() });
        await playerService.doSkip(nickname);
        return;
      }

      state.skipVotes.add(userId);
      const threshold = settings.skip_vote_threshold;
      const voteCount = state.skipVotes.size;
      console.log(`[TikTok] Skip vote from @${nickname} (${voteCount}/${threshold})`);

      sse.broadcast("skip_vote", { user: nickname, votes: voteCount, threshold });
      addRecentRequest({ type: "skip", user: nickname, text: comment, time: now() });

      if (voteCount >= threshold) {
        await playerService.doSkip(nickname);
      }
      return;
    }
  }

  // ── Request command ──
  for (const prefix of cmds.request) {
    if (commentLower.startsWith(prefix)) {
      const query = comment.slice(prefix.length).trim();
      if (!query) return;
      const maxPerUser = settings.max_queue_per_user;
      const count = state.userRequestCount[userId] || 0;
      if (count >= maxPerUser) {
        sse.broadcast("request_rejected", { user: nickname, reason: `Max ${maxPerUser} requests per user`, query });
        return;
      }

      console.log(`[TikTok] Request from @${nickname}: ${query}`);
      addRecentRequest({ type: "request", user: nickname, text: query, status: "searching", time: now() });
      sse.broadcast("tiktok_request", { user: nickname, query, status: "searching" });

      try {
        const results = await youtube.searchYoutube(query, 1);
        if (!results.length) {
          sse.broadcast("tiktok_request", { user: nickname, query, status: "not_found" });
          if (state.recentRequests[0]) state.recentRequests[0].status = "not_found";
          return;
        }
        const top = results[0];
        const info = await youtube.getInfo(top.url);
        const song = playerService.makeSong(info, top.url);
        song.requested_by = nickname;
        await playerService.addOrAutoplay(song);
        state.userRequestCount[userId] = count + 1;
        if (state.recentRequests[0]) {
          state.recentRequests[0].status = "queued";
          state.recentRequests[0].song_title = song.title;
        }

        sse.broadcast("tiktok_request", {
          user: nickname,
          query,
          status: "queued",
          song_title: song.title,
          thumbnail: song.thumbnail,
        });
        playerService.broadcastPlayerState();
      } catch (e) {
        console.error("[TikTok] Request error:", e.message);
        sse.broadcast("tiktok_request", { user: nickname, query, status: "error", error: e.message });
      }
      return;
    }
  }

  // ── Queue info command ──
  for (const prefix of cmds.queue) {
    if (commentLower === prefix) {
      sse.broadcast("queue_info", { user: nickname, queue_count: queueLen() });
      return;
    }
  }

  // ── TTS: read plain comments ──
  if (comment.startsWith("@")) return;
  if (comment.startsWith("#")) return;

  // ── Bad word filter ──
  if (config.containsBadword(comment)) {
    console.log(`[Filter] Comment from @${nickname} blocked (bad word): ${comment.slice(0, 40)}...`);
    return;
  }

  const displayText = convertTiktokEmotes(comment);
  sse.broadcast("tiktok_chat", {
    user: nickname,
    user_id: userId,
    avatar: avatarUrl,
    text: displayText,
    time: now(),
    type: "chat",
  });

  // fire-and-forget TTS
  tts.speakText(comment).catch((e) => console.error("[TTS] error:", e.message));
}

function stopTiktokListener() {
  state.tiktokStopFlag = true;
  if (state.tiktokReconnectTimer) {
    clearTimeout(state.tiktokReconnectTimer);
    state.tiktokReconnectTimer = null;
  }
  state.tiktokConnected = false;
  if (state.tiktokWs) {
    const ws = state.tiktokWs;
    state.tiktokWs = null;
    try {
      ws.terminate();
    } catch (_) {}
  }
  sse.broadcast("tiktok_status", { connected: false, username: config.getTiktokUsername() });
}

async function fetchRoomId(username, apiKey) {
  // Try Euler Stream REST API first, fallback to TikTok HTML scrape
  try {
    const res = await axios.get(`${EULER_REST_URL}/webcast/room-id`, {
      params: { unique_id: username },
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10000,
    });
    if (res.data && res.data.room_id) return String(res.data.room_id);
  } catch (e) {
    console.log(`[TikTok] Euler Stream room-id failed: ${e.message}, trying direct scrape...`);
  }

  // Fallback: HTML scrape (no API key needed, but fragile)
  try {
    const res = await axios.get(`https://www.tiktok.com/@${username}/live`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 10000,
    });
    const match = res.data.match(/"roomId":"([0-9]+)"/);
    if (match) return match[1];
  } catch (e) {
    console.log(`[TikTok] Direct scrape failed: ${e.message}`);
  }
  return null;
}

function startTiktokListener() {
  stopTiktokListener();
  state.tiktokStopFlag = false;

  let retryDelay = 5000;
  const maxDelay = 120000;
  let pingInterval = null;

  const attempt = async () => {
    if (state.tiktokStopFlag) return;

    const username = config.getTiktokUsername();
    const apiKey = config.getEulerApiKey();

    if (!username) {
      console.log("[TikTok] No username set in config.json — listener waiting...");
      state.tiktokReconnectTimer = setTimeout(attempt, 10000);
      return;
    }

    if (!apiKey) {
      console.log("[TikTok] No euler_api_key set in config.json — get one free at https://www.eulerstream.com");
      state.tiktokReconnectTimer = setTimeout(attempt, 30000);
      return;
    }

    console.log(`[TikTok] Connecting to @${username} via Euler Stream...`);

    // Build WebSocket URL — TikTool managed WebSocket
    // Format: wss://api.tik.tools/ws?api_key=<key>&username=<user>
    const wsUrl = `${EULER_WS_URL}?api_key=${encodeURIComponent(apiKey)}&username=${encodeURIComponent(username)}`;

    let ws;
    try {
      ws = new WebSocket(wsUrl, {
        headers: {
          "User-Agent": "KanaeDesktop/4.0",
        },
        handshakeTimeout: 15000,
      });
    } catch (e) {
      console.error(`[TikTok] WebSocket creation failed: ${e.message}`);
      state.tiktokReconnectTimer = setTimeout(attempt, retryDelay);
      retryDelay = Math.min(retryDelay * 2, maxDelay);
      return;
    }

    state.tiktokWs = ws;

    ws.on("open", () => {
      state.tiktokConnected = true;
      state.tiktokError = "";
      const warmup = Number(config.loadConfig().settings?.tiktok_warmup_seconds ?? 5);
      state.tiktokReadyAt = Date.now() / 1000 + warmup;
      console.log(`[TikTok] Connected to @${username} — ignoring comments for ${warmup}s warmup`);
      sse.broadcast("tiktok_status", { connected: true, username });
      retryDelay = 5000;

      // Keepalive ping every 25s (some proxies drop idle WS after 30s)
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 25000);
    });

    ws.on("message", (raw) => {
      if (Date.now() / 1000 < state.tiktokReadyAt) return;

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        // Some providers send binary or non-JSON — ignore
        return;
      }

      // TikTool / Euler Stream event formats (flexible parser)
      const eventType = msg.event || msg.type || "";
      const data = msg.data || msg;

      try {
        switch (eventType.toLowerCase()) {
          case "chat":
          case "comment": {
            const user = extractUser(data.user || data);
            const text = data.comment || data.message || data.text || "";
            processTiktokComment(user.uid, user.nick, text, user.avatar).catch((e) =>
              console.error("[TikTok] comment processing error:", e.message)
            );
            break;
          }

          case "gift": {
            const user = extractUser(data.user || data);
            const gname = data.giftName || data.gift?.name || "Gift";
            const gcount = data.repeatCount || data.count || 1;
            sse.broadcast("tiktok_chat", {
              type: "gift",
              user: user.nick,
              user_id: user.uid,
              avatar: user.avatar,
              detail: `mengirim ${gname} x${gcount}`,
              time: now(),
            });
            break;
          }

          case "like": {
            const user = extractUser(data.user || data);
            const count = data.count || data.likeCount || 1;
            sse.broadcast("tiktok_chat", {
              type: "like",
              user: user.nick,
              user_id: user.uid,
              avatar: user.avatar,
              detail: `mengirim ${count} like`,
              time: now(),
            });
            break;
          }

          case "follow":
          case "social": {
            const user = extractUser(data.user || data);
            sse.broadcast("tiktok_chat", {
              type: "follow",
              user: user.nick,
              user_id: user.uid,
              avatar: user.avatar,
              detail: "mengikuti akun",
              time: now(),
            });
            break;
          }

          case "member":
          case "join": {
            const user = extractUser(data.user || data);
            sse.broadcast("tiktok_chat", {
              type: "member",
              user: user.nick,
              user_id: user.uid,
              avatar: user.avatar,
              detail: "bergabung ke live",
              time: now(),
            });
            break;
          }

          case "room":
          case "roominfo": {
            console.log(`[TikTok] Room info update: ${JSON.stringify(data)}`);
            break;
          }

          case "error": {
            console.error(`[TikTok] Provider error: ${data.message || JSON.stringify(data)}`);
            break;
          }

          default:
            // Silently ignore unknown events
            break;
        }
      } catch (e) {
        console.error("[TikTok] Event handler error:", e.message);
      }
    });

    ws.on("error", (err) => {
      state.tiktokError = String(err.message || err);
      console.error(`[TikTok] WebSocket error: ${state.tiktokError}`);
    });

    ws.on("close", (code, reason) => {
      state.tiktokConnected = false;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
      const reasonStr = reason ? reason.toString() : `code ${code}`;
      console.log(`[TikTok] Disconnected from @${username} (${reasonStr})`);
      sse.broadcast("tiktok_status", { connected: false, username });

      if (state.tiktokWs === ws && !state.tiktokStopFlag) {
        console.log(`[TikTok] Reconnecting in ${retryDelay / 1000}s...`);
        state.tiktokReconnectTimer = setTimeout(attempt, retryDelay);
        retryDelay = Math.min(retryDelay * 2, maxDelay);
      }
    });
  };

  attempt();
  console.log(`[TikTok] Listener started for @${config.getTiktokUsername()}`);
}

module.exports = { processTiktokComment, convertTiktokEmotes, startTiktokListener, stopTiktokListener };
