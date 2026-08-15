// Self-contained 2D map (MapLibre GL): no tiles, no font server — land
// polygons, labels and glyphs are all baked local assets. Lazy-loaded the
// first time the user toggles to 2D.

const altToZoom = (alt) => Math.min(8, Math.max(0.7, Math.log2(4.5 / Math.max(alt, 0.02))));
const zoomToAlt = (z) => Math.min(2.5, Math.max(0.12, 4.5 / 2 ** z));

export async function createMap2D({ container, cables, lps, borders, callbacks }) {
  const [mlModule, , land, places] = await Promise.all([
    import('maplibre-gl'),
    import('maplibre-gl/dist/maplibre-gl.css'),
    fetch('data/land.json').then((r) => r.json()),
    fetch('data/places.json').then((r) => r.json()),
  ]);
  const maplibregl = mlModule.default ?? mlModule;
  // module worker + its relative import are vendored into public/ (see package.json "vendor")
  maplibregl.setWorkerUrl(`${location.origin}/vendor/maplibre-gl-worker.mjs`);

  const cableFC = {
    type: 'FeatureCollection',
    features: cables.flatMap((c, ci) =>
      c.paths.map((path) => ({
        type: 'Feature',
        properties: { ci, id: c.id, name: c.name, color: c.dispColor, year: c.year },
        geometry: {
          type: 'LineString',
          coordinates: path.map(([lat, lng]) => [lng, lat]),
        },
      }))
    ),
  };
  const lpFC = {
    type: 'FeatureCollection',
    features: lps.map((lp) => ({
      type: 'Feature',
      properties: { id: lp.id, name: lp.name, year: lp.year },
      geometry: { type: 'Point', coordinates: [lp.lng, lp.lat] },
    })),
  };
  const borderFC = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'MultiLineString',
        coordinates: borders.map((ring) => ring.map(([lat, lng]) => [lng, lat])),
      },
    }],
  };
  const labelFC = (list) => ({
    type: 'FeatureCollection',
    features: list.map((p) => ({
      type: 'Feature',
      properties: { n: p.n, z: p.z },
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    })),
  });

  // per-feature min zoom via one layer per bucket (['zoom'] is illegal in filters)
  const labelLayers = (idPrefix, source, buckets, layout, paint) =>
    buckets.map((z) => ({
      id: `${idPrefix}-${z}`,
      type: 'symbol',
      source,
      minzoom: z,
      filter: ['==', ['get', 'z'], z],
      layout,
      paint,
    }));

  const style = {
    version: 8,
    glyphs: `${location.origin}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      land: { type: 'geojson', data: land },
      borders: { type: 'geojson', data: borderFC },
      cables: { type: 'geojson', data: cableFC },
      lps: { type: 'geojson', data: lpFC },
      countries: { type: 'geojson', data: labelFC(places.countries) },
      cities: { type: 'geojson', data: labelFC(places.cities) },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#02040a' } },
      {
        id: 'land', type: 'fill', source: 'land',
        paint: { 'fill-color': '#0d1728' },
      },
      {
        id: 'coast', type: 'line', source: 'land',
        paint: { 'line-color': 'rgba(143,168,200,0.30)', 'line-width': 0.8 },
      },
      {
        id: 'borders', type: 'line', source: 'borders',
        paint: { 'line-color': 'rgba(143,168,200,0.16)', 'line-width': 0.6 },
      },
      {
        id: 'cables', type: 'line', source: 'cables',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1.1, 5, 2, 8, 3],
          'line-opacity': 0.85,
        },
      },
      {
        id: 'cables-hov', type: 'line', source: 'cables',
        filter: ['==', ['get', 'ci'], -1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 2.4, 8, 4.5],
          'line-opacity': 1,
        },
      },
      {
        id: 'cables-sel', type: 'line', source: 'cables',
        filter: ['in', ['get', 'id'], ['literal', []]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 2.2, 8, 4],
          'line-opacity': 1,
        },
      },
      {
        id: 'flow', type: 'line', source: 'cables',
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1.1, 8, 2.2],
          'line-opacity': 0.28,
          'line-dasharray': [0, 4, 3],
        },
      },
      {
        id: 'lps', type: 'circle', source: 'lps',
        paint: {
          'circle-color': '#ffd9a6',
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 1.4, 5, 3, 8, 4.5],
          'circle-opacity': 0.75,
        },
      },
      {
        id: 'lps-sel', type: 'circle', source: 'lps',
        filter: ['in', ['get', 'id'], ['literal', []]],
        paint: {
          'circle-color': '#ffd479',
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3.5, 8, 7],
          'circle-stroke-color': 'rgba(255,255,255,0.85)',
          'circle-stroke-width': 1.2,
          'circle-opacity': 0.95,
        },
      },
      ...labelLayers('country-labels', 'countries', [0.8, 1.6, 2.4, 3.2], {
        'text-field': ['get', 'n'],
        'text-font': ['Open Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 1, 9.5, 4, 13, 7, 15],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.12,
        'symbol-sort-key': ['get', 'z'],
      }, {
        'text-color': 'rgba(158,175,199,0.85)',
        'text-halo-color': '#02040a',
        'text-halo-width': 1.2,
      }),
      ...labelLayers('city-labels', 'cities', [2.8, 3.4, 4.2], {
        'text-field': ['get', 'n'],
        'text-font': ['Open Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 8, 12.5],
        'symbol-sort-key': ['get', 'z'],
        'text-offset': [0, 0.4],
        'text-anchor': 'top',
      }, {
        'text-color': 'rgba(120,140,165,0.9)',
        'text-halo-color': '#02040a',
        'text-halo-width': 1.1,
      }),
    ],
  };

  const map = new maplibregl.Map({
    container,
    style,
    center: [10, 22],
    zoom: 1.4,
    minZoom: 0.7,
    maxZoom: 8,
    attributionControl: false,
    renderWorldCopies: true,
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate?.disableRotation?.();

  map.on('error', (e) => console.error('[map2d] map error:', e.error?.message ?? e));
  map.on('sourcedata', (e) => {
    if (e.isSourceLoaded) console.log('[map2d] source loaded:', e.sourceId);
  });
  map.once('load', () => console.log('[map2d] load fired'));
  map.once('idle', () => console.log('[map2d] idle'));
  // usable at first render; sources keep streaming in, filters re-sync on load
  await new Promise((resolve) => map.once('render', resolve));
  map.once('load', () => applyFilters());

  // ---- dynamic state (year filter, selection, hover) ----
  const state = { year: 9999, selIds: null, hovCi: null, lpIds: null };

  function yearF() {
    return ['<=', ['get', 'year'], state.year];
  }
  function applyFilters() {
    try {
      applyFiltersInner();
    } catch { /* style not ready yet; re-applied on load */ }
  }
  function applyFiltersInner() {
    map.setFilter('cables', yearF());
    map.setFilter('flow', yearF());
    map.setFilter('lps', yearF());
    map.setFilter('cables-sel', [
      'all', yearF(), ['in', ['get', 'id'], ['literal', state.selIds ?? []]],
    ]);
    map.setFilter('cables-hov', ['all', yearF(), ['==', ['get', 'ci'], state.hovCi ?? -1]]);
    map.setFilter('lps-sel', ['in', ['get', 'id'], ['literal', state.lpIds ?? []]]);
    map.setPaintProperty('cables', 'line-opacity', state.selIds ? 0.1 : 0.85);
    map.setPaintProperty('flow', 'line-opacity', state.selIds ? 0.08 : 0.28);
    map.setPaintProperty('lps', 'circle-opacity', state.selIds ? 0.3 : 0.75);
  }

  // ---- traffic pulses: animated dash on the flow overlay ----
  const dashSeq = [
    [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5],
    [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5],
    [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5],
    [0, 3, 3, 1], [0, 3.5, 3, 0.5],
  ];
  let dashI = 0, dashRaf = 0, lastDash = 0, visible = false, loaded = false;
  map.once('load', () => { loaded = true; });
  function animateDash(t) {
    if (!visible) return;
    if (!loaded) { dashRaf = requestAnimationFrame(animateDash); return; }
    if (t - lastDash > 90) {
      lastDash = t;
      dashI = (dashI + 1) % dashSeq.length;
      map.setPaintProperty('flow', 'line-dasharray', dashSeq[dashI]);
    }
    dashRaf = requestAnimationFrame(animateDash);
  }

  // ---- interaction ----
  const canvas = map.getCanvas();

  map.on('click', (e) => {
    const pad = 7;
    const bbox = [
      [e.point.x - pad, e.point.y - pad],
      [e.point.x + pad, e.point.y + pad],
    ];
    const lpHits = map.queryRenderedFeatures(bbox, { layers: ['lps', 'lps-sel'] });
    if (lpHits.length) return callbacks.onHub(lpHits[0].properties.id);
    const cHits = map.queryRenderedFeatures(bbox, { layers: ['cables', 'cables-sel'] });
    if (cHits.length) return callbacks.onCable(cHits[0].properties.ci);
    callbacks.onClear();
  });

  map.on('mousemove', (e) => {
    const pad = 5;
    const bbox = [
      [e.point.x - pad, e.point.y - pad],
      [e.point.x + pad, e.point.y + pad],
    ];
    const hits = map.queryRenderedFeatures(bbox, { layers: ['cables', 'cables-sel'] });
    const ci = hits.length ? hits[0].properties.ci : null;
    if (ci !== state.hovCi) {
      state.hovCi = ci;
      try {
        map.setFilter('cables-hov', ['all', yearF(), ['==', ['get', 'ci'], ci ?? -1]]);
      } catch { /* style not ready yet */ }
      canvas.style.cursor = ci !== null ? 'pointer' : '';
    }
    callbacks.onHover(ci, { x: e.originalEvent.clientX, y: e.originalEvent.clientY });
  });
  map.on('mouseout', () => {
    state.hovCi = null;
    try {
      map.setFilter('cables-hov', ['all', yearF(), ['==', ['get', 'ci'], -1]]);
    } catch { /* style not ready yet */ }
    callbacks.onHover(null, null);
  });

  // ---- public api ----
  return {
    show(pov) {
      visible = true;
      map.jumpTo({ center: [pov.lng, pov.lat], zoom: altToZoom(pov.altitude ?? 2) });
      map.resize();
      dashRaf = requestAnimationFrame(animateDash);
    },
    hide() {
      visible = false;
      cancelAnimationFrame(dashRaf);
      const c = map.getCenter();
      return { lat: c.lat, lng: c.lng, altitude: zoomToAlt(map.getZoom()) };
    },
    setYear(y) {
      state.year = y;
      applyFilters();
    },
    setSelection(ids) {
      state.selIds = ids && ids.length ? ids : null;
      applyFilters();
    },
    setLpHighlight(ids) {
      state.lpIds = ids && ids.length ? ids : null;
      try {
        map.setFilter('lps-sel', ['in', ['get', 'id'], ['literal', state.lpIds ?? []]]);
      } catch { /* style not ready yet; re-applied on load */ }
    },
    flyTo(pov, ms = 1100) {
      map.flyTo({
        center: [pov.lng, pov.lat],
        zoom: altToZoom(pov.altitude ?? 1),
        duration: ms,
      });
    },
  };
}
