# Developer guide

Devvit Web app that polls a Telegram channel through the Bot API and submits each new channel post to a subreddit.

## Project layout

- `src/server/index.js`: Devvit Web server entrypoint (`createServer` + listen)
- `src/server/handlers.mjs`: internal HTTP handlers. They cover the scheduler poll job (Telegram `getUpdates`, media upload, Reddit submit, Redis state) and the install/upgrade triggers.
- `src/core/telegram.mjs`: pure Telegram helpers: channel filtering, album grouping, media choice, text/entity → markdown, post rendering, dedupe state
- `src/core/richtext.mjs`: markdown → richtext paragraph segments, used when a post embeds media
- `src/core/schedule.mjs`: poll-interval cron + settings-normalization helpers
- `tools/build.mjs`: esbuild bundle of the server entry to `dist/server/index.cjs` (CommonJS, required by Devvit Web)
- `tests/*.test.mjs`: vitest suite. The `@devvit/*` packages and `fetch` are mocked, so no network is used.

All app configuration lives in `devvit.json`: server entry, triggers, the `poll-telegram` scheduler task, and the settings. The Devvit CLI runs `npm run build` before `playtest`/`upload`.

## Deployment account

The app `telegram2post` is owned by the Reddit account `dadnothere`. `npx devvit whoami` must print `Logged in as u/dadnothere` before playtest, upload, or publish.

## How polling works

1. Install and upgrade triggers cancel every existing `poll-telegram` job before scheduling the cron again. Without this, each upgrade added one more cron, and the parallel runs posted duplicates and made Telegram answer `409 Conflict`. Each run also takes a Redis lock (`tg:lock:<subreddit>`, 5 min TTL) and skips if another run holds it.
1. Every `pollMinutes`, the job calls `getUpdates` with `allowed_updates=["channel_post"]` and the stored `offset`.
1. Updates from other chats are ignored. Album items (same `media_group_id`) are merged into one post.
1. Up to `maxPostsPerRun` posts are submitted. After each one, Redis key `tg:state:<subreddit>` stores `{ offset, seen }`. `seen` holds the last 500 post keys, so a crash between submitting and saving cannot cause a duplicate.
1. The offset then moves past everything handled, which tells Telegram to drop those updates. Posts over the limit stay unacknowledged and are picked up by the next run.
1. Each submitted post is logged with its id and URL. If `autoApprove` is on, it is approved right away. A one-off `verify-post` task then runs 60 s later and logs the post's moderation state (`approved`, `removed`, `spam`, `removedByCategory`). If Reddit's spam filter removed the post after that first approval, the task approves it again.

Media is fetched with `getFile`. Its download URL contains the bot token, and that URL is passed to `media.upload`, which downloads the file on Reddit's side. The token is redacted from every error and log line.

## Bot token

`telegramBotToken` is a per-installation subreddit setting, so every subreddit brings its own Telegram bot. Devvit only
offers secret settings at the global app scope, and a global token would make every installation share one bot.
`getUpdates` delivers each update once, so installations sharing a bot would steal each other's posts. As a result the
token is visible to that subreddit's moderators. It must never be logged: wrap error text in `redactToken`.

## Commands

```bash
npm install
npm test               # vitest
npm run build          # bundle the server
npm run devvit:upload  # uploads a new version (NOT a dry run)
npx devvit logs <subreddit> telegram2post
```

`devvit upload` creates a private version that can be installed on subreddits you moderate. `devvit publish` / `npm run release:prod` create a production release, and `--public` asks for an App Directory listing, which Reddit reviews.

## Fetch domains

`devvit.json` `permissions.http.domains` is the source of truth. After changing it, run `npm run sync:readme`. `tests/devvit-config.test.mjs` fails if the README list drifts.

The Devvit fetch policy rejects personal domains. Telegram is reachable because `api.telegram.org` is on the global allowlist; it still has to be listed in `devvit.json`.
