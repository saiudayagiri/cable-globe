// Bakes a representative set of real satellites (CelesTrak GP data) into
// compact orbital elements for the satellite layer.
// Run: node scripts/fetch-satellites.mjs

import { writeFile } from 'node:fs/promises';

const GM = 398600.4418; // km^3/s^2
const R_EARTH = 6371;

const GROUPS = [
  { group: 'starlink', take: 60 },   // LEO mega-constellation (sampled)
  { group: 'oneweb', take: 24 },     // LEO
  { group: 'gps-ops', take: 31 },    // MEO navigation
  { group: 'geo', take: 28 },        // geostationary comms
];

const sats = [];
for (const { group, take } of GROUPS) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;
  const res = await fetch(url);
  if (!res.ok) { console.warn(`skip ${group}: HTTP ${res.status}`); continue; }
  const all = await res.json();
  const step = Math.max(1, Math.floor(all.length / take));
  const picked = all.filter((_, i) => i % step === 0).slice(0, take);
  for (const s of picked) {
    const n = s.MEAN_MOTION; // revs/day
    const T = 86400 / n; // s
    const a = Math.cbrt((GM * T * T) / (4 * Math.PI * Math.PI));
    sats.push({
      n: s.OBJECT_NAME,
      i: +s.INCLINATION.toFixed(2),
      o: +s.RA_OF_ASC_NODE.toFixed(2),
      m: +s.MEAN_ANOMALY.toFixed(2),
      p: +(T / 60).toFixed(2), // minutes
      a: Math.round(a - R_EARTH), // km altitude
    });
  }
  console.log(`${group}: ${picked.length} of ${all.length}`);
}

await writeFile(
  new URL('../public/data/satellites.json', import.meta.url),
  JSON.stringify(sats)
);
console.log(`Wrote ${sats.length} satellites`);
