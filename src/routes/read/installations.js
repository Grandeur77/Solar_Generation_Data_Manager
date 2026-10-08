const express = require('express');
const { listInstallations, getInstallation } = require('../../services/installation-service');
const { optionalIdParam } = require('../../utils/query');

const router = express.Router();

// Flat array for now; status filter, sorting and pagination come later.
router.get('/', async (req, res) => {
  const provinceId = optionalIdParam(req.query, 'province-id', /^PV-\d{2}$/, 'PV-01');
  const districtId = optionalIdParam(req.query, 'district-id', /^DT-\d{2}$/, 'DT-01');
  const substationId = optionalIdParam(req.query, 'substation-id', /^SS-\d{3}$/, 'SS-001');
  res.json(await listInstallations({ provinceId, districtId, substationId }));
});

// Plain installation for now; upgraded to the composite with last_reading next.
router.get('/:installationId', async (req, res) => {
  res.json(await getInstallation(req.params.installationId));
});

module.exports = router;
