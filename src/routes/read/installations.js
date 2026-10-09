const express = require('express');
const {
  listInstallations,
  getInstallationComposite,
  getLastKnownReading,
  listInstallationReadings,
  getInstallationReading,
} = require('../../services/installation-service');
const { readIdParam, readEnumParam, readNumberParam, throwIfInvalid } = require('../../utils/query');
const { readPagination, pageBody } = require('../../utils/pagination');
const { readTimeWindow, checkTimeWindowOrder, timestampCondition } = require('../../utils/time-window');
const { readSort, mongoSort } = require('../../utils/sort');
const { ApiError } = require('../../utils/errors');

const router = express.Router();

const INSTALLATION_SORT_FIELDS = ['installation_id', 'name', 'capacity_kw'];

// Paged like the readings: { count, next, previous, results }. Filters combine (AND); every
// malformed value is reported in one 400, then the sort is checked.
router.get('/', async (req, res) => {
  const problems = [];
  const provinceId = readIdParam(req.query, 'province-id', /^PV-\d{2}$/, 'PV-01', problems);
  const districtId = readIdParam(req.query, 'district-id', /^DT-\d{2}$/, 'DT-01', problems);
  const substationId = readIdParam(req.query, 'substation-id', /^SS-\d{3}$/, 'SS-001', problems);
  const status = readEnumParam(req.query, 'status', ['active', 'inactive'], problems);
  const { page, pageSize } = readPagination(req.query, problems);
  throwIfInvalid(problems);
  const sortValue = readSort(req.query, INSTALLATION_SORT_FIELDS, 'installation_id');

  const { results, count } = await listInstallations(
    { provinceId, districtId, substationId, status },
    // installation_id (stored as _id) is unique, so it breaks ties for equal names or capacities.
    { skip: (page - 1) * pageSize, limit: pageSize, sort: mongoSort(sortValue, '_id', 1, { installation_id: '_id' }) },
    req.auth
  );

  // Links keep every active filter and the sort, in a fixed order.
  const active = [];
  if (provinceId) active.push(['province-id', provinceId]);
  if (districtId) active.push(['district-id', districtId]);
  if (substationId) active.push(['substation-id', substationId]);
  if (status) active.push(['status', status]);
  active.push(['sort', sortValue]);

  res.json(pageBody({ path: '/installations', page, pageSize, count, results, active }));
});

// Composite: the installation plus its latest reading, so a dashboard needs one request.
router.get('/:installationId', async (req, res) => {
  const { body, lastModified } = await getInstallationComposite(req.params.installationId, req.auth);
  res.locals.lastModified = lastModified;
  res.json(body);
});

// Processing resource (a noun, not a verb): the latest reading only, for clients that
// need current output without the installation's details.
router.get('/:installationId/last-known-reading', async (req, res) => {
  const reading = await getLastKnownReading(req.params.installationId, req.auth);
  res.locals.lastModified = reading.received_at;
  res.json(reading);
});

const READING_SORT_FIELDS = ['timestamp', 'power_kw', 'energy_kwh'];

// Checked in this order: malformed values, all reported in one 400 (INVALID_QUERY_PARAMETER),
// then the sort field (INVALID_SORT_FIELD), then the window's order (INVALID_TIME_WINDOW).
function readReadingsQuery(query) {
  const problems = [];
  const { page, pageSize } = readPagination(query, problems);
  const window = readTimeWindow(query, problems);
  const minPowerKw = readNumberParam(query, 'min-power-kw', 0, problems);
  throwIfInvalid(problems);
  // Newest first by default: the usual question about a site's history is what it did recently.
  const sortValue = readSort(query, READING_SORT_FIELDS, '-timestamp');
  checkTimeWindowOrder(window);
  return {
    page,
    pageSize,
    window,
    sortValue,
    minPowerKw,
    timestamp: timestampCondition(window),
    // timestamp is unique per installation, so it is the tie-breaker for equal power or energy values.
    sort: mongoSort(sortValue, 'timestamp'),
  };
}

// Readings exist only under their installation; there is deliberately no top-level /readings.
// Paged: { count, next, previous, results }, optionally within ?from= / ?to=, sorted by ?sort=.
router.get('/:installationId/readings', async (req, res) => {
  const { installationId } = req.params;
  const { page, pageSize, window, minPowerKw, sortValue, results, count } = await listInstallationReadings(installationId, req.auth, () =>
    readReadingsQuery(req.query)
  );

  // Links keep the window (as canonical UTC instants), min-power-kw and the sort, in a fixed order,
  // so following them never changes what is being paged and each page has exactly one URL.
  const active = [];
  if (window.from) active.push(['from', window.from.toISOString()]);
  if (window.to) active.push(['to', window.to.toISOString()]);
  if (minPowerKw !== undefined) active.push(['min-power-kw', String(minPowerKw)]);
  active.push(['sort', sortValue]);

  res.json(pageBody({ path: `/installations/${installationId}/readings`, page, pageSize, count, results, active }));
});

// The member is what a 201 Location header will point to once readings can be created.
router.get('/:installationId/readings/:readingId', async (req, res) => {
  const reading = await getInstallationReading(req.params.installationId, req.params.readingId, req.auth);
  // A reading never changes after it is stored, so received_at is its last change.
  res.locals.lastModified = reading.received_at;
  res.json(reading);
});

module.exports = router;
