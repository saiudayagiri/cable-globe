// Bakes everything the self-contained 2D map needs:
//   land polygons (NE 50m), country + city label points (NE 110m),
//   and MapLibre glyph files so text renders without any external service.
// Run: node scripts/fetch-2d.mjs

import { writeFile, mkdir } from 'node:fs/promises';

const NE = 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master';
const OUT = new URL('../public/data/', import.meta.url);

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const round = (n) => Math.round(n * 100) / 100;
const roundRing = (ring) => ring.map(([x, y]) => [round(x), round(y)]);

// ---- land polygons (50m = decent coastlines up to ~z8) ----
console.log('Fetching land polygons…');
const landRaw = await getJSON(`${NE}/50m/physical/ne_50m_land.json`);
const land = {
  type: 'FeatureCollection',
  features: landRaw.features.map((f) => ({
    type: 'Feature',
    properties: {},
    geometry:
      f.geometry.type === 'Polygon'
        ? { type: 'Polygon', coordinates: f.geometry.coordinates.map(roundRing) }
        : {
            type: 'MultiPolygon',
            coordinates: f.geometry.coordinates.map((p) => p.map(roundRing)),
          },
  })),
};
await writeFile(new URL('land.json', OUT), JSON.stringify(land));

// ---- country label points ----
console.log('Fetching country labels…');
const countriesRaw = await getJSON(`${NE}/110m/cultural/ne_110m_admin_0_countries.json`);
const countries = countriesRaw.features.map((f) => {
  const p = f.properties;
  let lng = p.LABEL_X, lat = p.LABEL_Y;
  if (lng == null || lat == null) {
    // centroid of the largest ring as fallback
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    let best = polys[0][0];
    for (const poly of polys) if (poly[0].length > best.length) best = poly[0];
    lng = best.reduce((s, c) => s + c[0], 0) / best.length;
    lat = best.reduce((s, c) => s + c[1], 0) / best.length;
  }
  const pop = p.POP_EST ?? 0;
  const z = pop > 1e8 ? 0.5 : pop > 2e7 ? 1.2 : pop > 5e6 ? 2.0 : 2.8;
  return { n: p.NAME ?? p.ADMIN, lat: round(lat), lng: round(lng), z, pop };
});
// bigger countries win label collisions
countries.sort((a, b) => b.pop - a.pop).forEach((c, i) => { c.r = i; delete c.pop; });

// ---- city label points ----
console.log('Fetching city labels…');
const placesRaw = await getJSON(`${NE}/50m/cultural/ne_50m_populated_places.json`);
const cities = placesRaw.features.map((f) => {
  const p = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  const pop = p.POP_MAX ?? 0;
  const z = pop > 8e6 ? 2.4 : pop > 3e6 ? 3.0 : 3.8;
  return { n: p.NAME, lat: round(lat), lng: round(lng), z, pop };
});
cities.sort((a, b) => b.pop - a.pop).forEach((c, i) => { c.r = i; delete c.pop; });

await writeFile(new URL('places.json', OUT), JSON.stringify({ countries, cities }));

// ---- glyphs (so MapLibre text needs no external font server) ----
console.log('Fetching glyphs…');
const FONT = 'Open Sans Regular';
const RANGES = ['0-255', '256-511'];
const GLYPH_SOURCES = [
  (r) => `https://demotiles.maplibre.org/font/${encodeURIComponent(FONT)}/${r}.pbf`,
  (r) => `https://fonts.openmaptiles.org/${encodeURIComponent(FONT)}/${r}.pbf`,
];
const fontDir = new URL(`../public/fonts/${FONT}/`, import.meta.url);
await mkdir(fontDir, { recursive: true });
for (const range of RANGES) {
  let ok = false;
  for (const src of GLYPH_SOURCES) {
    const res = await fetch(src(range));
    if (res.ok) {
      await writeFile(new URL(`${range}.pbf`, fontDir), Buffer.from(await res.arrayBuffer()));
      ok = true;
      break;
    }
  }
  if (!ok) throw new Error(`No glyph source for range ${range}`);
}

console.log(`Wrote land (${land.features.length} features), ${countries.length} countries, ${cities.length} cities, glyphs ${RANGES.join(', ')}`);
