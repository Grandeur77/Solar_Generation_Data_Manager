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

// The latest of several change times (Dates or undefined), or undefined if none is known.
// Used for the installation composite (installation change vs latest reading). Not used for
// collections: a removed member would not move the date (see conditional-get.js).
function newest(dates) {
  const times = dates.filter(Boolean).map((d) => new Date(d).getTime());
  return times.length > 0 ? new Date(Math.max(...times)) : undefined;
}

// RFC 9110 If-Match uses STRONG comparison: a weak W/"…" tag never matches, "*" matches any
// current representation, and a list matches if any entry equals the current ETag.
function ifMatchSatisfied(header, currentEtag) {
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .map((tag) => tag.trim())
    .some((tag) => !tag.startsWith('W/') && tag === currentEtag);
}

module.exports = { strongEtag, httpDate, newest, ifMatchSatisfied };
