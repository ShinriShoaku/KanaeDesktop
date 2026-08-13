"use strict";
/**
 * TikTok Live integration — supports TWO interchangeable providers,
 * selectable via config.json's "tiktok_provider" field:
 *
 *   "tiktool"   (default) — TikTool Managed WebSocket (api.tik.tools).
 *                Pure ws + axios, no extra library. Requires an API key
 *                from https://tik.tools (config: "euler_api_key").
 *
 *   "connector" — the community library tiktok-live-connector
 *                (github.com/zerodytrash/TikTok-Live-Connector), which
 *                signs requests through Euler Stream (eulerstream.com).
 *                Works WITHOUT an API key (anonymous, shared rate limit),
 *                or with one for a higher limit (config: "eulerstream_api_key").
 *
 * NOTE: TikTool (tik.tools) and Euler Stream (eulerstream.com) are two
 * separate, unrelated services with their own separate API keys — a key
 * from one will NOT work with the other. Match the key to the provider
 * you select.
 *
 * Both providers funnel into the same processTiktokComment() handler and
 * the same tiktok_chat / tiktok_status SSE events, so the rest of the app
 * doesn't need to know which one is active.
 *
 * Setup:
 *   "tiktool":   sign up at https://tik.tools, paste key into euler_api_key
 *   "connector": (optional) sign up at https://www.eulerstream.com,
 *                paste key into eulerstream_api_key
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
const { TikTokLiveConnection, WebcastEvent } = require("tiktok-live-connector");

const EULER_WS_URL = "wss://api.tik.tools";
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
        const results = await youtube.searchYoutube(query, 2);
        if (!results.length) {
          sse.broadcast("tiktok_request", { user: nickname, query, status: "not_found" });
          if (state.recentRequests[0]) state.recentRequests[0].status = "not_found";
          return;
        }

        let info, top;
        try {
          const picked = await youtube.findPlayableInfo(results);
          info = picked.info;
          top = picked.candidate;
        } catch (e) {
          console.error(`[TikTok] All results unplayable for "${query}":`, e.failures || e.message);
          sse.broadcast("tiktok_request", {
            user: nickname,
            query,
            status: "not_found",
            error: "Semua hasil tidak bisa diputar (mungkin dibatasi umur/wilayah)",
          });
          if (state.recentRequests[0]) state.recentRequests[0].status = "not_found";
          return;
        }

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

  if (state.tiktokConnector) {
    const conn = state.tiktokConnector;
    state.tiktokConnector = null;
    try {
      conn.disconnect();
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

function startTiktoolListener() {
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
      console.log("[TikTok] No euler_api_key set in config.json — get one free at https://tik.tools");
      state.tiktokReconnectTimer = setTimeout(attempt, 30000);
      return;
    }

    console.log(`[TikTok] Connecting to @${username} via TikTool...`);

    // Build WebSocket URL — TikTool managed WebSocket
    // Format: wss://api.tik.tools?uniqueId=<user>&apiKey=<key>
    const uniqueId = username.replace(/^@/, "");
    const wsUrl = `${EULER_WS_URL}?uniqueId=${encodeURIComponent(uniqueId)}&apiKey=${encodeURIComponent(apiKey)}`;

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
  console.log(`[TikTok] Listener started for @${config.getTiktokUsername()} (provider: tiktool)`);
}

/**
 * Backend 2: tiktok-live-connector (github.com/zerodytrash/TikTok-Live-Connector).
 * Signs through Euler Stream. Works anonymously (no key) with a shared,
 * stricter rate limit, or with an eulerstream_api_key for a higher limit.
 */
function startConnectorListener() {
  let retryDelay = 5000;
  const maxDelay = 120000;

  const attempt = async () => {
    if (state.tiktokStopFlag) return;

    const username = config.getTiktokUsername();
    if (!username) {
      console.log("[TikTok] No username set in config.json — listener waiting...");
      state.tiktokReconnectTimer = setTimeout(attempt, 10000);
      return;
    }

    const eulerStreamKey = config.getEulerStreamApiKey();
    console.log(
      `[TikTok] Connecting to @${username} via tiktok-live-connector (Euler Stream${
        eulerStreamKey ? "" : ", anonymous — no eulerstream_api_key set"
      })...`
    );

    const connOptions = {};
    if (eulerStreamKey) connOptions.signApiKey = eulerStreamKey;

    const conn = new TikTokLiveConnection(username, connOptions);
    state.tiktokConnector = conn;

    conn.on(WebcastEvent.CHAT, (data) => {
      if (Date.now() / 1000 < state.tiktokReadyAt) return;
      const user = extractUser(data.user);
      const text = data.content || "";
      processTiktokComment(user.uid, user.nick, text, user.avatar).catch((e) =>
        console.error("[TikTok] comment processing error:", e.message)
      );
    });

    conn.on(WebcastEvent.GIFT, (data) => {
      if (Date.now() / 1000 < state.tiktokReadyAt) return;
      const user = extractUser(data.user);
      const gname = data.gift?.name || "Gift";
      const gcount = data.repeatCount || 1;
      sse.broadcast("tiktok_chat", {
        type: "gift",
        user: user.nick,
        user_id: user.uid,
        avatar: user.avatar,
        detail: `mengirim ${gname} x${gcount}`,
        time: now(),
      });
    });

    conn.on(WebcastEvent.LIKE, (data) => {
      if (Date.now() / 1000 < state.tiktokReadyAt) return;
      const user = extractUser(data.user);
      const count = data.count || 1;
      sse.broadcast("tiktok_chat", {
        type: "like",
        user: user.nick,
        user_id: user.uid,
        avatar: user.avatar,
        detail: `mengirim ${count} like`,
        time: now(),
      });
    });

    conn.on(WebcastEvent.FOLLOW, (data) => {
      if (Date.now() / 1000 < state.tiktokReadyAt) return;
      const user = extractUser(data.user);
      sse.broadcast("tiktok_chat", {
        type: "follow",
        user: user.nick,
        user_id: user.uid,
        avatar: user.avatar,
        detail: "mengikuti akun",
        time: now(),
      });
    });

    conn.on(WebcastEvent.MEMBER, (data) => {
      if (Date.now() / 1000 < state.tiktokReadyAt) return;
      const user = extractUser(data.user);
      sse.broadcast("tiktok_chat", {
        type: "member",
        user: user.nick,
        user_id: user.uid,
        avatar: user.avatar,
        detail: "bergabung ke live",
        time: now(),
      });
    });

    conn.on("streamEnd", () => {
      console.log(`[TikTok] Livestream @${username} ended.`);
    });

    conn.on("error", (err) => {
      state.tiktokError = String(err?.message || err);
      console.error(`[TikTok] Connector error: ${state.tiktokError}`);
    });

    conn.on("disconnected", () => {
      state.tiktokConnected = false;
      console.log(`[TikTok] Disconnected from @${username}`);
      sse.broadcast("tiktok_status", { connected: false, username });

      if (state.tiktokConnector === conn && !state.tiktokStopFlag) {
        console.log(`[TikTok] Reconnecting in ${retryDelay / 1000}s...`);
        state.tiktokReconnectTimer = setTimeout(attempt, retryDelay);
        retryDelay = Math.min(retryDelay * 2, maxDelay);
      }
    });

    try {
      const roomInfo = await conn.connect();
      state.tiktokConnected = true;
      state.tiktokError = "";
      const warmup = Number(config.loadConfig().settings?.tiktok_warmup_seconds ?? 5);
      state.tiktokReadyAt = Date.now() / 1000 + warmup;
      console.log(`[TikTok] Connected to @${username} (roomId=${roomInfo.roomId}) — ignoring comments for ${warmup}s warmup`);
      sse.broadcast("tiktok_status", { connected: true, username });
      retryDelay = 5000;
    } catch (e) {
      console.error(`[TikTok] Connect failed: ${e.message}`);
      state.tiktokError = String(e.message || e);
      state.tiktokConnector = null;
      if (!state.tiktokStopFlag) {
        console.log(`[TikTok] Reconnecting in ${retryDelay / 1000}s...`);
        state.tiktokReconnectTimer = setTimeout(attempt, retryDelay);
        retryDelay = Math.min(retryDelay * 2, maxDelay);
      }
    }
  };

  attempt();
  console.log(`[TikTok] Listener started for @${config.getTiktokUsername()} (provider: connector)`);
}

/**
 * Dispatcher — picks the backend based on config.json's "tiktok_provider".
 */
function startTiktokListener() {
  stopTiktokListener();
  state.tiktokStopFlag = false;

  const provider = config.getTiktokProvider();
  if (provider === "connector") {
    startConnectorListener();
  } else {
    startTiktoolListener();
  }
}

module.exports = { processTiktokComment, convertTiktokEmotes, startTiktokListener, stopTiktokListener };