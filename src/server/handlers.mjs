import { media } from "@devvit/media";
import { reddit } from "@devvit/reddit";
import { redis } from "@devvit/redis";
import { scheduler } from "@devvit/scheduler";
import { settings } from "@devvit/settings";
import { RichTextBuilder } from "@devvit/shared-types/richtext/RichTextBuilder.js";
import { markdownToRichParagraphs } from "../core/richtext.mjs";
import {
  clamp,
  buildPollingCron,
  normalizeString,
  normalizeSubredditName,
  parsePositiveInt,
} from "../core/schedule.mjs";
import {
  buildTelegramApiUrl,
  buildTelegramFileUrl,
  groupChannelPosts,
  markSeen,
  parseState,
  redactToken,
  renderTelegramPost,
} from "../core/telegram.mjs";

/**
 * Task name shared between the scheduler declaration in `devvit.json`
 * (`scheduler.tasks.poll-telegram`) and the runtime `scheduler.runJob` calls.
 */
export const JOB_NAME = "poll-telegram";

const DEFAULT_MAX_POSTS_PER_RUN = 1;

/**
 * Fetch new channel posts with `getUpdates` and submit each one as a Reddit
 * post. Invoked by the `/internal/scheduler/poll-telegram` endpoint on each
 * cron tick (and the warm-up run scheduled at install/upgrade).
 */
export async function runPollJob() {
  const token = normalizeString(await settings.get("telegramBotToken"));
  const channel = normalizeString(await settings.get("telegramChannel"));
  const targetSubreddit = normalizeSubredditName(await settings.get("targetSubreddit"));
  const maxPostsPerRun = parsePositiveInt(await settings.get("maxPostsPerRun"), DEFAULT_MAX_POSTS_PER_RUN);
  const titlePrefix = normalizeString(await settings.get("titlePrefix"));
  const includeMedia = (await settings.get("includeMedia")) !== false;
  const flairId = normalizeString(await settings.get("flairId"));
  const flairText = normalizeString(await settings.get("flairText"));
  const autoApprove = (await settings.get("autoApprove")) === true;
  const flair = {
    ...(flairId ? { flairId } : {}),
    ...(flairText ? { flairText } : {}),
  };

  console.log(
    `[${JOB_NAME}] run started target=${targetSubreddit || "(empty)"} channel=${channel || "(empty)"} maxPostsPerRun=${maxPostsPerRun}`
  );

  if (!token || !channel || !targetSubreddit) {
    console.log(`[${JOB_NAME}] Missing telegramBotToken, telegramChannel or targetSubreddit setting. Skipping run.`);
    return;
  }

  const stateKey = `tg:state:${targetSubreddit}`;
  let state = parseState(await redis.get(stateKey));

  const updates = await callTelegram(token, "getUpdates", {
    offset: state.offset || undefined,
    allowed_updates: JSON.stringify(["channel_post"]),
    timeout: 0,
  });
  const posts = groupChannelPosts(updates, channel).filter((post) => !state.seen.includes(post.key));
  console.log(`[${JOB_NAME}] updates=${updates.length} newPosts=${posts.length}`);

  const toPost = posts.slice(0, maxPostsPerRun);
  for (const post of toPost) {
    const rendered = renderTelegramPost(post.message, { titlePrefix });
    const uploaded = includeMedia && post.media ? await uploadTelegramMedia(token, post.media) : null;
    const common = { subredditName: targetSubreddit, title: rendered.title, ...flair };

    const submitted = uploaded
      ? await reddit.submitPost({ ...common, richtext: buildRichtextBody(uploaded, rendered.bodyText) })
      : await reddit.submitPost({ ...common, text: rendered.bodyText || " " });

    if (autoApprove) {
      try {
        await submitted.approve();
      } catch (err) {
        console.error(`[${JOB_NAME}] approve failed: ${errorMessage(err)}`);
      }
    }

    state = markSeen(state, post.key, post.lastUpdateId + 1);
    await redis.set(stateKey, JSON.stringify(state));
    console.log(`[${JOB_NAME}] Posted ${post.key}`);
  }

  // Acknowledge everything up to the first post still waiting (or the whole
  // batch), so other chats' updates and handled albums are not fetched again.
  const waiting = posts[toPost.length];
  const lastUpdate = updates[updates.length - 1];
  const offset = waiting ? waiting.firstUpdateId : lastUpdate ? lastUpdate.update_id + 1 : state.offset;
  if (offset > state.offset) {
    state = { ...state, offset };
    await redis.set(stateKey, JSON.stringify(state));
  }
}

/**
 * @param {string} token
 * @param {string} method
 * @param {Record<string, string | number | undefined>} params
 * @returns {Promise<any>}
 */
async function callTelegram(token, method, params) {
  let response;
  try {
    response = await fetch(buildTelegramApiUrl(token, method, params));
  } catch (err) {
    throw new Error(`Telegram ${method} failed: ${redactToken(errorMessage(err), token)}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    const description = redactToken(String(body?.description ?? ""), token);
    throw new Error(`Telegram ${method} failed with status ${response.status}: ${description}`);
  }
  return body.result;
}

/**
 * Download a Telegram file into Reddit's media store. Returns null on failure
 * so the caller falls back to a plain text post instead of skipping the entry.
 *
 * @param {string} token
 * @param {import("../core/telegram.mjs").TelegramMedia} telegramMedia
 * @returns {Promise<{ type: "image" | "video"; mediaUrl: string } | null>}
 */
async function uploadTelegramMedia(token, telegramMedia) {
  try {
    const file = await callTelegram(token, "getFile", { file_id: telegramMedia.fileId });
    const asset = await media.upload({ url: buildTelegramFileUrl(token, file.file_path), type: telegramMedia.type });
    return { type: telegramMedia.type, mediaUrl: asset.mediaUrl };
  } catch (err) {
    console.error(`[${JOB_NAME}] ${telegramMedia.type} upload failed: ${redactToken(errorMessage(err), token)}`);
    return null;
  }
}

/**
 * @param {{ type: "image" | "video"; mediaUrl: string }} uploaded
 * @param {string} bodyText
 * @returns {string}
 */
function buildRichtextBody(uploaded, bodyText) {
  const builder = new RichTextBuilder();
  if (uploaded.type === "video") {
    builder.video({ mediaUrl: uploaded.mediaUrl });
  } else {
    builder.image({ mediaUrl: uploaded.mediaUrl });
  }
  for (const lines of markdownToRichParagraphs(bodyText)) {
    builder.paragraph((paragraph) => {
      lines.forEach((segments, index) => {
        if (index > 0) {
          paragraph.linebreak();
        }
        for (const segment of segments) {
          if (segment.url) {
            paragraph.link({ text: segment.text, url: segment.url });
          } else {
            paragraph.text({ text: segment.text });
          }
        }
      });
    });
  }
  return builder.build();
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * (Re)register the recurring polling cron and a one-off warm-up run. Invoked by
 * the `/internal/on-app-install` and `/internal/on-app-upgrade` triggers so the
 * cron interval tracks the per-installation `pollMinutes` setting.
 */
export async function schedulePollingJob() {
  const pollMinutes = clamp(parsePositiveInt(await settings.get("pollMinutes"), 15), 1, 60);
  const cron = buildPollingCron(pollMinutes);
  console.log(`[${JOB_NAME}] Scheduling with cron=${cron}`);
  await scheduler.runJob({ name: JOB_NAME, cron });

  const warmupAt = new Date(Date.now() + 15_000);
  await scheduler.runJob({ name: JOB_NAME, runAt: warmupAt });
  console.log(`[${JOB_NAME}] Scheduled warm-up run at ${warmupAt.toISOString()}`);
}

/**
 * Raw Node request handler passed to `createServer`. Routes the Devvit-internal
 * endpoints declared in `devvit.json` (scheduler task + install/upgrade triggers).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} rsp
 */
export async function serverOnRequest(req, rsp) {
  try {
    await routeRequest(req, rsp);
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`server error; ${message}`);
    writeJson(rsp, 500, { status: "error", message: errorMessage(err) });
  }
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} rsp
 */
async function routeRequest(req, rsp) {
  const path = (req.url ?? "").split("?")[0];

  switch (path) {
    case "/internal/scheduler/poll-telegram":
      await runPollJob();
      return writeJson(rsp, 200, { status: "ok" });
    case "/internal/on-app-install":
    case "/internal/on-app-upgrade":
      await schedulePollingJob();
      return writeJson(rsp, 200, { status: "ok" });
    default:
      return writeJson(rsp, 404, { status: "error", message: `not found: ${path}` });
  }
}

/**
 * @param {import("node:http").ServerResponse} rsp
 * @param {number} status
 * @param {Record<string, unknown>} json
 */
function writeJson(rsp, status, json) {
  const body = JSON.stringify(json);
  rsp.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  rsp.end(body);
}
