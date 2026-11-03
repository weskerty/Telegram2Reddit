import { beforeEach, expect, test, vi } from "vitest";

const TOKEN = "123456:SECRET";
const TARGET_SUBREDDIT = "ParaguayActividades";
const CHAT = { id: -1001234567890, title: "Actividades Paraguay", username: "cheagana", type: "channel" };
const STATE_KEY = `tg:state:${TARGET_SUBREDDIT}`;

// Shared mutable test doubles for the mocked `@devvit/*` server packages.
// Hoisted so they are initialized before the module factories run.
const harness = vi.hoisted(() => ({
  /** @type {Record<string, unknown>} */
  settingsValues: {},
  /** @type {Map<string, string>} */
  redisStore: new Map(),
  submitPost: vi.fn(),
  getPostById: vi.fn(),
  approve: vi.fn(),
  upload: vi.fn(),
  runJob: vi.fn(),
}));

vi.mock("@devvit/settings", () => ({
  settings: {
    get: async (key) => harness.settingsValues[key],
    getAll: async () => harness.settingsValues,
  },
}));

vi.mock("@devvit/redis", () => ({
  redis: {
    get: async (key) => (harness.redisStore.has(key) ? harness.redisStore.get(key) : undefined),
    set: async (key, value) => {
      harness.redisStore.set(key, value);
    },
  },
}));

vi.mock("@devvit/reddit", () => ({
  reddit: {
    submitPost: harness.submitPost,
    getPostById: harness.getPostById,
  },
}));

vi.mock("@devvit/media", () => ({
  media: {
    upload: harness.upload,
  },
}));

vi.mock("@devvit/scheduler", () => ({
  scheduler: {
    runJob: harness.runJob,
  },
}));

const { runPollJob, schedulePollingJob, verifyPost, serverOnRequest, JOB_NAME, VERIFY_JOB_NAME } = await import(
  "../src/server/handlers.mjs"
);

/**
 * @param {number} updateId
 * @param {Record<string, unknown>} message
 */
function channelPost(updateId, message) {
  return { update_id: updateId, channel_post: { message_id: updateId, chat: CHAT, ...message } };
}

/**
 * Fake the Telegram Bot API: `getUpdates` returns updates at or after the
 * requested offset; `getFile` resolves any file id to a path.
 *
 * @param {object[]} updates
 */
function mockTelegram(updates) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/getUpdates")) {
      const offset = Number(url.searchParams.get("offset") || 0);
      const result = updates.filter((item) => item.update_id >= offset);
      return Response.json({ ok: true, result });
    }
    if (url.pathname.endsWith("/getFile")) {
      return Response.json({ ok: true, result: { file_path: `files/${url.searchParams.get("file_id")}.bin` } });
    }
    return new Response("not found", { status: 404 });
  });
}

function readState() {
  return JSON.parse(harness.redisStore.get(STATE_KEY) ?? "null");
}

beforeEach(() => {
  harness.settingsValues = {
    telegramBotToken: TOKEN,
    telegramChannel: "@cheagana",
    targetSubreddit: TARGET_SUBREDDIT,
    pollMinutes: 15,
    maxPostsPerRun: 5,
  };
  harness.redisStore.clear();
  harness.approve.mockReset();
  harness.approve.mockResolvedValue(undefined);
  harness.submitPost.mockReset();
  harness.submitPost.mockResolvedValue({
    id: "t3_test",
    permalink: "/r/ParaguayActividades/comments/test/x/",
    approve: harness.approve,
  });
  harness.getPostById.mockReset();
  harness.upload.mockReset();
  harness.upload.mockResolvedValue({ mediaId: "media-1", mediaUrl: "https://i.redd.it/media-1.jpg" });
  harness.runJob.mockReset();
  harness.runJob.mockResolvedValue("scheduled-job-id");
  vi.restoreAllMocks();
});

test("runPollJob posts a text message once and is idempotent on rerun", async () => {
  const fetchSpy = mockTelegram([channelPost(10, { text: "Birra y Politica\nHablemos.\n\n🗓️ 30/10" })]);

  await runPollJob();

  expect(harness.submitPost).toHaveBeenCalledTimes(1);
  const submitArgs = harness.submitPost.mock.calls[0][0];
  expect(submitArgs).toMatchObject({ subredditName: TARGET_SUBREDDIT, title: "Birra y Politica" });
  expect(submitArgs.text).toBe("Hablemos.\n\n🗓️ 30/10");
  expect(readState()).toEqual({ offset: 11, seen: ["m:-1001234567890:10"] });

  const firstUrl = new URL(String(fetchSpy.mock.calls[0][0]));
  expect(firstUrl.searchParams.get("allowed_updates")).toBe('["channel_post"]');
  expect(firstUrl.searchParams.has("offset")).toBe(false);

  await runPollJob();
  expect(harness.submitPost).toHaveBeenCalledTimes(1);
  expect(new URL(String(fetchSpy.mock.calls[1][0])).searchParams.get("offset")).toBe("11");
});

test("runPollJob embeds an uploaded photo in a richtext post", async () => {
  mockTelegram([
    channelPost(10, {
      caption: "Marcha\nVer mapa",
      caption_entities: [{ type: "text_link", offset: 11, length: 4, url: "https://maps.example.com/x" }],
      photo: [
        { file_id: "small", width: 90, height: 90 },
        { file_id: "big", width: 1280, height: 720 },
      ],
    }),
  ]);

  await runPollJob();

  expect(harness.upload).toHaveBeenCalledWith({ url: `https://api.telegram.org/file/bot${TOKEN}/files/big.bin`, type: "image" });
  const submitArgs = harness.submitPost.mock.calls[0][0];
  expect(submitArgs.text).toBeUndefined();
  const doc = JSON.stringify(JSON.parse(submitArgs.richtext));
  expect(doc).toContain("https://i.redd.it/media-1.jpg");
  expect(doc).toContain("https://maps.example.com/x");
  expect(doc).not.toContain("t.me/");
});

test("runPollJob uploads videos as video", async () => {
  harness.upload.mockResolvedValue({ mediaId: "media-2", mediaUrl: "https://v.redd.it/media-2" });
  mockTelegram([channelPost(10, { caption: "Video", video: { file_id: "vid", file_size: 1000 } })]);

  await runPollJob();

  expect(harness.upload).toHaveBeenCalledWith({ url: `https://api.telegram.org/file/bot${TOKEN}/files/vid.bin`, type: "video" });
  expect(harness.submitPost.mock.calls[0][0].richtext).toContain("https://v.redd.it/media-2");
});

test("runPollJob falls back to text and never logs the token when upload fails", async () => {
  harness.upload.mockRejectedValue(new Error(`cannot fetch https://api.telegram.org/file/bot${TOKEN}/files/big.bin`));
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  mockTelegram([channelPost(10, { caption: "Foto\nTexto", photo: [{ file_id: "big" }] })]);

  await runPollJob();

  const submitArgs = harness.submitPost.mock.calls[0][0];
  expect(submitArgs.richtext).toBeUndefined();
  expect(submitArgs.text).toContain("Texto");
  const logged = errorSpy.mock.calls.flat().join(" ");
  expect(logged).toContain("upload failed");
  expect(logged).not.toContain(TOKEN);
});

test("runPollJob skips media when includeMedia is false", async () => {
  harness.settingsValues.includeMedia = false;
  mockTelegram([channelPost(10, { caption: "Foto", photo: [{ file_id: "big" }] })]);

  await runPollJob();

  expect(harness.upload).not.toHaveBeenCalled();
  expect(harness.submitPost.mock.calls[0][0].text).toBeDefined();
});

test("runPollJob posts an album once, ignores other chats, and acknowledges them", async () => {
  mockTelegram([
    channelPost(10, { media_group_id: "g1", photo: [{ file_id: "a" }] }),
    channelPost(11, { media_group_id: "g1", caption: "Album", photo: [{ file_id: "b" }] }),
    { update_id: 12, channel_post: { message_id: 1, chat: { id: -100555, username: "otro" }, text: "x" } },
  ]);

  await runPollJob();

  expect(harness.submitPost).toHaveBeenCalledTimes(1);
  expect(harness.submitPost.mock.calls[0][0].title).toBe("Album");
  expect(harness.upload.mock.calls[0][0].url).toContain("/files/a.bin");
  expect(readState().offset).toBe(13);
});

test("runPollJob respects maxPostsPerRun and keeps the rest for the next run", async () => {
  harness.settingsValues.maxPostsPerRun = 1;
  mockTelegram([channelPost(10, { text: "Uno" }), channelPost(11, { text: "Dos" })]);

  await runPollJob();
  expect(harness.submitPost.mock.calls.map((call) => call[0].title)).toEqual(["Uno"]);
  expect(readState().offset).toBe(11);

  await runPollJob();
  expect(harness.submitPost.mock.calls.map((call) => call[0].title)).toEqual(["Uno", "Dos"]);
  expect(readState().offset).toBe(12);
});

test("runPollJob applies flair, title prefix and auto-approve when configured", async () => {
  Object.assign(harness.settingsValues, {
    flairId: "7d1a2750-51ca-11f1-b1fc-6234deaa7cba",
    titlePrefix: "[Evento]",
    autoApprove: true,
  });
  mockTelegram([channelPost(10, { text: "Feria" })]);

  await runPollJob();

  const submitArgs = harness.submitPost.mock.calls[0][0];
  expect(submitArgs.flairId).toBe("7d1a2750-51ca-11f1-b1fc-6234deaa7cba");
  expect(submitArgs.flairText).toBeUndefined();
  expect(submitArgs.title).toBe("[Evento] Feria");
  expect(harness.approve).toHaveBeenCalledTimes(1);
});

test("runPollJob omits flair and approval by default", async () => {
  mockTelegram([channelPost(10, { text: "Feria" })]);

  await runPollJob();

  expect(harness.submitPost.mock.calls[0][0].flairId).toBeUndefined();
  expect(harness.approve).not.toHaveBeenCalled();
});

test("runPollJob surfaces Telegram API errors without the token", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ ok: false, description: `Unauthorized for ${TOKEN}` }, { status: 401 })
  );

  const error = await runPollJob().catch((err) => err);

  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain("status 401");
  expect(error.message).not.toContain(TOKEN);
  expect(harness.submitPost).not.toHaveBeenCalled();
});

test("runPollJob skips when the token, channel or subreddit is missing", async () => {
  harness.settingsValues.telegramBotToken = "";
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  await runPollJob();

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(harness.submitPost).not.toHaveBeenCalled();
});

test("schedulePollingJob registers a recurring cron plus a warm-up run", async () => {
  await schedulePollingJob();

  expect(harness.runJob).toHaveBeenCalledTimes(2);
  const [cronJob, warmupJob] = harness.runJob.mock.calls.map((call) => call[0]);
  expect(cronJob).toEqual({ name: JOB_NAME, cron: "*/15 * * * *" });
  expect(warmupJob.name).toBe(JOB_NAME);
  expect(warmupJob.runAt).toBeInstanceOf(Date);
});

test("runPollJob logs the post link and schedules a verify check", async () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  mockTelegram([channelPost(10, { text: "Feria" })]);

  await runPollJob();

  const logged = logSpy.mock.calls.flat().join("\n");
  expect(logged).toContain("id=t3_test url=https://www.reddit.com/r/ParaguayActividades/comments/test/x/");
  const verifyJob = harness.runJob.mock.calls.map((call) => call[0]).find((job) => job.name === VERIFY_JOB_NAME);
  expect(verifyJob.data).toEqual({ postId: "t3_test" });
  expect(verifyJob.runAt.getTime()).toBeGreaterThan(Date.now());
});

/**
 * @param {Record<string, unknown>} fields
 */
function fakePost(fields) {
  return { permalink: "/r/ParaguayActividades/comments/test/x/", approve: harness.approve, ...fields };
}

test("verifyPost re-approves a post the spam filter removed when autoApprove is on", async () => {
  harness.settingsValues.autoApprove = true;
  harness.getPostById.mockResolvedValue(fakePost({ approved: false, removed: false, spam: true, removedByCategory: "reddit" }));
  vi.spyOn(console, "log").mockImplementation(() => {});

  await verifyPost("t3_test");

  expect(harness.getPostById).toHaveBeenCalledWith("t3_test");
  expect(harness.approve).toHaveBeenCalledTimes(1);
});

test("verifyPost only logs when autoApprove is off, the post is live, or it was deleted", async () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  harness.getPostById.mockResolvedValue(fakePost({ removed: true, spam: true, removedByCategory: "reddit" }));
  await verifyPost("t3_test");

  harness.settingsValues.autoApprove = true;
  harness.getPostById.mockResolvedValue(fakePost({ approved: true, removed: false, spam: false }));
  await verifyPost("t3_test");

  harness.getPostById.mockResolvedValue(fakePost({ removed: true, removedByCategory: "deleted" }));
  await verifyPost("t3_test");

  expect(harness.approve).not.toHaveBeenCalled();
  expect(logSpy.mock.calls.flat().join("\n")).toContain("removed=true spam=true removedByCategory=reddit");
});

test("serverOnRequest routes the verify-post task with its data", async () => {
  harness.getPostById.mockResolvedValue(fakePost({ approved: true, removed: false, spam: false }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { Readable } = await import("node:stream");
  const req = Object.assign(Readable.from([JSON.stringify({ name: VERIFY_JOB_NAME, data: { postId: "t3_abc" } })]), {
    url: "/internal/scheduler/verify-post",
  });
  const rsp = { writeHead: vi.fn(), end: vi.fn() };

  await serverOnRequest(req, rsp);

  expect(harness.getPostById).toHaveBeenCalledWith("t3_abc");
  expect(rsp.writeHead.mock.calls[0][0]).toBe(200);
});
