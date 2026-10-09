const supertest = require('supertest');
const { signToken, SCOPES } = require('../../src/utils/tokens');

// Drop-in replacement for supertest in tests that exercise the API's behaviour rather than its
// security. Each request is sent by the client that is allowed to make it:
//   - POST /installations/{installation-id}/readings → that installation's meter
//     (installation-write, bound to the installation in the path);
//   - everything else → the registry admin (asset-admin + analyst read, national).
// Tokens are signed with the test run's random JWT_SECRET (tests/setup/global-setup.js), so they
// work only against this test app. Security itself is tested with explicit tokens in
// authentication.test.js and authorization.test.js.

function adminToken() {
  return signToken({
    subject: 'USR-007',
    claims: { scope: `${SCOPES.ASSET_ADMIN} ${SCOPES.ANALYST_READ}`, jurisdiction: { level: 'national', id: null } },
    lifetimeSeconds: 15 * 60,
  });
}

function deviceToken(installationId) {
  return signToken({ subject: installationId, claims: { scope: SCOPES.INSTALLATION_WRITE }, lifetimeSeconds: 24 * 60 * 60 });
}

const READING_POST = /^\/installations\/([^/?]+)\/readings\/?(\?|$)/;

function tokenFor(method, path) {
  const reading = method === 'post' && READING_POST.exec(path);
  return reading ? deviceToken(reading[1]) : adminToken();
}

// request(app).get(...), .post(...), request(app)[method](...) work exactly as with supertest.
// A test can still override the header with its own .set('Authorization', ...).
module.exports = (app) => {
  const client = supertest(app);
  const send = (method) => (path) => client[method](path).set('Authorization', `Bearer ${tokenFor(method, path)}`);
  return Object.fromEntries(['get', 'head', 'post', 'put', 'patch', 'delete', 'options'].map((m) => [m, send(m)]));
};
// Kept for authentication.test.js, which needs a valid token of its own.
module.exports.testToken = adminToken;
module.exports.adminToken = adminToken;
module.exports.deviceToken = deviceToken;
