const GridSubstation = require('../models/grid-substation');
const District = require('../models/district');
const { notFound } = require('../utils/errors');
const { substationFilter, checkFilter, checkMember, placeOf } = require('./jurisdiction-service');

// Filters combine (AND), and each must overlap the caller's jurisdiction (403 otherwise).
// Substations store only their district, so a province filter first finds that province's districts.
async function listGridSubstations({ provinceId, districtId } = {}, auth) {
  if (provinceId) await checkFilter(auth, 'province', provinceId, 'province-id');
  if (districtId) await checkFilter(auth, 'district', districtId, 'district-id');

  const conditions = [await substationFilter(auth)];
  if (districtId) conditions.push({ district_id: districtId });
  if (provinceId) conditions.push({ district_id: { $in: await District.distinct('_id', { province_id: provinceId }) } });
  return GridSubstation.find({ $and: conditions }).sort({ _id: 1 });
}

// 404 if it doesn't exist, then 403 if it is outside the caller's jurisdiction.
async function getGridSubstation(substationId, auth) {
  const substation = await GridSubstation.findById(substationId);
  if (!substation) throw notFound('SUBSTATION_NOT_FOUND', `No grid substation with id ${substationId}.`);
  checkMember(auth, await placeOf.district(substation.district_id), 'grid substation', 'substation-id');
  return substation;
}

module.exports = { listGridSubstations, getGridSubstation };
