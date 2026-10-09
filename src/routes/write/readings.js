const express = require('express');
const { createReading, ensureInstallationAcceptsReadings } = require('../../services/installation-service');
const { validateNewReading } = require('../../utils/validate-reading');
const { jsonBody } = require('../../middleware/json-body');
const { requireDatabase } = require('../../middleware/require-database');
const { requireScope, requireOwnInstallation } = require('../../middleware/authorize');
const { SCOPES } = require('../../utils/tokens');
const { strongEtag, httpDate } = require('../../utils/http-cache');
const { ApiError } = require('../../utils/errors');

const router = express.Router();

// Write path: a meter adds a reading for the installation named in the path.
// "A collection resource is a factory for its members": POST to the readings collection creates one.
// Only a meter's token (installation-write), and only for its own installation: checked first,
// without the database. Then the installation must still exist (404) and be active (403), and only
// then is the body read (415/400), in the design's order.
async function installationAcceptsReadings(req, res, next) {
  await ensureInstallationAcceptsReadings(req.params.installationId);
  next();
}

router.post(
  '/:installationId/readings',
  requireScope(SCOPES.INSTALLATION_WRITE),
  requireOwnInstallation,
  requireDatabase,
  installationAcceptsReadings,
  jsonBody,
  async (req, res) => {
  const { installationId } = req.params;
  const values = validateNewReading(req.body);
  const reading = await createReading(installationId, values);

  const body = reading.toJSON();
  res
    .status(201)
    // Where the new reading now lives; a GET on it returns 200 with this same body.
    .location(`/installations/${installationId}/readings/${body.reading_id}`)
    .set('ETag', strongEtag(body))
    .set('Last-Modified', httpDate(reading.received_at))
    .json(body);
  }
);

// Readings are append-only: they are never replaced, edited or deleted, one at a time or all
// at once. 405 says the method is wrong for this resource (not that the resource is missing),
// and Allow lists what is permitted. Answered before any database work.
function methodNotAllowed(allow) {
  return (req, res, next) => {
    res.set('Allow', allow);
    next(new ApiError(405, 'METHOD_NOT_ALLOWED', `Readings are append-only: ${req.method} is not allowed here. Allowed: ${allow}.`));
  };
}

router.route('/:installationId/readings').put(methodNotAllowed('GET, HEAD, POST')).patch(methodNotAllowed('GET, HEAD, POST')).delete(methodNotAllowed('GET, HEAD, POST'));
router.route('/:installationId/readings/:readingId').put(methodNotAllowed('GET, HEAD')).patch(methodNotAllowed('GET, HEAD')).delete(methodNotAllowed('GET, HEAD'));

module.exports = router;
