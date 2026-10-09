const express = require('express');
const {
  listInstallations,
  getInstallationComposite,
  getLastKnownReading,
  listInstallationReadings,
  getInstallationReading,
} = require('../../services/installation-service');
const { optionalIdParam } = require('../../utils/query');
const { readPagination, pageBody } = require('../../utils/pagination');
const { readTimeWindow, checkTimeWindowOrder, timestampCondition } = require('../../utils/time-window');
const { ApiError } = require('../../utils/errors');

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

// Every malformed query value is reported in one 400 (INVALID_QUERY_PARAMETER); only when all are
// well-formed is the window's order checked (INVALID_TIME_WINDOW).
function readReadingsQuery(query) {
  const problems = [];
  const { page, pageSize } = readPagination(query, problems);
  const window = readTimeWindow(query, problems);
  if (problems.length > 0) {
    throw new ApiError(400, 'INVALID_QUERY_PARAMETER', 'One or more query parameters are invalid.', problems);
  }
  checkTimeWindowOrder(window);
  return { page, pageSize, window, timestamp: timestampCondition(window) };
}

// Readings exist only under their installation; there is deliberately no top-level /readings.
// Paged, newest first: { count, next, previous, results }, optionally within ?from= / ?to=.
router.get('/:installationId/readings', async (req, res) => {
  const { installationId } = req.params;
  let window;
  const { page, pageSize, results, count } = await listInstallationReadings(installationId, () => {
    const parsed = readReadingsQuery(req.query);
    window = parsed.window;
    return parsed;
  });

  // Links keep the window (as canonical UTC instants) and the sort, in a fixed order.
  // Sort is fixed newest-first for now; it is still in every link so each page has one URL.
  const active = [];
  if (window.from) active.push(['from', window.from.toISOString()]);
  if (window.to) active.push(['to', window.to.toISOString()]);
  active.push(['sort', '-timestamp']);

  res.json(pageBody({ path: `/installations/${installationId}/readings`, page, pageSize, count, results, active }));
});

// The member is what a 201 Location header will point to once readings can be created.
router.get('/:installationId/readings/:readingId', async (req, res) => {
  res.json(await getInstallationReading(req.params.installationId, req.params.readingId));
});

module.exports = router;
