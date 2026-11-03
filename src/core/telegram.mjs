/**
 * Pure helpers for turning Telegram Bot API `getUpdates` results into Reddit
 * posts. No network or Devvit runtime access, so everything here is unit tested.
 */

const TELEGRAM_API = "https://api.telegram.org";
const DEFAULT_MAX_TITLE_CHARS = 300;
const DEFAULT_MAX_BODY_CHARS = 12000;
const DEFAULT_MAX_SEEN = 500;

/** Bot API `getFile` refuses files larger than this. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/**
 * @typedef {{ id: number; title?: string; username?: string; type?: string }} TelegramChat
 * @typedef {{ type: string; offset: number; length: number; url?: string }} TelegramEntity
 * @typedef {{ file_id: string; file_size?: number; width?: number; height?: number }} TelegramFile
 * @typedef {Object} TelegramMessage
 * @property {number} message_id
 * @property {TelegramChat} chat
 * @property {string} [text]
 * @property {string} [caption]
 * @property {TelegramEntity[]} [entities]
 * @property {TelegramEntity[]} [caption_entities]
 * @property {TelegramFile[]} [photo]
 * @property {TelegramFile} [video]
 * @property {TelegramFile} [animation]
 * @property {string} [media_group_id]
 * @typedef {{ update_id: number; channel_post?: TelegramMessage }} TelegramUpdate
 */

/**
 * @typedef {{ type: "image" | "video"; fileId: string }} TelegramMedia
 * @typedef {Object} ChannelPost
 * @property {string} key Dedupe key: one per message, or one per album.
 * @property {number} firstUpdateId
 * @property {number} lastUpdateId
 * @property {TelegramMessage} message The message carrying the text (an album's captioned item).
 * @property {TelegramMedia | null} media
 */

/**
 * @param {string} token
 * @param {string} method
 * @param {Record<string, string | number | undefined>} [params]
 * @returns {string}
 */
export function buildTelegramApiUrl(token, method, params = {}) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(name, String(value));
    }
  }
  const search = query.toString();
  return `${TELEGRAM_API}/bot${token}/${method}${search ? `?${search}` : ""}`;
}

/**
 * @param {string} token
 * @param {string} filePath `file_path` from a `getFile` result.
 * @returns {string}
 */
export function buildTelegramFileUrl(token, filePath) {
  return `${TELEGRAM_API}/file/bot${token}/${filePath}`;
}

/**
 * Replace every occurrence of the bot token so it never reaches logs.
 *
 * @param {string} text
 * @param {string} token
 * @returns {string}
 */
export function redactToken(text, token) {
  return token ? String(text).split(token).join("<token>") : String(text);
}

/**
 * Accepts a numeric chat id (`-1001234567890`) or a public username
 * (`@cheagana`, `cheagana`, `https://t.me/cheagana`).
 *
 * @param {TelegramChat | undefined} chat
 * @param {string} channel
 * @returns {boolean}
 */
export function matchesChannel(chat, channel) {
  const wanted = String(channel || "")
    .trim()
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@/, "")
    .toLowerCase();
  if (!chat || !wanted) {
    return false;
  }
  if (/^-?\d+$/.test(wanted)) {
    return String(chat.id) === wanted;
  }
  return String(chat.username || "").toLowerCase() === wanted;
}

/**
 * Keep the configured channel's posts and merge album items (same
 * `media_group_id`) into one post. Updates must be in `update_id` order, as
 * `getUpdates` returns them.
 *
 * @param {TelegramUpdate[]} updates
 * @param {string} channel
 * @returns {ChannelPost[]}
 */
export function groupChannelPosts(updates, channel) {
  /** @type {ChannelPost[]} */
  const posts = [];
  /** @type {Map<string, ChannelPost>} */
  const albums = new Map();

  for (const update of updates) {
    const message = update.channel_post;
    if (!message || !matchesChannel(message.chat, channel)) {
      continue;
    }

    const albumKey = message.media_group_id ? `g:${message.chat.id}:${message.media_group_id}` : "";
    const album = albumKey ? albums.get(albumKey) : undefined;
    if (album) {
      album.lastUpdateId = update.update_id;
      if (!messageText(album.message).text && messageText(message).text) {
        album.message = message;
      }
      album.media = album.media || pickMedia(message);
      continue;
    }

    /** @type {ChannelPost} */
    const post = {
      key: albumKey || `m:${message.chat.id}:${message.message_id}`,
      firstUpdateId: update.update_id,
      lastUpdateId: update.update_id,
      message,
      media: pickMedia(message),
    };
    posts.push(post);
    if (albumKey) {
      albums.set(albumKey, post);
    }
  }

  return posts;
}

/**
 * Largest photo size, else the video or animation. Files over the Bot API
 * download limit are skipped (the post goes out as text).
 *
 * @param {TelegramMessage} message
 * @returns {TelegramMedia | null}
 */
export function pickMedia(message) {
  const video = message.video || message.animation;
  if (video) {
    return fitsDownloadLimit(video) ? { type: "video", fileId: video.file_id } : null;
  }
  const photos = Array.isArray(message.photo) ? message.photo : [];
  const largest = photos.reduce(
    (best, photo) => (!best || photoArea(photo) > photoArea(best) ? photo : best),
    /** @type {TelegramFile | undefined} */ (undefined)
  );
  return largest && fitsDownloadLimit(largest) ? { type: "image", fileId: largest.file_id } : null;
}

/**
 * @param {TelegramFile} file
 * @returns {boolean}
 */
function fitsDownloadLimit(file) {
  return !file.file_size || file.file_size <= MAX_DOWNLOAD_BYTES;
}

/**
 * @param {TelegramFile} photo
 * @returns {number}
 */
function photoArea(photo) {
  return (photo.width || 0) * (photo.height || 0) || photo.file_size || 0;
}

/**
 * @param {TelegramMessage} message
 * @returns {{ text: string; entities: TelegramEntity[] }}
 */
function messageText(message) {
  return {
    text: String(message.text ?? message.caption ?? ""),
    entities: message.entities ?? message.caption_entities ?? [],
  };
}

/**
 * Telegram text plus its link entities as Reddit markdown. Offsets are UTF-16
 * code units, which is also how JavaScript indexes strings.
 *
 * @param {string} text
 * @param {TelegramEntity[]} entities
 * @returns {string}
 */
export function entitiesToMarkdown(text, entities) {
  const links = (entities || [])
    .filter((entity) => entity.type === "text_link" || entity.type === "url")
    .sort((a, b) => a.offset - b.offset);

  let out = "";
  let cursor = 0;
  for (const entity of links) {
    if (entity.offset < cursor) {
      continue;
    }
    const label = text.slice(entity.offset, entity.offset + entity.length);
    const url = entity.type === "text_link" ? entity.url : label;
    if (!url || !/^https?:\/\//i.test(url)) {
      continue;
    }
    out += text.slice(cursor, entity.offset) + `[${label}](${url})`;
    cursor = entity.offset + entity.length;
  }
  return out + text.slice(cursor);
}

/**
 * Title = first non-empty line of the message; body = the remaining lines.
 * No link back to Telegram: Reddit's spam filter removes posts with t.me links.
 *
 * @param {TelegramMessage} message
 * @param {{ titlePrefix?: string; maxTitleChars?: number; maxBodyChars?: number }} [options]
 * @returns {{ title: string; bodyText: string }}
 */
export function renderTelegramPost(message, options = {}) {
  const maxTitleChars = options.maxTitleChars || DEFAULT_MAX_TITLE_CHARS;
  const maxBodyChars = options.maxBodyChars || DEFAULT_MAX_BODY_CHARS;
  const { text, entities } = messageText(message);

  const plainLines = text.split("\n");
  const markdownLines = entitiesToMarkdown(text, entities).split("\n");
  const titleIndex = plainLines.findIndex((line) => line.trim() !== "");

  const heading = titleIndex === -1 ? message.chat.title || "New post" : plainLines[titleIndex].trim();
  const prefix = String(options.titlePrefix || "").trim();
  const title = clipText(prefix ? `${prefix} ${heading}` : heading, maxTitleChars);

  const body = titleIndex === -1 ? "" : markdownLines.slice(titleIndex + 1).join("\n").trim();
  return { title, bodyText: clipText(body, maxBodyChars) };
}

/**
 * @typedef {{ offset: number; seen: string[] }} BotState
 */

/**
 * @param {string | null | undefined} raw
 * @returns {BotState}
 */
export function parseState(raw) {
  try {
    const parsed = JSON.parse(raw || "");
    return {
      offset: Number.isInteger(parsed?.offset) ? parsed.offset : 0,
      seen: Array.isArray(parsed?.seen) ? parsed.seen.filter((key) => typeof key === "string") : [],
    };
  } catch {
    return { offset: 0, seen: [] };
  }
}

/**
 * Record a handled post: newest key first, capped so the state stays small.
 *
 * @param {BotState} state
 * @param {string} key
 * @param {number} offset
 * @param {number} [maxSeen]
 * @returns {BotState}
 */
export function markSeen(state, key, offset, maxSeen = DEFAULT_MAX_SEEN) {
  return {
    offset,
    seen: [key, ...state.seen.filter((item) => item !== key)].slice(0, maxSeen),
  };
}

/**
 * @param {string} value
 * @param {number} maxChars
 * @returns {string}
 */
export function clipText(value, maxChars) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
