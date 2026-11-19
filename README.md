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

## Notes
Reddit may rate-limit or block requests from some networks (e.g. cloud/VPN IPs); the error message will say so.
