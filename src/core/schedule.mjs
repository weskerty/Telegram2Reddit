/**
 * Scheduling and settings-normalization helpers for the Telegram poll bot.
 *
 * These are pure functions split out from the Devvit entry point so they stay
 * unit-testable without the Devvit Web runtime.
 */

/**
 * Build the cron expression for the polling job from a poll interval in minutes.
 *
 * @param {number} pollMinutes
 * @returns {string}
 */
export function buildPollingCron(pollMinutes) {
  if (pollMinutes >= 60) {
    return "0 * * * *";
  }
  return `*/${pollMinutes} * * * *`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeString(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

/**
 * Normalize a target subreddit setting into the bare name expected by the
 * Reddit API (strips a leading `r/`, maps `u/name` to the `u_name` profile sub).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSubredditName(value) {
  let text = normalizeString(value);
  if (!text) {
    return "";
  }

  text = text.replace(/^\/?r\//i, "");

  const userMatch = text.match(/^\/?u\/(.+)$/i);
  if (userMatch) {
    text = `u_${String(userMatch[1] || "").trim()}`;
  }

  return text.trim();
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
