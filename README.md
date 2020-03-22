# RedditVidDownloader

Modules Used:
  fs, request, puppeteer
  
Puppeteer instance goes to reddit post, parses the URL for a the unique post identifier, uses that post identifier to locate the element on the page that contains the video source URL, and downloads the video using fs and request methods. 
