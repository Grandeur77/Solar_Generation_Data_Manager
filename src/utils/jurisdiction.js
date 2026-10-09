const { ApiError } = require('./errors');

// A caller's jurisdiction comes from the token (req.auth.jurisdiction, set by authenticate):
// { level: 'national', id: null } | { level: 'province', id: 'PV-01' } | { level: 'district', id: 'DT-01' }.

// The jurisdiction as a MongoDB filter on the province_id / district_id copies that installations
// and readings carry. Merged into the query itself, so data outside the jurisdiction never leaves
// the database. Fails closed: no jurisdiction, or an unknown level, is a server error, never "all".
function jurisdictionFilter(auth) {
  const jurisdiction = auth && auth.jurisdiction;
  if (jurisdiction && jurisdiction.level === 'national') return {};
  if (jurisdiction && jurisdiction.level === 'province') return { province_id: jurisdiction.id };
  if (jurisdiction && jurisdiction.level === 'district') return { district_id: jurisdiction.id };
  throw new Error('A read query needs the caller\'s jurisdiction');
}

// Is this place (where a member sits) inside the jurisdiction? place = { province_id, district_id },
// with district_id null for a province itself. A district user is not "inside" a whole province.
function isWithin(auth, place) {
  const { level, id } = auth.jurisdiction;
  if (level === 'national') return true;
  if (level === 'province') return place.province_id === id;
  return place.district_id === id;
}

// 403 for a member (location 'path') or an explicit filter (location 'query') outside the jurisdiction.
function outsideJurisdiction(noun, field, location) {
  return new ApiError(403, 'OUTSIDE_JURISDICTION', `This ${noun} is outside your jurisdiction.`, [
    { field, location, issue: 'Outside your jurisdiction.', reference: null },
  ]);
}

module.exports = { jurisdictionFilter, isWithin, outsideJurisdiction };
