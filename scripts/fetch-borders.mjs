// Bakes Natural Earth 110m country borders into a compact polyline list
// for the land/ocean orientation overlay. Run: node scripts/fetch-borders.mjs

import { writeFile } from 'node:fs/promises';

const SOURCES = [
  'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/cultural/ne_110m_admin_0_countries.json',
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson',
];

let geo = null;
for (const url of SOURCES) {
  try {
    const res = await fetch(url);
    if (res.ok) { geo = await res.json(); break; }
  } catch { /* try next */ }
}
if (!geo) throw new Error('No border source reachable');

const round = (n) => Math.round(n * 100) / 100;
const lines = [];
for (const f of geo.features) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys)
    for (const ring of poly)
      lines.push(ring.map(([lng, lat]) => [round(lat), round(lng)]));
}

await writeFile(
  new URL('../public/data/borders.json', import.meta.url),
  JSON.stringify(lines)
);
const pts = lines.reduce((s, l) => s + l.length, 0);
console.log(`Wrote ${lines.length} border rings, ${pts} points`);
