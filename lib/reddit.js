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

async function get(url, opts = {}) {
	return fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
}

/** Look up a post and return video metadata and direct media URLs. */
async function getVideoInfo(input) {
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
	if (!res) throw new Error('Could not reach Reddit');
	if (!res.ok) throw new Error(`Reddit returned HTTP ${res.status} (private/removed post, or request blocked)`);
	const post = (await res.json())[0].data.children[0].data;
	const src = (post.crosspost_parent_list && post.crosspost_parent_list[0]) || post;
	const rv = (src.secure_media && src.secure_media.reddit_video) ||
		(src.media && src.media.reddit_video) ||
		(src.preview && src.preview.reddit_video_preview);
	if (!rv || !rv.fallback_url) throw new Error('This post does not contain a Reddit-hosted video');
	const videoUrl = rv.fallback_url;
	const base = videoUrl.substring(0, videoUrl.lastIndexOf('/'));
	let audioUrl = null;
	if (!rv.is_gif) {
		for (const name of ['DASH_AUDIO_128.mp4', 'DASH_audio.mp4', 'DASH_AUDIO_64.mp4']) {
			const r = await get(`${base}/${name}`, { method: 'HEAD' }).catch(() => null);
			if (r && r.ok) { audioUrl = `${base}/${name}`; break; }
		}
	}
	return { id, title: post.title, subreddit: post.subreddit, width: rv.width, height: rv.height,
		duration: rv.duration, videoUrl, audioUrl };
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
