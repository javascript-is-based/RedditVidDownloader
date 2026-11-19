# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — local web UI at http://localhost:3000 (`PORT` env var overrides; binds to 127.0.0.1 only)
- `node redditvid.js [-o outdir] <post url> [more urls...]` — CLI; saves to `vid/` by default
- `npm test` — runs `test.js`, a plain `assert` script (no framework, so no single-test runner; it only covers `parseURL`)

Zero dependencies, Node 18+ (relies on global `fetch`). `ffmpeg` on PATH is optional: without it, videos are saved silent.

## Architecture

All Reddit logic lives in `lib/reddit.js`. The CLI (`redditvid.js`) and the HTTP server (`server.js`, serving `public/index.html` plus `/api/info` and `/api/download`) are thin wrappers around its `getVideoInfo` and `downloadVideo`.

`getVideoInfo` resolves a post in layers, because Reddit often 403s a given host or User-Agent:
1. Share links (`/s/`) and `redd.it` URLs are followed by redirect to find the post id (`parseURL` returns null for them).
2. The post JSON is tried on `www.reddit.com`, `old.reddit.com`, then `api.reddit.com`.
3. If every JSON endpoint fails, or the JSON has no `reddit_video` (crossposts, embeds), it falls back to scraping the post HTML for a `v.redd.it` URL and probing `DASH_<height>.mp4` with HEAD requests (`getInfoFromPage`). Reddit may answer 200 with a bot-check page; that is detected and raised as a *retryable* error (`retryable()`), not "no video".
4. Retryable errors (blocked/unreachable) trigger `getInfoFromMirrors` (Redlib instances from `MIRRORS`, overridable via `REDDIT_MIRRORS`; media is probed on `v.redd.it` first, then via the mirror's `/vid/` proxy), then `getInfoFromYtDlp`. A yt-dlp result carries `ytdlp: true`, and `downloadVideo` then lets yt-dlp do the download. Non-retryable errors ("no video") are never retried.
5. The audio track is found by HEAD-probing `DASH_AUDIO_128/DASH_audio/DASH_AUDIO_64.mp4` next to the video URL. GIFs have none.

`downloadVideo` downloads video and audio to a temp dir and muxes them with `ffmpeg -c copy`. If ffmpeg is missing it saves video only and returns a `note`. All requests must send the browser-like `UA` string in `lib/reddit.js`, or Reddit rejects them.

## CI

`.github/workflows/claude.yml` runs `anthropics/claude-code-action` on `@claude` mentions. The `issues` and `issue_comment` triggers run the workflow file from the **default branch** (`main`). It authenticates with the `CLAUDE_CODE_OAUTH_TOKEN` repo secret.
