'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// Reddit blocks non-browser User-Agents with HTTP 403, so present a browser-like one.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Extract the post id from any common Reddit post URL. Returns null for share links (/s/). */
function parseURL(url) {
	const m = /\/comments\/([a-z0-9]+)/i.exec(url);
	return m ? m[1] : null;
}

function assertRedditUrl(input) {
	let u;
	try { u = new URL(input); } catch { throw new Error('Invalid URL'); }
	if (!/^(.+\.)?(reddit\.com|redd\.it)$/i.test(u.hostname) || !/^https?:$/.test(u.protocol)) {
		throw new Error('Not a Reddit URL');
	}
	return u;
}

const BLOCKED_MSG = 'Reddit blocked this request (bot check / HTTP 403), so the post could not be read. ' +
	'This is not a problem with the link; try again later or from a different network.';

/** Errors worth retrying through a mirror / yt-dlp (blocked, unreachable), as opposed to "this post has no video". */
function retryable(msg) {
	const e = new Error(msg);
	e.retryable = true;
	return e;
}

// Third-party Redlib front-ends used when Reddit itself blocks us. Override with REDDIT_MIRRORS (comma-separated).
// Public instances come and go and often sit behind bot checks, so treat this list as best-effort.
const MIRRORS = (process.env.REDDIT_MIRRORS ||
	'https://redlib.tiekoetter.com,https://redlib.nohost.network,https://safereddit.com,https://redlib.catsarch.com')
	.split(',').map(m => m.trim().replace(/\/+$/, '')).filter(Boolean);

async function get(url, opts = {}) {
	return fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
}

/**
 * Fallback when the .json endpoints are blocked: load the normal post page (what a browser does)
 * and pull the v.redd.it media URL out of the HTML, like "open video in new tab" does.
 */
async function getInfoFromPage(id) {
	const res = await get(`https://www.reddit.com/comments/${id}/`, {
		redirect: 'follow',
		headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
	}).catch(() => null);
	if (!res || !res.ok) return { status: res ? res.status : 0 };
	const html = (await res.text()).replace(/&amp;/g, '&').replace(/\\u002F/gi, '/').replace(/\\\//g, '/');
	// Reddit sometimes answers 200 with a bot-check page (a form with a "solution" field) instead of the post
	if (/namedItem\(["']solution["']\)|name=["']solution["']/.test(html)) return { status: 403, blocked: true };
	const m = /https?:\/\/v\.redd\.it\/([a-z0-9]+)/i.exec(html);
	if (!m) return { status: 200, noVideo: true };
	const base = `https://v.redd.it/${m[1]}`;
	const heights = [...html.matchAll(new RegExp(`v\\.redd\\.it/${m[1]}/DASH_(\\d+)\\.mp4`, 'gi'))].map(x => +x[1]);
	for (const h of [720, 480, 360, 240, 96]) if (!heights.includes(h)) heights.push(h);
	heights.sort((a, b) => b - a);
	let videoUrl = null, height = null;
	for (const h of heights) {
		const url = `${base}/DASH_${h}.mp4`;
		const r = await get(url, { method: 'HEAD' }).catch(() => null);
		if (r && r.ok) { videoUrl = url; height = h; break; }
	}
	if (!videoUrl) return { status: 200, noVideo: true };
	const t = /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i.exec(html) || /<title>([^<]*)<\/title>/i.exec(html);
	const sub = /\/r\/([A-Za-z0-9_]+)\//.exec(res.url);
	return { info: { id, title: t ? t[1] : id, subreddit: sub ? sub[1] : null, width: null, height,
		duration: null, videoUrl, audioUrl: null, base } };
}

/** Probe a media file: directly on v.redd.it first, then through the mirror's /vid proxy. Returns a working URL or null. */
async function reach(base, mirror, file) {
	const urls = [`${base}/${file}`];
	if (mirror) urls.push(`${mirror}/vid/${base.split('/').pop()}/${file.replace(/^DASH_/, '')}`);
	for (const url of urls) {
		let r = await get(url, { method: 'HEAD' }).catch(() => null);
		if (!(r && r.ok)) r = await get(url, { headers: { Range: 'bytes=0-0' } }).catch(() => null);
		if (r && r.ok) { if (r.body) r.body.cancel().catch(() => {}); return url; }
	}
	return null;
}

async function findAudio(base, mirror) {
	for (const name of ['DASH_AUDIO_128.mp4', 'DASH_audio.mp4', 'DASH_AUDIO_64.mp4']) {
		const url = await reach(base, mirror, name);
		if (url) return url;
	}
	return null;
}

/** Fallback: ask Redlib mirrors for the post page and read the v.redd.it id out of it. */
async function getInfoFromMirrors(id) {
	for (const mirror of MIRRORS) {
		const res = await get(`${mirror}/comments/${id}/`, {
			redirect: 'follow', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(15000),
		}).catch(() => null);
		if (!res || !res.ok) continue;
		const html = (await res.text()).replace(/&amp;/g, '&');
		if (/Just a moment|not a bot|Verifying your browser/i.test(html.slice(0, 4000))) continue; // mirror's own bot check
		const m = /\/(?:vid|hls)\/([a-z0-9]+)\//i.exec(html) || /v\.redd\.it\/([a-z0-9]+)/i.exec(html);
		if (!m) continue;
		const base = `https://v.redd.it/${m[1]}`;
		const heights = [...html.matchAll(new RegExp(`/vid/${m[1]}/(\\d+)\\.mp4`, 'gi'))].map(x => +x[1]);
		for (const h of [720, 480, 360, 240, 96]) if (!heights.includes(h)) heights.push(h);
		heights.sort((a, b) => b - a);
		let videoUrl = null, height = null;
		for (const h of heights) {
			videoUrl = await reach(base, mirror, `DASH_${h}.mp4`);
			if (videoUrl) { height = h; break; }
		}
		if (!videoUrl) continue;
		const t = /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i.exec(html) || /<title>([^<]*)<\/title>/i.exec(html);
		const title = t ? t[1].replace(/\s*[-:|]\s*(Redlib|r\/\w+).*$/i, '').trim() : id;
		const sub = /\/r\/([A-Za-z0-9_]+)\//.exec(html);
		return { id, title: title || id, subreddit: sub ? sub[1] : null, width: null, height, duration: null,
			videoUrl, audioUrl: await findAudio(base, mirror) };
	}
	return null;
}

/** Run yt-dlp; resolves null if it is not installed. */
function runYtDlp(args) {
	return new Promise(resolve => {
		const p = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '', err = '';
		p.stdout.on('data', d => { out += d; });
		p.stderr.on('data', d => { err += d; });
		p.on('error', () => resolve(null));
		p.on('close', code => resolve({ code, out, err }));
	});
}

/** Last-resort fallback: let yt-dlp resolve the post. Download is then also done by yt-dlp (see downloadVideo). */
async function getInfoFromYtDlp(url) {
	const r = await runYtDlp(['-J', '--no-playlist', url]);
	if (!r || r.code !== 0) return r ? { failed: true } : null;
	let j;
	try { j = JSON.parse(r.out); } catch { return { failed: true }; }
	return { id: j.id, title: j.title || j.id, subreddit: j.channel || null, width: j.width || null,
		height: j.height || null, duration: j.duration || null, videoUrl: j.webpage_url || url,
		audioUrl: 'merged by yt-dlp', ytdlp: true };
}

/** Look up a post: Reddit directly, then Redlib mirrors, then yt-dlp. */
async function getVideoInfo(input) {
	const u = assertRedditUrl(input);
	let err;
	try { return await getVideoInfoDirect(input); } catch (e) { if (!e.retryable) throw e; err = e; }
	const tried = [];
	const id = parseURL(u.href);
	if (id) {
		const info = await getInfoFromMirrors(id);
		if (info) return info;
		tried.push(`${MIRRORS.length} mirror(s)`);
	}
	const yt = await getInfoFromYtDlp(u.href);
	if (yt && yt.ytdlp) return yt;
	tried.push(yt ? 'yt-dlp (failed)' : 'yt-dlp (not installed)');
	err.message += ` Also tried: ${tried.join(', ')}.`;
	throw err;
}

/** Look up a post on reddit.com and return video metadata and direct media URLs. */
async function getVideoInfoDirect(input) {
	const u = assertRedditUrl(input);
	let id = parseURL(u.href);
	if (!id) {
		// share links (/r/x/s/abc) and redd.it short links: follow redirects to learn the post id
		const res = await get(u.href, { redirect: 'follow' });
		id = parseURL(res.url);
		if (!id) throw new Error('Could not determine post id from URL');
	}
	// Reddit frequently 403s one host/UA; try several endpoints before giving up
	let res = null;
	for (const host of ['www.reddit.com', 'old.reddit.com', 'api.reddit.com']) {
		const jsonUrl = host === 'api.reddit.com'
			? `https://api.reddit.com/comments/${id}?raw_json=1`
			: `https://${host}/comments/${id}.json?raw_json=1`;
		try {
			res = await get(jsonUrl, { headers: { Accept: 'application/json' } });
		} catch { res = null; continue; }
		if (res.ok) break;
	}
	let info;
	let isGif = false;
	if (res && res.ok) {
		const post = (await res.json())[0].data.children[0].data;
		const src = (post.crosspost_parent_list && post.crosspost_parent_list[0]) || post;
		const rv = (src.secure_media && src.secure_media.reddit_video) ||
			(src.media && src.media.reddit_video) ||
			(src.preview && src.preview.reddit_video_preview);
		if (rv && rv.fallback_url) {
			const videoUrl = rv.fallback_url;
			isGif = !!rv.is_gif;
			info = { id, title: post.title, subreddit: post.subreddit, width: rv.width, height: rv.height,
				duration: rv.duration, videoUrl, audioUrl: null, base: videoUrl.substring(0, videoUrl.lastIndexOf('/')) };
		} else {
			// The JSON may not expose reddit_video (crosspost chains, embeds, etc.); the post page often still has the media
			const page = await getInfoFromPage(id);
			if (page.blocked) throw retryable(BLOCKED_MSG);
			if (!page.info) throw new Error('This post does not contain a Reddit-hosted video');
			info = page.info;
			if (post.title) info.title = post.title;
			if (post.subreddit) info.subreddit = post.subreddit;
		}
	} else {
		// JSON API blocked (403): fall back to scraping the post page like a browser would
		const page = await getInfoFromPage(id);
		if (page.blocked) throw retryable(BLOCKED_MSG);
		if (page.noVideo) throw new Error('This post does not contain a Reddit-hosted video');
		if (!page.info) {
			const status = res ? res.status : page.status;
			if (!status) throw retryable('Could not reach Reddit');
			throw retryable(`Reddit returned HTTP ${status} (private/removed post, or request blocked)`);
		}
		info = page.info;
	}
	if (!isGif) {
		info.audioUrl = await findAudio(info.base, null);
	}
	delete info.base;
	return info;
}

async function downloadTo(url, file) {
	const res = await get(url);
	if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
	await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
}

function hasFfmpeg() {
	return new Promise(resolve => {
		const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
		p.on('error', () => resolve(false));
		p.on('close', code => resolve(code === 0));
	});
}

function mux(video, audio, out) {
	return new Promise((resolve, reject) => {
		const p = spawn('ffmpeg', ['-y', '-i', video, '-i', audio, '-c', 'copy', out], { stdio: 'ignore' });
		p.on('error', reject);
		p.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg failed')));
	});
}

function safeName(s) {
	return String(s).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'video';
}

/**
 * Download a post's video into outDir (merging audio with ffmpeg when available).
 * Returns { file, info, audio } where audio is true if the output contains sound.
 */
async function downloadVideo(input, outDir, info) {
	info = info || await getVideoInfo(input);
	fs.mkdirSync(outDir, { recursive: true });
	const name = `${safeName(info.title)}_${info.id}`;
	if (info.ytdlp) {
		const r = await runYtDlp(['--no-playlist', '--no-simulate', '--merge-output-format', 'mp4',
			'-o', path.join(outDir, `${name}.%(ext)s`), '--print', 'after_move:filepath', input]);
		if (!r || r.code !== 0) throw new Error(`yt-dlp failed: ${r ? r.err.trim().split('\n').pop() : 'not installed'}`);
		return { file: r.out.trim().split('\n').pop(), info, audio: true, note: 'downloaded with yt-dlp' };
	}
	const final = path.join(outDir, `${name}.mp4`);
	if (!info.audioUrl) {
		await downloadTo(info.videoUrl, final);
		return { file: final, info, audio: false };
	}
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redditvid-'));
	try {
		const v = path.join(tmp, 'v.mp4'), a = path.join(tmp, 'a.mp4');
		await Promise.all([downloadTo(info.videoUrl, v), downloadTo(info.audioUrl, a)]);
		if (await hasFfmpeg()) {
			await mux(v, a, final);
			return { file: final, info, audio: true };
		}
		fs.copyFileSync(v, final);
		return { file: final, info, audio: false, note: 'ffmpeg not found; saved without audio' };
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

module.exports = { parseURL, getVideoInfo, downloadVideo };
