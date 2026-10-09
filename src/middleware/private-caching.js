// Every response under a guarded path depends on who is asking (the token's jurisdiction) and in
// what format (Accept). private: a browser may keep a copy, a shared cache (proxy, CDN) never, so one
// user's data is never served to another. no-cache: the copy must be revalidated (ETag → 304) before
// use. Vary tells any cache which request headers change the response. Errors override this with
// no-store (error handler). res.vary adds to an existing Vary (e.g. Origin from CORS), never replaces it.
function privateCaching(req, res, next) {
  res.set('Cache-Control', 'private, no-cache');
  res.vary('Accept');
  res.vary('Authorization');
  next();
}

module.exports = { privateCaching };
