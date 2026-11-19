#!/usr/bin/env node
'use strict';
const { downloadVideo } = require('./lib/reddit');

const args = process.argv.slice(2);
const outIdx = args.findIndex(a => a === '-o' || a === '--out');
let outDir = 'vid';
if (outIdx !== -1) outDir = args.splice(outIdx, 2)[1] || outDir;
if (!args.length) {
	console.error('Usage: node redditvid.js [-o outdir] <reddit post url> [more urls...]');
	process.exit(1);
}
(async () => {
	let failed = false;
	for (const url of args) {
		try {
			const r = await downloadVideo(url, outDir);
			console.log(`Saved ${r.file}${r.audio ? '' : ' (no audio)'}${r.note ? ' - ' + r.note : ''}`);
		} catch (e) {
			failed = true;
			console.error(`${url}: ${e.message}`);
		}
	}
	process.exit(failed ? 1 : 0);
})();
