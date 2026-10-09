// Physical plausibility rules for a new reading. Structural checks (types, required fields)
// happen first in validate-reading.js; these need the installation and its neighbouring readings.

// Panels can briefly exceed their nameplate rating in strong, cool sunlight, but not by much.
const CAPACITY_TOLERANCE = 1.1;
// Device clocks drift; a reading from further in the future than this is impossible.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
// 230 V low-voltage grid, ± about 20%: real swings pass, a broken sensor or wrong unit does not.
const MIN_VOLTAGE = 180;
const MAX_VOLTAGE = 270;

const readingUri = (reading) => `/installations/${reading.installation_id}/readings/${reading._id}`;
const detail = (field, issue, reference = null) => ({ field, location: 'body', issue, reference });

// Returns one details entry per broken rule (an empty array means plausible).
// previous / next are the installation's readings just before and just after this timestamp.
function plausibilityProblems(installation, reading, { previous, next, now }) {
  const problems = [];

  const maxPower = Number((installation.capacity_kw * CAPACITY_TOLERANCE).toFixed(3));
  if (reading.power_kw > maxPower) {
    problems.push(
      detail(
        'power_kw',
        `${reading.power_kw} kW is more than this installation can produce: at most ${maxPower} kW (capacity ${installation.capacity_kw} kW × ${CAPACITY_TOLERANCE}).`,
        `/installations/${installation._id}`
      )
    );
  }

  // energy_kwh is a cumulative meter total, so it can never go down over time. Compared with
  // the neighbours by timestamp (not by arrival), because readings can arrive late.
  if (previous && reading.energy_kwh < previous.energy_kwh) {
    problems.push(
      detail(
        'energy_kwh',
        `${reading.energy_kwh} kWh is lower than the previous reading (${previous.energy_kwh} kWh at ${previous.timestamp.toISOString()}); the meter total never decreases.`,
        readingUri(previous)
      )
    );
  }
  if (next && reading.energy_kwh > next.energy_kwh) {
    problems.push(
      detail(
        'energy_kwh',
        `${reading.energy_kwh} kWh is higher than the next reading (${next.energy_kwh} kWh at ${next.timestamp.toISOString()}); the meter total never decreases.`,
        readingUri(next)
      )
    );
  }

  if (reading.timestamp.getTime() > now + MAX_CLOCK_SKEW_MS) {
    problems.push(
      detail('timestamp', `Is in the future: more than ${MAX_CLOCK_SKEW_MS / 60000} minutes after the server's current time.`)
    );
  }

  if (reading.voltage < MIN_VOLTAGE || reading.voltage > MAX_VOLTAGE) {
    problems.push(detail('voltage', `${reading.voltage} V is outside the plausible range ${MIN_VOLTAGE}–${MAX_VOLTAGE} V.`));
  }

  return problems;
}

module.exports = { plausibilityProblems, CAPACITY_TOLERANCE, MAX_CLOCK_SKEW_MS, MIN_VOLTAGE, MAX_VOLTAGE };
