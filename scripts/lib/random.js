// Small seeded random number generator (mulberry32): the same seed gives the same sequence on
// every run, so generated seed data is reproducible. Not for anything security-related.
function makeRandom(seed) {
  let a = seed;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { makeRandom };
