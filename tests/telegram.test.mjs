import { test } from "vitest";
import assert from "node:assert/strict";
import {
  MAX_DOWNLOAD_BYTES,
  buildTelegramApiUrl,
  entitiesToMarkdown,
  groupChannelPosts,
  markSeen,
  matchesChannel,
  parseState,
  pickMedia,
  redactToken,
  renderTelegramPost,
} from "../src/core/telegram.mjs";
import { markdownToRichParagraphs } from "../src/core/richtext.mjs";

const CHAT = { id: -1001234567890, title: "Actividades Paraguay", username: "cheagana", type: "channel" };

/**
 * @param {number} updateId
 * @param {Record<string, unknown>} message
 */
function update(updateId, message) {
  return { update_id: updateId, channel_post: { message_id: updateId, chat: CHAT, ...message } };
}

test("buildTelegramApiUrl encodes params and skips undefined", () => {
  assert.equal(
    buildTelegramApiUrl("123:abc", "getUpdates", { offset: undefined, allowed_updates: '["channel_post"]', timeout: 0 }),
    "https://api.telegram.org/bot123:abc/getUpdates?allowed_updates=%5B%22channel_post%22%5D&timeout=0"
  );
});

test("redactToken hides every occurrence of the token", () => {
  assert.equal(redactToken("GET /bot123:abc/getFile and /file/bot123:abc/x", "123:abc"), "GET /bot<token>/getFile and /file/bot<token>/x");
});

test("matchesChannel accepts numeric ids and usernames", () => {
  assert.equal(matchesChannel(CHAT, "-1001234567890"), true);
  assert.equal(matchesChannel(CHAT, "@Cheagana"), true);
  assert.equal(matchesChannel(CHAT, "https://t.me/cheagana"), true);
  assert.equal(matchesChannel(CHAT, "-100999"), false);
  assert.equal(matchesChannel(CHAT, ""), false);
});

test("groupChannelPosts filters other chats and merges albums", () => {
  const other = { update_id: 2, channel_post: { message_id: 9, chat: { id: -100555, username: "otro" }, text: "x" } };
  const posts = groupChannelPosts(
    [
      update(1, { text: "Solo texto" }),
      other,
      update(3, { media_group_id: "g1", photo: [{ file_id: "p1", width: 90, height: 90 }] }),
      update(4, { media_group_id: "g1", caption: "Album", photo: [{ file_id: "p2", width: 90, height: 90 }] }),
      { update_id: 5 },
    ],
    "@cheagana"
  );

  assert.equal(posts.length, 2);
  assert.deepEqual(
    posts.map((post) => [post.key, post.firstUpdateId, post.lastUpdateId]),
    [
      ["m:-1001234567890:1", 1, 1],
      ["g:-1001234567890:g1", 3, 4],
    ]
  );
  assert.equal(posts[1].message.caption, "Album");
  assert.deepEqual(posts[1].media, { type: "image", fileId: "p1" });
});

test("pickMedia prefers video, picks the largest photo, and skips oversized files", () => {
  assert.deepEqual(pickMedia({ message_id: 1, chat: CHAT, video: { file_id: "v" } }), { type: "video", fileId: "v" });
  assert.deepEqual(pickMedia({ message_id: 1, chat: CHAT, animation: { file_id: "a" } }), { type: "video", fileId: "a" });
  assert.deepEqual(
    pickMedia({
      message_id: 1,
      chat: CHAT,
      photo: [
        { file_id: "small", width: 90, height: 90 },
        { file_id: "big", width: 1280, height: 720 },
      ],
    }),
    { type: "image", fileId: "big" }
  );
  assert.equal(pickMedia({ message_id: 1, chat: CHAT, video: { file_id: "v", file_size: MAX_DOWNLOAD_BYTES + 1 } }), null);
  assert.equal(pickMedia({ message_id: 1, chat: CHAT, text: "x" }), null);
});

test("entitiesToMarkdown converts text links and bare urls with UTF-16 offsets", () => {
  const text = "🗓️ Inscripción aquí\n📍https://maps.app.goo.gl/x";
  const entities = [
    // "🗓️" is 3 UTF-16 units and "📍" is 2, so these offsets are not code-point offsets.
    { type: "text_link", offset: 16, length: 4, url: "https://bit.ly/abc" },
    { type: "url", offset: 23, length: 25 },
    { type: "bold", offset: 0, length: 3 },
  ];
  assert.equal(
    entitiesToMarkdown(text, entities),
    "🗓️ Inscripción [aquí](https://bit.ly/abc)\n📍[https://maps.app.goo.gl/x](https://maps.app.goo.gl/x)"
  );
});

test("renderTelegramPost uses the first line as title and the rest as body, with no link back", () => {
  const rendered = renderTelegramPost(
    {
      message_id: 329,
      chat: CHAT,
      caption: "\nBirra y Politica\nEn este encuentro...\n\n🗓️ 30/10/26 9PM",
    },
    { titlePrefix: "[Evento]" }
  );
  assert.equal(rendered.title, "[Evento] Birra y Politica");
  assert.equal(rendered.bodyText, "En este encuentro...\n\n🗓️ 30/10/26 9PM");
});

test("renderTelegramPost falls back to the channel title and clips long titles", () => {
  assert.equal(renderTelegramPost({ message_id: 1, chat: CHAT, photo: [] }).title, "Actividades Paraguay");
  const long = renderTelegramPost({ message_id: 1, chat: CHAT, text: "x".repeat(400) }, { maxTitleChars: 10 });
  assert.equal(long.title, "xxxxxxxxx…");
});

test("parseState tolerates bad input and markSeen caps the history", () => {
  assert.deepEqual(parseState("not json"), { offset: 0, seen: [] });
  assert.deepEqual(parseState(JSON.stringify({ offset: 7, seen: ["a", 3] })), { offset: 7, seen: ["a"] });

  let state = parseState("");
  state = markSeen(state, "a", 2, 2);
  state = markSeen(state, "b", 3, 2);
  state = markSeen(state, "c", 4, 2);
  assert.deepEqual(state, { offset: 4, seen: ["c", "b"] });
});

test("markdownToRichParagraphs splits paragraphs, lines and links", () => {
  assert.deepEqual(markdownToRichParagraphs("Hola\nVer [mapa](https://maps.example.com/x) ya\n\n[https://a.example](https://a.example)"), [
    [[{ text: "Hola" }], [{ text: "Ver " }, { text: "mapa", url: "https://maps.example.com/x" }, { text: " ya" }]],
    [[{ text: "https://a.example", url: "https://a.example" }]],
  ]);
});
