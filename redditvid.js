const puppeteer = require('puppeteer');
(async () => {
	//Launch new browser
	const browser = await puppeteer.launch({
		headless: false
	});
	//Go to the link of the reddit page
	const page = await browser.newPage();
	//URL is in format: https://www.reddit.com/r/[subreddit]/comments/[unique post identifier]/[title]/...we'll parse the url for that unique post identifier
	let pageurl = 'https://www.reddit.com/r/IdiotsInCars/comments/fm7z3d/impatient_driver_goes_offroad_to_ovoid_goose/';
	let postid = parseURL(pageurl);
	console.log(postid);
	//Go to the reddit page
	await page.goto(pageurl);
	//Get the url from which we can derive the video from
	let vidurl = await page.evaluate((postid) => {
		let theurl = '';
		try {
			theurl = document.querySelectorAll('[id="t3_' + postid + '"]')[1].getElementsByTagName('source')[0].src;
		}
		catch(e) {
			//In case the filler pseudoelement doesn't load, happens sometimes
			theurl = document.querySelectorAll('[id="t3_' + postid + '"]')[0].getElementsByTagName('source')[0].src;
		}
		return theurl;
	}, postid);
	//This base of this url is correct, but not the .m3u8 file it's referencing. We need to change this
	console.log(vidurl);
	//Here's the new suffix we want on this url
	let urlsuffix = '/DASH_360?source=fallback';
	let lastslash = vidurl.lastIndexOf('/');
	vidurl = vidurl.substring(0, lastslash);
	vidurl += urlsuffix;
	//Now we have the final video url. Simply download it
	console.log(vidurl);
	let directory = 'vid/testvid1.mp4';
	download(vidurl, directory, function() {
		console.log('video downloaded');
	});
	await browser.close();
})();

//This is main download function which takes the url of your video
const fs = require("fs");
const request = require("request");
function download(uri, filename, callback) {
  request.head(uri, function(err, res, body) {
    request(uri)
    .pipe(fs.createWriteStream(filename))
    .on("close", callback);
 });
}

//This function parses the reddit url and returns the unique post identifier
function parseURL(url) {
	let commentsindex = url.indexOf('comments');
	url = url.substring(commentsindex);
	let nextslash = url.indexOf('/');
	url = url.substring(nextslash + 1);
	let id = url.substring(0, url.indexOf('/'));
	return id;
}
