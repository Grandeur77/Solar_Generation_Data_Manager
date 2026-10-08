const express = require('express');
const {
  listInstallations,
  getInstallationComposite,
  getLastKnownReading,
  listInstallationReadings,
  getInstallationReading,
} = require('../../services/installation-service');
const { optionalIdParam } = require('../../utils/query');

const router = express.Router();

// Flat array for now; status filter, sorting and pagination come later.
router.get('/', async (req, res) => {
  const provinceId = optionalIdParam(req.query, 'province-id', /^PV-\d{2}$/, 'PV-01');
  const districtId = optionalIdParam(req.query, 'district-id', /^DT-\d{2}$/, 'DT-01');
  const substationId = optionalIdParam(req.query, 'substation-id', /^SS-\d{3}$/, 'SS-001');
  res.json(await listInstallations({ provinceId, districtId, substationId }));
});

// Composite: the installation plus its latest reading, so a dashboard needs one request.
router.get('/:installationId', async (req, res) => {
  res.json(await getInstallationComposite(req.params.installationId));
});

// Processing resource (a noun, not a verb): the latest reading only, for clients that
// need current output without the installation's details.
router.get('/:installationId/last-known-reading', async (req, res) => {
  res.json(await getLastKnownReading(req.params.installationId));
});

// Readings exist only under their installation; there is deliberately no top-level /readings.
// Newest first. Pagination, time window and sort options come later.
router.get('/:installationId/readings', async (req, res) => {
  res.json(await listInstallationReadings(req.params.installationId));
});

// The member is what a 201 Location header will point to once readings can be created.
router.get('/:installationId/readings/:readingId', async (req, res) => {
  res.json(await getInstallationReading(req.params.installationId, req.params.readingId));
});

module.exports = router;
