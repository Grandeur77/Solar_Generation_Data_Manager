const crypto = require('crypto');

// Strong validator: a quoted SHA-1 of exactly the JSON that is sent, so any change to the
// representation gives a different ETag.
function strongEtag(body) {
  return `"${crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
}

// HTTP dates have one-second precision, e.g. "Tue, 06 Oct 2026 04:30:04 GMT".
function httpDate(date) {
  return new Date(date).toUTCString();
}

module.exports = { strongEtag, httpDate };
