const { strongEtag, httpDate } = require('../utils/http-cache');

// RFC 9110: If-None-Match uses weak comparison (a W/ prefix is ignored) and "*" matches any
// current representation. It wins over If-Modified-Since, which is only used when it is absent.
// An unparseable If-Modified-Since date is ignored, as the standard requires.
function isNotModified(req, etag, lastModified) {
  const ifNoneMatch = req.get('If-None-Match');
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() === '*') return true;
    return ifNoneMatch.split(',').map((tag) => tag.trim().replace(/^W\//, '')).includes(etag);
  }
  const ifModifiedSince = req.get('If-Modified-Since');
  if (ifModifiedSince && lastModified) {
    const since = Date.parse(ifModifiedSince);
    // HTTP dates have one-second precision, so compare whole seconds.
    if (!Number.isNaN(since)) return Math.floor(lastModified.getTime() / 1000) * 1000 <= since;
  }
  return false;
}

// Conditional GET for every resource: a successful GET gets a strong ETag (a hash of the exact
// body), Last-Modified (set by the route in res.locals.lastModified), and caching headers. If the
// client already holds the current version, it gets 304 Not Modified with an empty body instead.
//
// Only single resources set Last-Modified. A collection or page has no single change time: when a
// member is removed (a DELETE, or a PUT that moves it out of a filter), no remaining member changed,
// so a date built from the members would not advance and If-Modified-Since would wrongly answer 304.
// Collections therefore rely on the ETag alone, which changes whenever the body does.
function conditionalGet(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  const sendJson = res.json.bind(res);
  res.json = (body) => {
    // Errors are not representations of a resource: no validators (the error handler marks them no-store).
    if (res.statusCode < 200 || res.statusCode >= 300) return sendJson(body);

    const etag = strongEtag(body);
    const { lastModified } = res.locals;
    res.set('ETag', etag);
    if (lastModified) res.set('Last-Modified', httpDate(lastModified));
    // Browsers may keep a copy but must revalidate (which is where 304 pays off); shared caches
    // must never serve one caller's jurisdiction-scoped data to another.
    res.set('Cache-Control', 'private, no-cache');
    res.set('Vary', 'Accept, Authorization');

    if (isNotModified(req, etag, lastModified)) {
      // 304 keeps the validators and caching headers but has no body and no Content-Type.
      res.removeHeader('Content-Type');
      return res.status(304).end();
    }
    return sendJson(body);
  };
  return next();
}

module.exports = { conditionalGet };
