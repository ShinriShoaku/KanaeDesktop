"use strict";

const DEFAULT_OVERLAY_CONFIG = {
  show_now_playing: true,
  show_queue: true,
  show_request_feed: true,
  show_commands_hint: true,
  show_skip_vote: true,
  show_next_up: true,
  show_progress_bar: true,
  show_thumbnail: true,
  show_requester: true,
  show_channel: true,
  show_tiktok_dot: true,
  show_subtitle: true,

  show_chat: true,
  position_chat: "left",
  chat_width: 340,
  chat_fade_seconds: 18,

  max_queue_items: 6,
  max_request_items: 8,

  accent_color: "#f97316",
  accent_color2: "#a855f7",
  font_size_title: 20,
  subtitle_font_size: 28,
  opacity_panels: 0.82,
  position_queue: "right",
  position_commands: "left",
};

module.exports = { DEFAULT_OVERLAY_CONFIG };
