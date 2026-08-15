// Bakes real satellites (CelesTrak GP elements) with full identity and
// orbital elements so the app can propagate true current positions and
// show per-satellite info on click.
// Run: node scripts/fetch-satellites.mjs

import { writeFile } from 'node:fs/promises';

const GM = 398600.4418; // km^3/s^2
const R_EARTH = 6371;
const J2000_MS = Date.UTC(2000, 0, 1, 12);

const gp = (group) => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;
const sup = (file) => `https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=${file}&FORMAT=json`;

const GROUPS = [
  { urls: [gp('stations')], label: 'Space station', pick: (a) => a.filter((s) => s.OBJECT_NAME === 'ISS (ZARYA)') },
  { urls: [gp('starlink'), sup('starlink')], label: 'Starlink · SpaceX', take: 80 },
  { urls: [gp('oneweb'), sup('oneweb')], label: 'OneWeb', take: 32 },
  { urls: [gp('gps-ops')], label: 'GPS · US Space Force', take: 31 },
  { urls: [gp('geo')], label: 'Geostationary comms', take: 40 },
];

// keep previously-baked entries for any group whose endpoints fail (rate limits)
let previous = [];
try {
  previous = JSON.parse(
    await (await import('node:fs/promises')).readFile(new URL('../public/data/satellites.json', import.meta.url), 'utf8')
  );
} catch { /* first run */ }

const sats = [];
for (const { urls, label, take, pick } of GROUPS) {
  let all = null;
  for (const url of urls) {
    const res = await fetch(url);
    if (res.ok) { all = await res.json(); break; }
    console.warn(`  ${label}: HTTP ${res.status} on ${url}`);
  }
  if (!all) {
    const kept = previous.filter((s) => s.g === label);
    console.warn(`  ${label}: all sources failed, keeping ${kept.length} previous`);
    sats.push(...kept);
    continue;
  }
  let picked;
  if (pick) picked = pick(all);
  else {
    const step = Math.max(1, Math.floor(all.length / take));
    picked = all.filter((_, i) => i % step === 0).slice(0, take);
  }
  for (const s of picked) {
    const T = 86400 / s.MEAN_MOTION; // s
    const semi = Math.cbrt((GM * T * T) / (4 * Math.PI * Math.PI));
    sats.push({
      n: s.OBJECT_NAME,
      g: label,
      id: s.NORAD_CAT_ID,
      d: s.OBJECT_ID, // intl designator, e.g. 1998-067A -> launch year
      i: +s.INCLINATION.toFixed(3),
      o: +s.RA_OF_ASC_NODE.toFixed(3),
      w: +s.ARG_OF_PERICENTER.toFixed(3),
      e: +s.ECCENTRICITY.toFixed(6),
      m: +s.MEAN_ANOMALY.toFixed(3),
      p: +(T / 60).toFixed(3), // minutes
      a: Math.round(semi - R_EARTH), // mean altitude km
      ep: +(((Date.parse(s.EPOCH + 'Z') - J2000_MS) / 86400000).toFixed(6)), // days since J2000
    });
  }
  console.log(`${label}: ${picked.length} of ${all.length}`);
}

await writeFile(
  new URL('../public/data/satellites.json', import.meta.url),
  JSON.stringify(sats)
);
console.log(`Wrote ${sats.length} satellites`);
