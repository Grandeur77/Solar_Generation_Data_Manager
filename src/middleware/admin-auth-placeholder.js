// TEMPORARY placeholder for registry-admin authentication. It marks where the real check goes:
// a bearer token with the asset-admin scope (otherwise 401 or 403).
// Until that is built, every request passes, so the registry is open to anyone.
function adminAuthPlaceholder(req, res, next) {
  next();
}

module.exports = { adminAuthPlaceholder };
