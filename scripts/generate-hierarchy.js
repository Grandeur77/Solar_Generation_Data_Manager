// Generates seed/hierarchy.json: provinces, districts, grid substations and installations.
//   npm run generate-hierarchy
// Deterministic: a fixed random seed means every run writes the same file, so the committed
// seed can be regenerated and checked. Readings, users and device secrets are added by later steps.
const fs = require('fs');
const path = require('path');
const Province = require('../src/models/province');
const District = require('../src/models/district');
const GridSubstation = require('../src/models/grid-substation');
const SolarInstallation = require('../src/models/solar-installation');

// Small seeded random number generator (mulberry32): same seed, same sequence, every run.
function makeRandom(seed) {
  let a = seed;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = makeRandom(6007);
const between = (min, max) => min + random() * (max - min);
const pick = (list) => list[Math.floor(random() * list.length)];
const pad = (n, width) => String(n).padStart(width, '0');
const round = (n, places) => Number(n.toFixed(places));

// Sri Lanka's 9 provinces and 25 districts (real administrative geography).
// Each district lists real towns used as substation locations with approximate coordinates,
// and how many installations it gets (more in the populous west, at least 3 everywhere).
// Substation names are plausible, not a claim about the real CEB grid.
const GEOGRAPHY = [
  ['Western', [
    ['Colombo', 30, [['Kolonnawa', 6.93, 79.89], ['Dehiwala', 6.85, 79.87], ['Maharagama', 6.85, 79.93], ['Kotte', 6.89, 79.9]]],
    ['Gampaha', 22, [['Gampaha', 7.09, 80.0], ['Negombo', 7.21, 79.84], ['Kadawatha', 7.0, 79.95]]],
    ['Kalutara', 12, [['Kalutara', 6.58, 79.96], ['Panadura', 6.71, 79.9]]],
  ]],
  ['Central', [
    ['Kandy', 14, [['Kandy', 7.29, 80.63], ['Peradeniya', 7.27, 80.6]]],
    ['Matale', 6, [['Matale', 7.47, 80.62]]],
    ['Nuwara Eliya', 5, [['Nuwara Eliya', 6.97, 80.78]]],
  ]],
  ['Southern', [
    ['Galle', 12, [['Galle', 6.05, 80.22], ['Ambalangoda', 6.24, 80.05]]],
    ['Matara', 9, [['Matara', 5.95, 80.55], ['Weligama', 5.97, 80.43]]],
    ['Hambantota', 6, [['Hambantota', 6.12, 81.12]]],
  ]],
  ['Northern', [
    ['Jaffna', 9, [['Jaffna', 9.66, 80.02], ['Chavakachcheri', 9.66, 80.16]]],
    ['Kilinochchi', 4, [['Kilinochchi', 9.39, 80.4]]],
    ['Mannar', 4, [['Mannar', 8.98, 79.9]]],
    ['Vavuniya', 4, [['Vavuniya', 8.75, 80.5]]],
    ['Mullaitivu', 3, [['Mullaitivu', 9.27, 80.81]]],
  ]],
  ['Eastern', [
    ['Batticaloa', 7, [['Batticaloa', 7.71, 81.69], ['Kattankudy', 7.68, 81.73]]],
    ['Ampara', 6, [['Ampara', 7.3, 81.67]]],
    ['Trincomalee', 6, [['Trincomalee', 8.59, 81.21]]],
  ]],
  ['North Western', [
    ['Kurunegala', 13, [['Kurunegala', 7.49, 80.36], ['Kuliyapitiya', 7.47, 80.04]]],
    ['Puttalam', 6, [['Puttalam', 8.04, 79.83]]],
  ]],
  ['North Central', [
    ['Anuradhapura', 9, [['Anuradhapura', 8.31, 80.4], ['Kekirawa', 8.04, 80.6]]],
    ['Polonnaruwa', 5, [['Polonnaruwa', 7.94, 81.0]]],
  ]],
  ['Uva', [
    ['Badulla', 7, [['Badulla', 6.99, 81.06], ['Bandarawela', 6.83, 80.99]]],
    ['Monaragala', 4, [['Monaragala', 6.87, 81.35]]],
  ]],
  ['Sabaragamuwa', [
    ['Ratnapura', 9, [['Ratnapura', 6.68, 80.4], ['Balangoda', 6.65, 80.7]]],
    ['Kegalle', 8, [['Kegalle', 7.25, 80.35]]],
  ]],
];

const ROADS = ['Temple Road', 'Station Road', 'Main Street', 'Lake Road', 'School Lane', 'Hospital Road', 'Church Road', 'Park Avenue'];

// Most rooftops are homes; some are shops, schools or factories with larger arrays.
function capacityKw() {
  const r = random();
  if (r < 0.7) return round(between(2, 10) * 2, 0) / 2; // homes: 2–10 kW in 0.5 kW steps
  if (r < 0.95) return round(between(15, 50), 0); // small commercial
  return round(between(60, 150), 0); // large commercial
}

// Commissioned between 2018 and mid-2026, always before the seed's reading window.
function commissionedAt() {
  const start = Date.UTC(2018, 0, 1);
  const end = Date.UTC(2026, 5, 30);
  const day = new Date(start + random() * (end - start));
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())).toISOString();
}

const provinces = [];
const districts = [];
const substations = [];
const installations = [];
let districtNo = 0;
let substationNo = 0;
let installationNo = 0;

GEOGRAPHY.forEach(([provinceName, districtList], p) => {
  const province_id = `PV-${pad(p + 1, 2)}`;
  provinces.push({ province_id, name: provinceName });

  for (const [districtName, installationCount, towns] of districtList) {
    const district_id = `DT-${pad(++districtNo, 2)}`;
    districts.push({ district_id, name: districtName, province_id });

    const districtSubstations = towns.map(([town, lat, lng]) => {
      const substation = { substation_id: `SS-${pad(++substationNo, 3)}`, name: `${town} Grid Substation`, district_id };
      substations.push(substation);
      return { ...substation, town, lat, lng };
    });

    // Spread the district's installations evenly across its substations.
    for (let i = 0; i < installationCount; i++) {
      const s = districtSubstations[i % districtSubstations.length];
      const n = ++installationNo;
      installations.push({
        installation_id: `INS-${pad(n, 4)}`,
        name: `${s.town} rooftop ${Math.floor(i / districtSubstations.length) + 1}`,
        meter_id: `MTR-${pad(n, 6)}`,
        substation_id: s.substation_id,
        // Copied from the substation, exactly as the API will do when an installation is created.
        district_id,
        province_id,
        capacity_kw: capacityKw(),
        // A few decommissioned sites so the status filter returns something.
        status: random() < 0.03 ? 'inactive' : 'active',
        commissioned_at: commissionedAt(),
        address: `No. ${Math.floor(between(1, 400))}, ${pick(ROADS)}, ${s.town}`,
        // Within about 3 km of the substation town.
        latitude: round(s.lat + between(-0.03, 0.03), 4),
        longitude: round(s.lng + between(-0.03, 0.03), 4),
      });
    }
  }
});

// Check every record against the models and every parent link before writing anything.
async function check() {
  const problems = [];
  const asDoc = (record, idField) => {
    const { [idField]: _id, ...rest } = record;
    return { _id, ...rest };
  };
  // validate() only checks the document against its schema; nothing is saved and no database is needed.
  const validate = async (Model, records, idField) => {
    for (const record of records) {
      try {
        await new Model(asDoc(record, idField)).validate();
      } catch (error) {
        problems.push(`${record[idField]}: ${error.message}`);
      }
    }
  };
  await validate(Province, provinces, 'province_id');
  await validate(District, districts, 'district_id');
  await validate(GridSubstation, substations, 'substation_id');
  await validate(SolarInstallation, installations, 'installation_id');

  const ids = (list, field) => new Set(list.map((r) => r[field]));
  const provinceIds = ids(provinces, 'province_id');
  const districtById = new Map(districts.map((d) => [d.district_id, d]));
  const substationById = new Map(substations.map((s) => [s.substation_id, s]));

  for (const d of districts) if (!provinceIds.has(d.province_id)) problems.push(`${d.district_id}: unknown province ${d.province_id}`);
  for (const s of substations) if (!districtById.has(s.district_id)) problems.push(`${s.substation_id}: unknown district ${s.district_id}`);
  for (const i of installations) {
    const s = substationById.get(i.substation_id);
    if (!s) problems.push(`${i.installation_id}: unknown substation ${i.substation_id}`);
    else if (s.district_id !== i.district_id) problems.push(`${i.installation_id}: district copy does not match its substation`);
    else if (districtById.get(s.district_id).province_id !== i.province_id) problems.push(`${i.installation_id}: province copy does not match`);
  }
  for (const d of districts) {
    if (!substations.some((s) => s.district_id === d.district_id)) problems.push(`${d.district_id}: no substation`);
    if (!installations.some((i) => i.district_id === d.district_id)) problems.push(`${d.district_id}: no installation`);
  }
  if (new Set(installations.map((i) => i.meter_id)).size !== installations.length) problems.push('duplicate meter_id');
  if (provinces.length !== 9) problems.push(`expected 9 provinces, got ${provinces.length}`);
  if (districts.length !== 25) problems.push(`expected 25 districts, got ${districts.length}`);
  if (substations.length < 20) problems.push(`expected at least 20 substations, got ${substations.length}`);
  if (installations.length < 200) problems.push(`expected at least 200 installations, got ${installations.length}`);
  return problems;
}

async function main() {
  const problems = await check();
  if (problems.length > 0) {
    console.error(`Not written: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }

  const outFile = path.join(__dirname, '..', 'seed', 'hierarchy.json');
  fs.writeFileSync(outFile, `${JSON.stringify({ provinces, districts, substations, installations }, null, 2)}\n`);

  const caps = installations.map((i) => i.capacity_kw);
  console.log(`Wrote ${path.relative(process.cwd(), outFile)}`);
  console.log(`  provinces      ${provinces.length}`);
  console.log(`  districts      ${districts.length}`);
  console.log(`  substations    ${substations.length}`);
  console.log(`  installations  ${installations.length} (${installations.filter((i) => i.status === 'inactive').length} inactive)`);
  console.log(`  capacity_kw    ${Math.min(...caps)} to ${Math.max(...caps)} kW`);
}

main();
