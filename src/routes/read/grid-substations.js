const express = require('express');
const { listGridSubstations, getGridSubstation } = require('../../services/grid-substation-service');
const { optionalIdParam } = require('../../utils/query');

const router = express.Router();

router.get('/', async (req, res) => {
  const provinceId = optionalIdParam(req.query, 'province-id', /^PV-\d{2}$/, 'PV-01');
  const districtId = optionalIdParam(req.query, 'district-id', /^DT-\d{2}$/, 'DT-01');
  res.json(await listGridSubstations({ provinceId, districtId }));
});

router.get('/:substationId', async (req, res) => {
  res.json(await getGridSubstation(req.params.substationId));
});

module.exports = router;
