// TEMPORARY placeholder for device authentication. It marks where the real check goes: a
// device's bearer token must belong to the installation in the path (otherwise 401 or 403).
// Until that is built, every request passes, so the write path is open to anyone.
function deviceAuthPlaceholder(req, res, next) {
  next();
}

module.exports = { deviceAuthPlaceholder };
