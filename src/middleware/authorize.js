const { ApiError } = require('../utils/errors');
const { SCOPES } = require('../utils/tokens');

// Runs after authenticate (which sets req.auth): the caller is known, now check what it may do.
// 403, not 401: the token is valid, so signing in again would not help.

// The token must carry this scope. The challenge names the scope that was needed.
function requireScope(scope) {
  return (req, res, next) => {
    if (req.auth.scopes.includes(scope)) return next();
    return next(
      new ApiError(
        403,
        'INSUFFICIENT_SCOPE',
        'This token is not allowed to make this request.',
        [{ field: 'Authorization', location: 'header', issue: `Requires the ${scope} scope.`, reference: null }],
        { 'WWW-Authenticate': `Bearer realm="slsea-solar-api", error="insufficient_scope", scope="${scope}"` }
      )
    );
  };
}

// Every read (GET, and HEAD, which Express answers with the GET route) needs the analyst read
// scope: a meter's token can add readings, but never read anything, its own data included.
// Other methods pass on, to their write route or to a 405.
const requireReadScope = (() => {
  const check = requireScope(SCOPES.ANALYST_READ);
  return (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? check(req, res, next) : next());
})();

// A meter's token is bound to one installation (its sub). It may add readings only to that one.
// Compared with the path alone, before the database is touched, so a meter learns nothing about
// other installations, not even whether they exist.
function requireOwnInstallation(req, res, next) {
  const own = req.auth.subject;
  if (req.params.installationId === own) return next();
  return next(
    new ApiError(403, 'INSTALLATION_MISMATCH', `This token can only add readings for ${own}.`, [
      { field: 'installation-id', location: 'path', issue: `Must be ${own}, the installation this token belongs to.`, reference: `/installations/${own}` },
    ])
  );
}

module.exports = { requireScope, requireReadScope, requireOwnInstallation };
