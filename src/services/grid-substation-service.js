const GridSubstation = require('../models/grid-substation');
const District = require('../models/district');
const { notFound } = require('../utils/errors');

// Filters combine (AND). Substations store only their district, so a province filter
// first finds that province's districts.
async function listGridSubstations({ provinceId, districtId } = {}) {
  const filter = {};
  if (districtId) filter.district_id = districtId;

  if (provinceId) {
    const districtIds = await District.distinct('_id', { province_id: provinceId });
    // A district outside the requested province can't match both filters.
    if (districtId && !districtIds.includes(districtId)) return [];
    if (!districtId) filter.district_id = { $in: districtIds };
  }

  return GridSubstation.find(filter).sort({ _id: 1 });
}

async function getGridSubstation(substationId) {
  const substation = await GridSubstation.findById(substationId);
  if (!substation) throw notFound('SUBSTATION_NOT_FOUND', `No grid substation with id ${substationId}.`);
  return substation;
}

module.exports = { listGridSubstations, getGridSubstation };
