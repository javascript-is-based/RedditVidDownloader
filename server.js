'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getVideoInfo, downloadVideo } = require('./lib/reddit');

const PORT = process.env.PORT || 3000;

function json(res, code, obj) {
	res.writeHead(code, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
	const u = new URL(req.url, 'http://localhost');
	try {
		if (u.pathname === '/') {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
		}
		if (u.pathname === '/api/info') {
			return json(res, 200, await getVideoInfo(u.searchParams.get('url') || ''));
		}
		if (u.pathname === '/api/download') {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redditvid-srv-'));
			try {
				const { file } = await downloadVideo(u.searchParams.get('url') || '', dir);
				res.writeHead(200, {
					'Content-Type': 'video/mp4',
					'Content-Length': fs.statSync(file).size,
					'Content-Disposition': `attachment; filename="${path.basename(file)}"`
				});
				const s = fs.createReadStream(file).pipe(res);
				s.on('close', () => fs.rmSync(dir, { recursive: true, force: true }));
				return;
			} catch (e) {
				fs.rmSync(dir, { recursive: true, force: true });
				throw e;
			}
		}
		json(res, 404, { error: 'Not found' });
	} catch (e) {
		if (!res.headersSent) json(res, 400, { error: e.message });
		else res.end();
	}
}).listen(PORT, '127.0.0.1', () => console.log(`RedditVidDownloader running at http://localhost:${PORT}`));
