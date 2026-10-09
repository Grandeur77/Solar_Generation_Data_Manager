const express = require('express');
const { summaryMethodNotAllowed } = require('../../middleware/summary-method-not-allowed');
const { listDistricts, getDistrict, ensureDistrictExists } = require('../../services/district-service');
const { districtGenerationSummary } = require('../../services/summary-service');
const { readIdParam, readSummaryDate, throwIfInvalid } = require('../../utils/query');

const router = express.Router();

// ?province-id= narrows the collection. A well-formed id that matches nothing gives 200 [].
router.get('/', async (req, res) => {
  const problems = [];
  const provinceId = readIdParam(req.query, 'province-id', /^PV-\d{2}$/, 'PV-01', problems);
  throwIfInvalid(problems);
  const districts = await listDistricts({ provinceId });
  res.json(districts);
});

router.get('/:districtId', async (req, res) => {
  const district = await getDistrict(req.params.districtId);
  res.locals.lastModified = district.updated_at;
  res.json(district);
});

// Processing resource: current total power, a day's energy, peak, capacity and counts across the
// district, worked out on request. A missing district is 404 before ?date= is checked. No Last-Modified, only the ETag:
// without ?date= the day changes at Sri Lanka midnight with no new reading, so no stored time
// would advance (the same reason collections send none).
router.get('/:districtId/generation-summary', async (req, res) => {
  const { districtId } = req.params;
  await ensureDistrictExists(districtId);
  res.json(await districtGenerationSummary(districtId, readSummaryDate(req.query)));
});

// Each method listed on its own (not .all), so OPTIONS keeps Express's default handling.
router
  .route('/:districtId/generation-summary')
  .post(summaryMethodNotAllowed)
  .put(summaryMethodNotAllowed)
  .patch(summaryMethodNotAllowed)
  .delete(summaryMethodNotAllowed);

module.exports = router;
