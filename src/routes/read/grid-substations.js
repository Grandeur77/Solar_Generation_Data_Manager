const express = require('express');
const { listGridSubstations, getGridSubstation } = require('../../services/grid-substation-service');
const { readIdParam, throwIfInvalid } = require('../../utils/query');

const router = express.Router();

// Filters combine (AND); every malformed filter is reported in one 400.
router.get('/', async (req, res) => {
  const problems = [];
  const provinceId = readIdParam(req.query, 'province-id', /^PV-\d{2}$/, 'PV-01', problems);
  const districtId = readIdParam(req.query, 'district-id', /^DT-\d{2}$/, 'DT-01', problems);
  throwIfInvalid(problems);
  const substations = await listGridSubstations({ provinceId, districtId });
  res.json(substations);
});

router.get('/:substationId', async (req, res) => {
  const substation = await getGridSubstation(req.params.substationId);
  res.locals.lastModified = substation.updated_at;
  res.json(substation);
});

module.exports = router;
