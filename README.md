# RedditVidDownloader

Download Reddit-hosted videos (with sound) from the command line or a small local web UI.

No dependencies, requires Node 18+. For audio, [ffmpeg](https://ffmpeg.org) must be on your PATH
(without it, videos are saved silent).

## How it works
The post's JSON (`/comments/<id>.json`) is fetched to find the video's `fallback_url`; the matching
audio track is located next to it, and both are downloaded and merged with ffmpeg. Share links
(`/s/...`), `redd.it` links and crossposts are supported.

## Web UI
    npm start        # then open http://localhost:3000

## CLI
    node redditvid.js [-o outdir] <post url> [more urls...]

Files are saved to `vid/` by default.

## Fallbacks when Reddit blocks requests
If Reddit answers with 403 / a bot check, lookups fall back in this order:
1. **Redlib mirrors** (third-party Reddit front-ends). Set `REDDIT_MIRRORS` to a comma-separated list of instance URLs to override the built-in list. Public instances often sit behind their own bot checks, so this is best-effort.
2. **[yt-dlp](https://github.com/yt-dlp/yt-dlp)**, if it is installed and on your PATH (it also handles the download).
Reddit may rate-limit or block requests from some networks (e.g. cloud/VPN IPs); the error message will say so.
