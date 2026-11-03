# Telegram2Post

Telegram2Post reposts the posts of one Telegram channel to a subreddit: the text, the
links, and the photo or video.

It reads the channel through the official Telegram Bot API, and it remembers what it has
already posted, so nothing is posted twice.

## Setup (moderators)

1. In Telegram, create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy its token.
1. Add that bot to the channel as an **administrator**. It only needs to read posts.
1. Install the app on the subreddit and open its installation settings:
   - `telegramBotToken`: the token from BotFather. Use **one bot per installation**: Telegram delivers each update only once, so two installations sharing a bot would split the posts between them. Only this subreddit's moderators can see the token (Devvit has no secret per-subreddit settings).
   - `telegramChannel`: the channel's numeric id (`-100...`) or its public `@username`.
   - `targetSubreddit`: where to post (no `r/` prefix).
   - `pollMinutes`: how often to check for new posts (1–60, default `15`).
   - `maxPostsPerRun`: the most posts made in one check (default `1`). Any extra posts wait for the next check.
   - `titlePrefix`: optional text put before every title, such as `[Evento]`.
   - `includeMedia`: embed the post's photo or video (on by default). If the upload fails, the post goes out as text only.
   - `flairId`: post flair template ID (Mod Tools → Post flair → copy ID). Optional.
   - `flairText`: replaces the flair's text. Optional.
   - `autoApprove`: approve each post right after it is submitted.

## Posting behavior

- The **title** is the first non-empty line of the Telegram post. The **body** is the rest of the post, with its links. The app adds no link back to Telegram, because Reddit's spam filter removes posts with `t.me` links. For the same reason, avoid `t.me` or URL-shortener links in the channel posts themselves.
- **Albums** become one Reddit post that uses the first photo or video.
- Media larger than 20 MB (the Bot API download limit) is skipped, and that post goes out as text.
- The app only sees posts made **after** the bot joined the channel. Telegram keeps undelivered posts for 24 hours, so posts made while the app was stopped for more than a day are not delivered.
- The bot must not have a webhook set: `getUpdates` and webhooks cannot be used together.

## Fetch Domains

This app currently fetches from:

- `api.telegram.org`

It is used for the Telegram Bot API: `getUpdates` reads new posts from the configured channel, `getFile` and the file
download URL fetch each post's photo or video so it can be uploaded to Reddit. `api.telegram.org` is on Devvit's
global fetch allowlist.

This list is generated from the `permissions.http.domains` array in [`devvit.json`](./devvit.json) by `npm run sync:readme`. Do not edit it by hand; `npm test` fails if the two drift apart.

## Developer documentation

See [DEVELOPER.md](./DEVELOPER.md).

## Credits

Forked from [jghaines/devvit-rss-to-post-bot](https://github.com/jghaines/devvit-rss-to-post-bot) (an RSS → Reddit bot), and rewritten to read from Telegram.
