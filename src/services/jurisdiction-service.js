const District = require('../models/district');
const Province = require('../models/province');
const GridSubstation = require('../models/grid-substation');
const SolarInstallation = require('../models/solar-installation');
const { jurisdictionFilter, isWithin, outsideJurisdiction } = require('../utils/jurisdiction');

// Where an id sits in the hierarchy, or null if it doesn't exist.
const placeOf = {
  async province(id) {
    return (await Province.exists({ _id: id })) ? { province_id: id, district_id: null } : null;
  },
  async district(id) {
    const district = await District.findById(id).select('province_id');
    return district ? { province_id: district.province_id, district_id: id } : null;
  },
  async substation(id) {
    const substation = await GridSubstation.findById(id).select('district_id');
    return substation ? placeOf.district(substation.district_id) : null;
  },
  async installation(id) {
    const installation = await SolarInstallation.findById(id).select('province_id district_id');
    return installation ? { province_id: installation.province_id, district_id: installation.district_id } : null;
  },
};

// A filter is allowed when its area overlaps the caller's: a province user may filter by a
// district in their province, and a district user by their own district or their own province
// (which narrows to their district anyway). Anything else is 403, never an empty list, so an
// authorisation failure is not disguised as "nothing there". An id that doesn't exist can't be
// placed inside or outside, so it is allowed and simply matches nothing (200 []).
async function checkFilter(auth, kind, id, param) {
  const place = await placeOf[kind](id);
  if (!place) return;
  const { level, id: own } = auth.jurisdiction;
  let overlaps = level === 'national' || isWithin(auth, place);
  if (!overlaps && level === 'district' && place.district_id === null) {
    const ownDistrict = await District.findById(own).select('province_id');
    overlaps = Boolean(ownDistrict) && ownDistrict.province_id === place.province_id;
  }
  if (!overlaps) throw outsideJurisdiction(kind === 'substation' ? 'grid substation' : kind, param, 'query');
}

// A member (from the path) must be inside the jurisdiction. Call only after a 404 check.
function checkMember(auth, place, noun, param) {
  if (!isWithin(auth, place)) throw outsideJurisdiction(noun, param, 'path');
}

// The jurisdiction for collections that don't carry both ids.
function provinceFilter(auth) {
  const { level, id } = auth.jurisdiction;
  if (level === 'national') return {};
  if (level === 'province') return { _id: id };
  return { _id: { $in: [] } }; // a district user sees no whole province (data-model §5)
}

function districtFilter(auth) {
  const { level, id } = auth.jurisdiction;
  if (level === 'national') return {};
  if (level === 'province') return { province_id: id };
  return { _id: id };
}

// Substations store only their district, so a province user's are found through its districts.
async function substationFilter(auth) {
  const { level, id } = auth.jurisdiction;
  if (level === 'national') return {};
  if (level === 'district') return { district_id: id };
  return { district_id: { $in: await District.distinct('_id', { province_id: id }) } };
}

module.exports = { placeOf, checkFilter, checkMember, jurisdictionFilter, provinceFilter, districtFilter, substationFilter };
