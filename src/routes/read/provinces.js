const express = require('express');
const { summaryMethodNotAllowed } = require('../../middleware/summary-method-not-allowed');
const { listProvinces, getProvince, ensureProvinceExists } = require('../../services/province-service');
const { provinceGenerationSummary } = require('../../services/summary-service');
const { readSummaryDate } = require('../../utils/query');

const router = express.Router();

// An empty collection is 200 with [], never 404.
router.get('/', async (req, res) => {
  const provinces = await listProvinces();
  res.json(provinces);
});

router.get('/:provinceId', async (req, res) => {
  const province = await getProvince(req.params.provinceId);
  res.locals.lastModified = province.updated_at;
  res.json(province);
});

// The district summary one level up, from the same calculation (summary-service), so the two
// can never disagree. 404 before ?date= is checked; ETag only (see the district summary).
router.get('/:provinceId/generation-summary', async (req, res) => {
  const { provinceId } = req.params;
  await ensureProvinceExists(provinceId);
  res.json(await provinceGenerationSummary(provinceId, readSummaryDate(req.query)));
});

// Each method listed on its own (not .all), so OPTIONS keeps Express's default handling.
router
  .route('/:provinceId/generation-summary')
  .post(summaryMethodNotAllowed)
  .put(summaryMethodNotAllowed)
  .patch(summaryMethodNotAllowed)
  .delete(summaryMethodNotAllowed);

module.exports = router;
