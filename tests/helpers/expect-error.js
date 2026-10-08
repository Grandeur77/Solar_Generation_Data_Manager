// Every client error must have exactly this shape (openapi.yaml: components/schemas/Error).
function expectErrorBody(res, status, code) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/json/);
  expect(Object.keys(res.body).sort()).toEqual(['code', 'details', 'message', 'more_info']);
  expect(res.body.code).toBe(code);
  expect(typeof res.body.message).toBe('string');
  expect(res.body.message.length).toBeGreaterThan(0);
  expect(Array.isArray(res.body.details)).toBe(true);
  expect(res.body.more_info).toBe('/api-docs#error-codes');
}

module.exports = { expectErrorBody };
