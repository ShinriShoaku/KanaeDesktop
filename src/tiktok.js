"use strict";
// tiktok-live-connector is only required when a listener is actually started
// (lazy-required inside startTiktokListener), so the module - and its
// dependency tree - isn't loaded into memory for users who never use the
// TikTok integration.
const EMOTES = require("./tiktokEmotes.json");
const config = require("./config");
const { state, addRecentRequest, queueLen } = require("./state");
const sse = require("./sse");
const youtube = require("./youtube");
const playerService = require("./playerService");
const tts = require("./tts");

function now() {
  return new Date().toISOString().substr(11, 8);
}

function convertTiktokEmotes(text) {
  return text.replace(/\[[^\]]{1,20}\]/g, (m) => EMOTES[m.toLowerCase()] || m);
}

// ── Defensive field extraction (proto field names vary by lib version) ──
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

  // ── TTS: read plain comments (not a command, not starting with @ or #) ──
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

  // fire-and-forget, mirrors the Python daemon thread
  tts.speakText(comment).catch((e) => console.error("[TTS] error:", e.message));
}

function stopTiktokListener() {
  state.tiktokStopFlag = true;
  if (state.tiktokReconnectTimer) {
    clearTimeout(state.tiktokReconnectTimer);
    state.tiktokReconnectTimer = null;
  }
  state.tiktokConnected = false;
  if (state.tiktokConnection) {
    const conn = state.tiktokConnection;
    state.tiktokConnection = null;
    conn.disconnect().catch(() => {});
  }
  sse.broadcast("tiktok_status", { connected: false, username: config.getTiktokUsername() });
}

function startTiktokListener() {
  stopTiktokListener();
  state.tiktokStopFlag = false;

  // Lazy-require: only pulls in tiktok-live-connector (and its deps) once a
  // listener is actually started, instead of at server boot.
  const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require("tiktok-live-connector");

  let retryDelay = 5000;
  const maxDelay = 120000;

  const attempt = async () => {
    if (state.tiktokStopFlag) return;
    const username = config.getTiktokUsername();
    if (!username) {
      console.log("[TikTok] No username set in config.json - listener waiting...");
      state.tiktokReconnectTimer = setTimeout(attempt, 10000);
      return;
    }

    console.log(`[TikTok] Connecting to @${username}...`);
    const conn = new TikTokLiveConnection(username);
    state.tiktokConnection = conn;

    conn.on(ControlEvent.CONNECTED, () => {
      state.tiktokConnected = true;
      state.tiktokError = "";
      const warmup = Number(config.loadConfig().settings?.tiktok_warmup_seconds ?? 5);
      state.tiktokReadyAt = Date.now() / 1000 + warmup;
      console.log(`[TikTok] Connected to @${username} - ignoring comments for ${warmup}s warmup`);
      sse.broadcast("tiktok_status", { connected: true, username });
      retryDelay = 5000; // reset backoff on success
    });

    conn.on(ControlEvent.DISCONNECTED, () => {
      state.tiktokConnected = false;
      console.log(`[TikTok] Disconnected from @${username}`);
      sse.broadcast("tiktok_status", { connected: false, username });
      if (state.tiktokConnection === conn && !state.tiktokStopFlag) {
        console.log(`[TikTok] Reconnecting in ${retryDelay / 1000}s...`);
        state.tiktokReconnectTimer = setTimeout(attempt, retryDelay);
        retryDelay = Math.min(retryDelay * 2, maxDelay);
      }
    });

    conn.on(ControlEvent.ERROR, (err) => {
      state.tiktokError = String(err?.message || err);
      console.error(`[TikTok] Error: ${state.tiktokError}`);
    });

    conn.on(WebcastEvent.CHAT, async (data) => {
      if (Date.now() / 1000 < state.tiktokReadyAt) return;
      const { uid, nick, avatar } = extractUser(data.user);
      const text = data.comment ?? data.content ?? "";
      try {
        await processTiktokComment(uid, nick, text, avatar);
      } catch (e) {
        console.error("[TikTok] comment processing error:", e.message);
      }
    });

    conn.on(WebcastEvent.GIFT, (data) => {
      try {
        const { uid, nick, avatar } = extractUser(data.user);
        const gname = data.giftName || data.gift?.name || "Gift";
        const gcount = data.repeatCount || 1;
        sse.broadcast("tiktok_chat", {
          type: "gift",
          user: nick,
          user_id: uid,
          avatar,
          detail: `mengirim ${gname} x${gcount}`,
          time: now(),
        });
      } catch (e) {
        console.error("[TikTok] Gift event error:", e.message);
      }
    });

    conn.on(WebcastEvent.LIKE, (data) => {
      try {
        const { uid, nick, avatar } = extractUser(data.user);
        const count = data.count || 1;
        sse.broadcast("tiktok_chat", {
          type: "like",
          user: nick,
          user_id: uid,
          avatar,
          detail: `mengirim ${count} like`,
          time: now(),
        });
      } catch (e) {
        console.error("[TikTok] Like event error:", e.message);
      }
    });

    conn.on(WebcastEvent.FOLLOW, (data) => {
      try {
        const { uid, nick, avatar } = extractUser(data.user);
        sse.broadcast("tiktok_chat", { type: "follow", user: nick, user_id: uid, avatar, detail: "mengikuti akun", time: now() });
      } catch (e) {
        console.error("[TikTok] Follow event error:", e.message);
      }
    });

    try {
      await conn.connect();
    } catch (e) {
      state.tiktokError = String(e.message || e);
      console.error(`[TikTok] Connect error: ${state.tiktokError}`);
      state.tiktokConnected = false;
      sse.broadcast("tiktok_status", { connected: false, username, error: state.tiktokError });

      if (state.tiktokStopFlag) return;
      console.log(`[TikTok] Reconnecting in ${retryDelay / 1000}s...`);
      state.tiktokReconnectTimer = setTimeout(attempt, retryDelay);
      retryDelay = Math.min(retryDelay * 2, maxDelay);
      return;
    }
  };

  attempt();
  console.log(`[TikTok] Listener started for @${config.getTiktokUsername()}`);
}

module.exports = { processTiktokComment, convertTiktokEmotes, startTiktokListener, stopTiktokListener };
