const express = require('express');
const request = require('supertest');
const app = require('../src/app');
const { notFound, ApiError } = require('../src/utils/errors');
const { acceptJson } = require('../src/middleware/accept-json');
const { unknownRoute, errorHandler } = require('../src/middleware/error-handler');
const { expectErrorBody } = require('./helpers/expect-error');

describe('406 Not Acceptable', () => {
  test.each(['text/html', 'application/xml', 'text/plain'])('Accept: %s gets 406 NOT_ACCEPTABLE', async (accept) => {
    const res = await request(app).get('/health').set('Accept', accept);
    expectErrorBody(res, 406, 'NOT_ACCEPTABLE');
  });

  test.each([
    ['no Accept header', undefined],
    ['application/json', 'application/json'],
    ['*/*', '*/*'],
    ['a browser-style list that includes */*', 'text/html,application/xhtml+xml,*/*;q=0.8'],
  ])('%s is accepted (not 406)', async (label, accept) => {
    const req = request(app).get('/no-such-route');
    const res = accept === undefined ? await req : await req.set('Accept', accept);
    expect(res.status).toBe(404); // got past the 406 check to the unknown-route 404
  });

  test('the docs page is exempt: it is HTML on purpose', async () => {
    const res = await request(app).get('/api-docs').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
  });
});

describe('unknown route', () => {
  test('returns 404 ROUTE_NOT_FOUND with the standard body', async () => {
    const res = await request(app).get('/no-such-route');
    expectErrorBody(res, 404, 'ROUTE_NOT_FOUND');
    expect(res.body.message).toContain('GET /no-such-route');
  });

  test('applies to every method, not just GET', async () => {
    const res = await request(app).delete('/no-such-route');
    expectErrorBody(res, 404, 'ROUTE_NOT_FOUND');
  });
});

describe('central error handler', () => {
  // A tiny app wired exactly like the real one, with routes that fail on purpose.
  const testApp = express();
  testApp.use(acceptJson);
  testApp.get('/missing', () => {
    throw notFound('PROVINCE_NOT_FOUND', 'No province with id PV-99.');
  });
  testApp.get('/bad', () => {
    throw new ApiError(400, 'VALIDATION_FAILED', 'One field is invalid.', [
      { field: 'power_kw', location: 'body', issue: 'Must be 0 or more.', reference: null },
    ]);
  });
  testApp.get('/async-missing', async () => {
    throw notFound('INSTALLATION_NOT_FOUND', 'No installation with id INS-9999.');
  });
  testApp.get('/crash', () => {
    throw new Error('secret internal detail: connection string mongodb+srv://user:pw@host');
  });
  testApp.use(unknownRoute);
  testApp.use(errorHandler);

  test('notFound() becomes a 404 with its own code and message', async () => {
    const res = await request(testApp).get('/missing');
    expectErrorBody(res, 404, 'PROVINCE_NOT_FOUND');
    expect(res.body.message).toBe('No province with id PV-99.');
    expect(res.body.details).toEqual([]);
  });

  test('an ApiError keeps its status and details', async () => {
    const res = await request(testApp).get('/bad');
    expectErrorBody(res, 400, 'VALIDATION_FAILED');
    expect(res.body.details).toEqual([{ field: 'power_kw', location: 'body', issue: 'Must be 0 or more.', reference: null }]);
  });

  test('errors thrown in async handlers reach the handler (Express 5)', async () => {
    const res = await request(testApp).get('/async-missing');
    expectErrorBody(res, 404, 'INSTALLATION_NOT_FOUND');
  });

  test('an unexpected error is a generic 500 that leaks nothing', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(testApp).get('/crash');
    expectErrorBody(res, 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/secret|mongodb|stack/i);
    expect(quiet).toHaveBeenCalled(); // logged on the server instead
    quiet.mockRestore();
  });
});
