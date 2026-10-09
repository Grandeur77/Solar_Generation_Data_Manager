const express = require('express');
const { ApiError } = require('../utils/errors');
const { rejectOperatorKeysInBody } = require('./reject-operator-keys');

// Writes accept application/json only. Checked before parsing, so a form or plain-text body
// gets 415 instead of being silently ignored.
function requireJsonContentType(req, res, next) {
  if (!req.is('application/json')) {
    return next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The request body must be application/json.'));
  }
  return next();
}

// Parses the body. Malformed JSON (400) and bodies over 100 KB (413) are turned into the
// standard error body by the central error handler. strict: false lets valid JSON that isn't
// an object (42, null) through to the validator, which says precisely "must be a JSON object"
// instead of the misleading "not valid JSON".
const parseJson = express.json({ limit: '100kb', strict: false });

// After parsing, keys that could act as MongoDB operators are refused (reject-operator-keys.js).
module.exports = { jsonBody: [requireJsonContentType, parseJson, rejectOperatorKeysInBody] };
