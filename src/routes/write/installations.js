const express = require('express');
const { registerInstallation } = require('../../services/installation-service');
const { validateInstallationBody } = require('../../utils/validate-installation');
const { jsonBody } = require('../../middleware/json-body');
const { requireDatabase } = require('../../middleware/require-database');
const { adminAuthPlaceholder } = require('../../middleware/admin-auth-placeholder');
const { strongEtag, httpDate } = require('../../utils/http-cache');

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

module.exports = router;
