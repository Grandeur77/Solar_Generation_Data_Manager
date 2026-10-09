const express = require('express');
const {
  registerInstallation,
  replaceInstallation,
  deleteInstallation,
  getInstallationComposite,
} = require('../../services/installation-service');
const { validateInstallationBody, validateReplacementBody } = require('../../utils/validate-installation');
const { jsonBody } = require('../../middleware/json-body');
const { requireDatabase } = require('../../middleware/require-database');
const { adminAuthPlaceholder } = require('../../middleware/admin-auth-placeholder');
const { strongEtag, httpDate, ifMatchSatisfied } = require('../../utils/http-cache');
const { ApiError } = require('../../utils/errors');

const router = express.Router();

// Registry: the admin registers a new installation. The collection is the factory for its members.
router.post('/', jsonBody, requireDatabase, adminAuthPlaceholder, async (req, res) => {
  const fields = validateInstallationBody(req.body, { requireInstallationId: true });
  const installation = await registerInstallation(fields);

  // The same composite shape GET returns; a new installation has no reading yet.
  const body = { ...installation.toJSON(), last_reading: null };
  res
    .status(201)
    .location(`/installations/${body.installation_id}`)
    .set('ETag', strongEtag(body))
    .set('Last-Modified', httpDate(installation.updated_at))
    .json(body);
});

// Runs before the body is read, in the design's order. 1) A missing installation is 404 (PUT never
// creates). 2) If-Match (optional): the ETag the admin last saw must still be the current one, or
// 412 and nothing changes. That stops one admin silently overwriting another admin's change.
// The ETag compared is the composite's, the same one GET, POST and PUT return for this URI.
async function installationMustMatch(req, res, next) {
  const { body } = await getInstallationComposite(req.params.installationId);
  const ifMatch = req.get('If-Match');
  if (ifMatch !== undefined && !ifMatchSatisfied(ifMatch, strongEtag(body))) {
    throw new ApiError(412, 'PRECONDITION_FAILED', 'The installation has changed since you last read it. Fetch it again, then retry.', [
      { field: 'If-Match', location: 'header', issue: 'Does not match the current ETag of this installation.', reference: null },
    ]);
  }
  next();
}

// Registry: replace the whole installation. Every writable field must be sent; nothing is merged.
router.put(
  '/:installationId',
  requireDatabase,
  adminAuthPlaceholder,
  installationMustMatch,
  jsonBody,
  async (req, res) => {
    const { installationId } = req.params;
    const fields = validateReplacementBody(req.body, installationId);
    const { installation, body } = await replaceInstallation(installationId, fields);
    res.set('ETag', strongEtag(body)).set('Last-Modified', httpDate(installation.updated_at)).json(body);
  }
);

// Registry: remove an installation. 200 with what was removed; a second DELETE finds nothing (404).
// Its readings stay in the database as history.
router.delete('/:installationId', requireDatabase, adminAuthPlaceholder, installationMustMatch, async (req, res) => {
  res.json(await deleteInstallation(req.params.installationId));
});

// Partial updates are not offered: PUT replaces the whole installation, so PATCH is refused.
router.patch('/:installationId', (req, res, next) => {
  res.set('Allow', 'GET, HEAD, PUT, DELETE');
  next(new ApiError(405, 'METHOD_NOT_ALLOWED', 'Partial updates are not supported: use PUT with the whole installation. Allowed: GET, HEAD, PUT, DELETE.'));
});

module.exports = router;
