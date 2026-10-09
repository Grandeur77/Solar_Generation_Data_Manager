const supertest = require('supertest');
const { signToken, SCOPES } = require('../../src/utils/tokens');

// Drop-in replacement for supertest in tests that exercise the API's behaviour rather than its
// security: every request carries a valid bearer token. Signed with the test run's random
// JWT_SECRET (tests/setup/global-setup.js), so it works only against this test app.
// The token is the registry admin's (both user scopes, national), so it can reach every user
// route. Security itself is tested with explicit tokens in the authentication tests.
function testToken() {
  return signToken({
    subject: 'USR-007',
    claims: { scope: `${SCOPES.ASSET_ADMIN} ${SCOPES.ANALYST_READ}`, jurisdiction: { level: 'national', id: null } },
    lifetimeSeconds: 15 * 60,
  });
}

// request(app).get(...) works exactly as with supertest; the agent adds the header to each request.
module.exports = (app) => supertest.agent(app).set('Authorization', `Bearer ${testToken()}`);
module.exports.testToken = testToken;
