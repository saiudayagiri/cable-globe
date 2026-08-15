// Fetches TeleGeography's public submarine cable data and bakes it into
// compact static JSON for the site. Run: npm run data
// Data © TeleGeography (submarinecablemap.com) — credited in the app UI.

import { writeFile, mkdir } from 'node:fs/promises';

const API = 'https://www.submarinecablemap.com/api/v3';
const OUT = new URL('../public/data/', import.meta.url);
const CONCURRENCY = 10;

async function getJSON(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function mapPool(items, fn, size) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx], idx);
      }
    })
  );
  return results;
}

const round = (n) => Math.round(n * 1000) / 1000;

// Split a lng sequence at antimeridian crossings so paths don't streak
// across the globe, and convert [lng,lat] -> [lat,lng] rounded.
function toPaths(multiLine) {
  const paths = [];
  for (const line of multiLine) {
    let current = [];
    let prev = null;
    for (const [lng, lat] of line) {
      if (prev !== null && Math.abs(lng - prev) > 180) {
        if (current.length > 1) paths.push(current);
        current = [];
      }
      current.push([round(lat), round(lng)]);
      prev = lng;
    }
    if (current.length > 1) paths.push(current);
  }
  return paths;
}

console.log('Fetching cable geometry…');
const geo = await getJSON(`${API}/cable/cable-geo.json`);
// the API sometimes lists a cable as multiple features — merge by id
const byId = new Map();
for (const f of geo.features) {
  const seen = byId.get(f.properties.id);
  if (seen) seen.geometry.coordinates.push(...f.geometry.coordinates);
  else byId.set(f.properties.id, f);
}
geo.features = [...byId.values()];
console.log(`  ${geo.features.length} cables`);

console.log('Fetching landing points…');
const lpGeo = await getJSON(`${API}/landing-point/landing-point-geo.json`);
console.log(`  ${lpGeo.features.length} landing points`);

console.log(`Fetching per-cable details (${CONCURRENCY} at a time)…`);
let done = 0;
const details = await mapPool(
  geo.features,
  async (f) => {
    const d = await getJSON(`${API}/cable/${f.properties.id}.json`).catch((e) => {
      console.warn(`  ! ${f.properties.id}: ${e.message}`);
      return null;
    });
    if (++done % 100 === 0) console.log(`  ${done}/${geo.features.length}`);
    return d;
  },
  CONCURRENCY
);

const cables = geo.features.map((f, i) => {
  const d = details[i] ?? {};
  return {
    id: f.properties.id,
    name: f.properties.name,
    color: f.properties.color,
    length: d.length ?? null,
    owners: d.owners ?? null,
    suppliers: d.suppliers ?? null,
    year: d.rfs_year ?? null,
    planned: d.is_planned ?? false,
    url: d.url ?? null,
    landingPoints: (d.landing_points ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      country: p.country,
    })),
    paths: toPaths(f.geometry.coordinates),
  };
});

const landingPoints = lpGeo.features.map((f) => ({
  id: f.properties.id,
  name: f.properties.name,
  lat: round(f.geometry.coordinates[1]),
  lng: round(f.geometry.coordinates[0]),
}));

await mkdir(OUT, { recursive: true });
await writeFile(new URL('cables.json', OUT), JSON.stringify(cables));
await writeFile(new URL('landing-points.json', OUT), JSON.stringify(landingPoints));

const years = cables.map((c) => c.year).filter(Boolean);
console.log(`\nWrote ${cables.length} cables (years ${Math.min(...years)}–${Math.max(...years)})`);
console.log(`Wrote ${landingPoints.length} landing points`);
