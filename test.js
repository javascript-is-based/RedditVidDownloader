const assert = require('assert');
const { parseURL } = require('./lib/reddit');
assert.strictEqual(parseURL('https://www.reddit.com/r/IdiotsInCars/comments/fm7z3d/impatient_driver/'), 'fm7z3d');
assert.strictEqual(parseURL('https://reddit.com/comments/abc123'), 'abc123');
assert.strictEqual(parseURL('https://www.reddit.com/r/x/s/AbCdEf'), null);
console.log('ok');
