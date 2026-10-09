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
// A collection's Last-Modified is the newest change among the members it returns.
function newest(dates) {
  const times = dates.filter(Boolean).map((d) => new Date(d).getTime());
  return times.length > 0 ? new Date(Math.max(...times)) : undefined;
}

module.exports = { strongEtag, httpDate, newest };
