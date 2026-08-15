import Globe from 'globe.gl';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const YEAR_MIN = 1989;
const YEAR_ALL = 2030; // slider max = "All years"
const YEAR_UNKNOWN = 2031; // cables with no RFS year only show on "All"
const CABLE_ALT = 0.004;
const PULSE_SPACING_DEG = 14; // one light packet every ~14° of arc

const $ = (id) => document.getElementById(id);

main().catch((err) => console.error(err));

async function main() {
const [cables, landingPoints, borders] = await Promise.all(
  ['data/cables.json', 'data/landing-points.json', 'data/borders.json'].map((u) =>
    fetch(u).then((r) => r.json())
  )
);

// ---------- globe ----------
const globeEl = $('globe');
const globe = Globe()(globeEl)
  .globeImageUrl('textures/earth-night.jpg')
  .backgroundImageUrl('textures/night-sky.png')
  .atmosphereColor('#4a7dbd')
  .atmosphereAltitude(0.16)
  .pointOfView({ lat: 22, lng: 10, altitude: 2.3 });

const controls = globe.controls();
controls.autoRotateSpeed = 0.28;
controls.minDistance = 115;

const bloom = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight), 0.38, 0.5, 0.3
);
globe.postProcessingComposer().addPass(bloom);

addEventListener('resize', () => globe.width(innerWidth).height(innerHeight));

// ---------- merged cable geometry (one draw call for all 724 cables) ----------
const positions = [], colors = [], phases = [], years = [], ranges = [];
const grid = new Map(); // 2° buckets of {ci, lat, lng} for picking

const gridKey = (lat, lng) => `${Math.floor(lat / 2)}:${Math.floor(lng / 2)}`;
const tmpColor = new THREE.Color();

cables.forEach((cable, ci) => {
  cable.year ??= YEAR_UNKNOWN;
  tmpColor.set(cable.color || '#888');
  const hsl = tmpColor.getHSL({});
  if (hsl.s > 0.15) tmpColor.setHSL(hsl.h, Math.max(hsl.s, 0.55), Math.max(hsl.l, 0.55));
  else tmpColor.setHSL(hsl.h, hsl.s, Math.max(hsl.l, 0.6));
  cable.dispColor = `#${tmpColor.getHexString()}`;
  const [r, g, b] = [tmpColor.r, tmpColor.g, tmpColor.b];

  const start = positions.length / 3;
  const phase0 = Math.random(); // desync pulses between cables
  let longest = { len: -1, path: null };

  for (const path of cable.paths) {
    let dist = 0;
    let prev = null, prevPhase = 0;
    for (const [lat, lng] of path) {
      const { x, y, z } = globe.getCoords(lat, lng, CABLE_ALT);
      if (prev) {
        const dLat = lat - prev.lat;
        const dLng = (lng - prev.lng) * Math.cos((lat * Math.PI) / 180);
        dist += Math.hypot(dLat, dLng);
        const ph = phase0 + dist / PULSE_SPACING_DEG;
        positions.push(prev.x, prev.y, prev.z, x, y, z);
        colors.push(r, g, b, r, g, b);
        phases.push(prevPhase, ph);
        years.push(cable.year, cable.year);
        prevPhase = ph;
      }
      prev = { lat, lng, x, y, z };
      const key = gridKey(lat, lng);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push({ ci, lat, lng });
    }
    if (dist > longest.len) longest = { len: dist, path };
    cable.lengthDeg = (cable.lengthDeg || 0) + dist;
  }
  cable.focus = longest.path ? longest.path[Math.floor(longest.path.length / 2)] : [0, 0];
  cable.km = parseInt((cable.length || '').replace(/,/g, '')) || 0;
  ranges.push([start, positions.length / 3 - start]);
});

const nVerts = positions.length / 3;
const selArr = new Float32Array(nVerts);
const hovArr = new Float32Array(nVerts);

const cableGeom = new THREE.BufferGeometry();
cableGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
cableGeom.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
cableGeom.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
cableGeom.setAttribute('aYear', new THREE.Float32BufferAttribute(years, 1));
cableGeom.setAttribute('aSel', new THREE.BufferAttribute(selArr, 1));
cableGeom.setAttribute('aHov', new THREE.BufferAttribute(hovArr, 1));

const uniforms = {
  uTime: { value: 0 },
  uYearMax: { value: YEAR_UNKNOWN + 1 },
  uSelActive: { value: 0 },
};

const cableMat = new THREE.ShaderMaterial({
  uniforms,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */ `
    attribute vec3 aColor;
    attribute float aPhase, aYear, aSel, aHov;
    varying vec3 vColor;
    varying float vPhase, vYear, vSel, vHov;
    void main() {
      vColor = aColor; vPhase = aPhase; vYear = aYear; vSel = aSel; vHov = aHov;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform float uTime, uYearMax, uSelActive;
    varying vec3 vColor;
    varying float vPhase, vYear, vSel, vHov;
    void main() {
      if (vYear > uYearMax + 0.5) discard;
      float p = fract(vPhase - uTime * 0.09);
      float pulse = smoothstep(0.0, 0.035, p) * (1.0 - smoothstep(0.05, 0.24, p));
      float focus = max(vSel, vHov);
      float base = mix(0.3, mix(0.04, 1.0, focus), uSelActive * (1.0 - vHov) + vHov);
      float glow = pulse * mix(0.7, mix(0.0, 2.0, focus), uSelActive * (1.0 - vHov) + vHov);
      vec3 col = vColor * (base + glow) + vec3(glow * 0.12);
      gl_FragColor = vec4(col, 1.0);
    }`,
});

globe.scene().add(new THREE.LineSegments(cableGeom, cableMat));

// ---------- country borders overlay (land/ocean orientation) ----------
const bPos = [];
for (const ring of borders) {
  let prev = null;
  for (const [lat, lng] of ring) {
    const { x, y, z } = globe.getCoords(lat, lng, 0.0012);
    if (prev && Math.abs(lng - prev.lng) < 180) bPos.push(prev.x, prev.y, prev.z, x, y, z);
    prev = { lng, x, y, z };
  }
}
const borderGeom = new THREE.BufferGeometry();
borderGeom.setAttribute('position', new THREE.Float32BufferAttribute(bPos, 3));
const borderLines = new THREE.LineSegments(
  borderGeom,
  new THREE.LineBasicMaterial({
    color: 0x8fa8c8,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  })
);
globe.scene().add(borderLines);

// ---------- landing points (one Points cloud) ----------
const lpYear = new Map(); // landing point id -> earliest cable year
const lpCables = new Map(); // landing point id -> [cable index]
cables.forEach((c, ci) => {
  for (const lp of c.landingPoints) {
    if (!lp.id) continue;
    lpYear.set(lp.id, Math.min(lpYear.get(lp.id) ?? Infinity, c.year));
    if (!lpCables.has(lp.id)) lpCables.set(lp.id, []);
    lpCables.get(lp.id).push(ci);
  }
});

const lpPos = [], lpYears = [];
const lpById = new Map();
const lpGrid = new Map(); // 2° buckets of landing points
for (const lp of landingPoints) {
  const { x, y, z } = globe.getCoords(lp.lat, lp.lng, 0.002);
  lpPos.push(x, y, z);
  lpYears.push(lpYear.get(lp.id) ?? YEAR_UNKNOWN);
  lpById.set(lp.id, lp);
  const key = gridKey(lp.lat, lp.lng);
  if (!lpGrid.has(key)) lpGrid.set(key, []);
  lpGrid.get(key).push(lp);
}
const lpGeom = new THREE.BufferGeometry();
lpGeom.setAttribute('position', new THREE.Float32BufferAttribute(lpPos, 3));
lpGeom.setAttribute('aYear', new THREE.Float32BufferAttribute(lpYears, 1));

const lpMat = new THREE.ShaderMaterial({
  uniforms,
  transparent: true,
  depthWrite: false,
  vertexShader: /* glsl */ `
    attribute float aYear;
    varying float vYear;
    void main() {
      vYear = aYear;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = ${(Math.min(devicePixelRatio, 2) * 2.2).toFixed(1)};
    }`,
  fragmentShader: /* glsl */ `
    uniform float uYearMax;
    varying float vYear;
    void main() {
      if (vYear > uYearMax + 0.5) discard;
      if (length(gl_PointCoord - 0.5) > 0.5) discard;
      gl_FragColor = vec4(1.0, 0.85, 0.65, 0.55);
    }`,
});
globe.scene().add(new THREE.Points(lpGeom, lpMat));

// pulse clock
(function tick(t) {
  uniforms.uTime.value = t / 1000;
  requestAnimationFrame(tick);
})(0);

// ---------- picking ----------
function nearestCable(lat, lng, thresholdDeg) {
  const cells = Math.ceil(thresholdDeg / 2) + 1;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = null, bestD = thresholdDeg;
  for (let i = -cells; i <= cells; i++)
    for (let j = -cells; j <= cells; j++) {
      const bucket = grid.get(`${Math.floor(lat / 2) + i}:${Math.floor(lng / 2) + j}`);
      if (!bucket) continue;
      for (const p of bucket) {
        if (cables[p.ci].year > yearMax()) continue;
        const d = Math.hypot(p.lat - lat, (p.lng - lng) * cosLat);
        if (d < bestD) { bestD = d; best = p.ci; }
      }
    }
  return best;
}

function nearestLandingPoint(lat, lng, thresholdDeg) {
  const cells = Math.ceil(thresholdDeg / 2) + 1;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = null, bestD = thresholdDeg;
  for (let i = -cells; i <= cells; i++)
    for (let j = -cells; j <= cells; j++) {
      const bucket = lpGrid.get(`${Math.floor(lat / 2) + i}:${Math.floor(lng / 2) + j}`);
      if (!bucket) continue;
      for (const lp of bucket) {
        if ((lpYear.get(lp.id) ?? YEAR_UNKNOWN) > yearMax()) continue;
        const d = Math.hypot(lp.lat - lat, (lp.lng - lng) * cosLat);
        if (d < bestD) { bestD = d; best = lp; }
      }
    }
  return best;
}

// all cables with a vertex within radiusDeg of (lat,lng) — for chokepoints
function cablesNear(lat, lng, radiusDeg) {
  const cells = Math.ceil(radiusDeg / 2) + 1;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const found = new Set();
  for (let i = -cells; i <= cells; i++)
    for (let j = -cells; j <= cells; j++) {
      const bucket = grid.get(`${Math.floor(lat / 2) + i}:${Math.floor(lng / 2) + j}`);
      if (!bucket) continue;
      for (const p of bucket)
        if (Math.hypot(p.lat - lat, (p.lng - lng) * cosLat) < radiusDeg) found.add(p.ci);
    }
  return [...found];
}

const pickThreshold = () => Math.max(0.5, (globe.pointOfView().altitude ?? 2) * 1.1);

// ---------- rotation state ----------
let spinPref = true, tourSpin = null, hoverIdx = null;
const selSet = new Set();

function updateRotate() {
  controls.autoRotate =
    tourSpin !== null ? tourSpin : spinPref && selSet.size === 0 && hoverIdx === null;
}
const spinBtn = $('ctl-spin');
spinBtn.onclick = () => {
  spinPref = !spinPref;
  spinBtn.textContent = spinPref ? '⏸ spin' : '▶ spin';
  spinBtn.classList.toggle('on', spinPref);
  updateRotate();
};
spinBtn.classList.add('on');
updateRotate();

// ---------- view controls ----------
const viewBtn = $('ctl-view');
let dayView = false;
viewBtn.onclick = () => {
  dayView = !dayView;
  globe.globeImageUrl(dayView ? 'textures/earth-day.jpg' : 'textures/earth-night.jpg');
  viewBtn.textContent = dayView ? '🌙 night' : '🛰 satellite';
};

const bordersBtn = $('ctl-borders');
bordersBtn.onclick = () => {
  borderLines.visible = !borderLines.visible;
  bordersBtn.classList.toggle('on', borderLines.visible);
};

// ---------- selection ----------
function applySel() {
  selArr.fill(0);
  for (const ci of selSet) {
    const [start, count] = ranges[ci];
    selArr.fill(1, start, start + count);
  }
  cableGeom.attributes.aSel.needsUpdate = true;
  uniforms.uSelActive.value = selSet.size ? 1 : 0;
  updateRotate();
}

function clearSelection() {
  selSet.clear();
  applySel();
  globe.ringsData([]);
  $('panel').hidden = true;
}

function ringOn(points, color) {
  globe
    .ringsData(points)
    .ringColor(() => (t) => `rgba(${hexToRgb(color)},${1 - t})`)
    .ringMaxRadius(2.2)
    .ringPropagationSpeed(1.6)
    .ringRepeatPeriod(1100)
    .ringAltitude(0.003);
}

function selectCable(ci, fly = true) {
  if (ci === null) return clearSelection();
  selSet.clear();
  selSet.add(ci);
  applySel();
  const cable = cables[ci];
  if (fly) {
    const [lat, lng] = cable.focus;
    const altitude = Math.min(2.4, Math.max(0.5, cable.lengthDeg / 55));
    globe.pointOfView({ lat, lng, altitude }, 1100);
  }
  ringOn(
    cable.landingPoints.map((lp) => lpById.get(lp.id)).filter(Boolean),
    cable.dispColor
  );
  renderCablePanel(cable);
}

function selectGroup(indices, { title, subtitle, fly, ringPoints, ringColor } = {}) {
  selSet.clear();
  indices.forEach((ci) => selSet.add(ci));
  applySel();
  if (fly) globe.pointOfView(fly, 1100);
  if (ringPoints) ringOn(ringPoints, ringColor || '#6ee7ff');
  else globe.ringsData([]);
  renderGroupPanel(title, subtitle, indices);
}

function selectHub(lp, fly = true) {
  const indices = lpCables.get(lp.id) ?? [];
  selectGroup(indices, {
    title: lp.name,
    subtitle: `${indices.length} cable${indices.length === 1 ? '' : 's'} land here`,
    fly: fly ? { lat: lp.lat, lng: lp.lng, altitude: 0.9 } : null,
    ringPoints: [lp],
    ringColor: '#ffd479',
  });
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

// ---------- panel ----------
function panelBase(name) {
  $('panel-name').textContent = name;
  $('panel-badges').innerHTML = '';
  $('panel-stats').innerHTML = '';
  $('panel-owners').innerHTML = '';
  $('panel-lps').innerHTML = '';
  $('panel-lps-wrap').style.display = 'none';
  $('panel-url').hidden = true;
  $('panel-list').hidden = true;
  $('panel').hidden = false;
}

function renderCablePanel(cable) {
  panelBase(cable.name);
  $('panel-accent').style.background = cable.dispColor;

  const badges = [];
  if (cable.planned) badges.push('<span class="badge planned">Planned</span>');
  if (cable.year !== YEAR_UNKNOWN) badges.push(`<span class="badge">RFS ${cable.year}</span>`);
  $('panel-badges').innerHTML = badges.join('');

  const stats = [
    ['Length', cable.length],
    ['Landing points', cable.landingPoints.length || null],
    ['Supplier', cable.suppliers],
  ].filter(([, v]) => v);
  $('panel-stats').innerHTML = stats
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');

  $('panel-owners').innerHTML = (cable.owners || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => `<span class="chip">${o}</span>`)
    .join('');

  $('panel-lps').innerHTML = cable.landingPoints
    .map((lp) => {
      const [city] = lp.name.split(',');
      return `<li data-lp="${lp.id ?? ''}"><b>${city}</b>, ${lp.country}</li>`;
    })
    .join('');
  $('panel-lps-wrap').style.display = cable.landingPoints.length ? '' : 'none';

  const url = $('panel-url');
  url.hidden = !cable.url;
  if (cable.url) url.href = cable.url;
}

function renderGroupPanel(title, subtitle, indices) {
  panelBase(title);
  $('panel-accent').style.background = '#6ee7ff';
  if (subtitle) $('panel-badges').innerHTML = `<span class="badge">${subtitle}</span>`;
  const list = $('panel-list');
  list.innerHTML = [...indices]
    .sort((a, b) => cables[b].km - cables[a].km)
    .map((ci) => {
      const c = cables[ci];
      return `<li data-ci="${ci}">
        <span class="dot" style="background:${c.dispColor}"></span>
        <span class="r-name">${c.name}</span>
        <span class="r-meta">${c.year === YEAR_UNKNOWN ? '—' : c.year}</span>
      </li>`;
    })
    .join('');
  list.hidden = false;
}

$('panel-list').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-ci]');
  if (li) selectCable(+li.dataset.ci);
});
$('panel-lps').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-lp]');
  if (li && li.dataset.lp && lpById.get(li.dataset.lp)) selectHub(lpById.get(li.dataset.lp));
});
$('panel-close').onclick = () => clearSelection();

// ---------- pointer interaction ----------
globe.onGlobeClick(({ lat, lng }) => {
  const thr = pickThreshold();
  const lp = nearestLandingPoint(lat, lng, Math.min(0.45, thr * 0.4));
  if (lp && (lpCables.get(lp.id)?.length ?? 0) > 0) return selectHub(lp, false);
  const ci = nearestCable(lat, lng, thr);
  ci === null ? clearSelection() : selectCable(ci, false);
});

function setHover(ci) {
  if (ci === hoverIdx) return;
  const fill = (idx, v) => {
    if (idx === null) return;
    const [start, count] = ranges[idx];
    hovArr.fill(v, start, start + count);
  };
  fill(hoverIdx, 0);
  fill(ci, 1);
  cableGeom.attributes.aHov.needsUpdate = true;
  hoverIdx = ci;
  globeEl.classList.toggle('cable-hover', ci !== null);
  updateRotate();
}

const tooltip = $('tooltip');
let rafHover = 0;
globeEl.addEventListener('pointermove', (ev) => {
  if (rafHover) return;
  rafHover = requestAnimationFrame(() => {
    rafHover = 0;
    const coords = globe.toGlobeCoords(ev.clientX, ev.clientY);
    const ci = coords ? nearestCable(coords.lat, coords.lng, pickThreshold()) : null;
    setHover(ci);
    if (ci !== null) {
      const c = cables[ci];
      tooltip.innerHTML = `${c.name} <span class="t-meta">${
        c.year === YEAR_UNKNOWN ? '' : c.year
      }${c.length ? ' · ' + c.length : ''}</span>`;
      tooltip.style.left = `${Math.min(ev.clientX + 14, innerWidth - 220)}px`;
      tooltip.style.top = `${ev.clientY + 14}px`;
      tooltip.hidden = false;
    } else tooltip.hidden = true;
  });
});
globeEl.addEventListener('pointerleave', () => { setHover(null); tooltip.hidden = true; });

// ---------- timeline ----------
const yearInput = $('year');
const yearMax = () =>
  +yearInput.value >= YEAR_ALL ? YEAR_UNKNOWN + 1 : +yearInput.value;

function updateTimeline() {
  const v = +yearInput.value;
  uniforms.uYearMax.value = yearMax();
  const all = v >= YEAR_ALL;
  $('year-label').textContent = all ? 'All years' : v;
  const n = all ? cables.length : cables.filter((c) => c.year <= v).length;
  $('year-count').textContent = `${n} cables`;
  if (selSet.size === 1) {
    const [only] = selSet;
    if (cables[only].year > yearMax()) clearSelection();
  }
}
yearInput.addEventListener('input', () => { stopPlay(); updateTimeline(); });

function showAllYears() {
  if (+yearInput.value < YEAR_ALL) {
    yearInput.value = YEAR_ALL;
    updateTimeline();
  }
}

let playing = false, playRaf = 0;
function stopPlay() {
  playing = false;
  cancelAnimationFrame(playRaf);
  $('play').textContent = '▶';
}
function startPlay() {
  if (playing) return;
  playing = true;
  $('play').textContent = '❚❚';
  if (+yearInput.value >= YEAR_ALL) yearInput.value = YEAR_MIN;
  updateTimeline();
  let last = performance.now(), acc = 0;
  (function step(now) {
    if (!playing) return;
    acc += (now - last) / 1000;
    last = now;
    if (acc >= 0.45) {
      acc = 0;
      yearInput.value = +yearInput.value + 1;
      updateTimeline();
      if (+yearInput.value >= YEAR_ALL) return stopPlay();
    }
    playRaf = requestAnimationFrame(step);
  })(last);
}
$('play').onclick = () => (playing ? stopPlay() : startPlay());

// ---------- countries as first-class entities ----------
const countryIndex = new Map(); // country name -> {indices:Set, lpIds:Set}
cables.forEach((c, ci) => {
  for (const lp of c.landingPoints) {
    if (!lp.country) continue;
    if (!countryIndex.has(lp.country))
      countryIndex.set(lp.country, { indices: new Set(), lpIds: new Set() });
    const e = countryIndex.get(lp.country);
    e.indices.add(ci);
    if (lp.id && lpById.has(lp.id)) e.lpIds.add(lp.id);
  }
});

function selectCountry(name) {
  const e = countryIndex.get(name);
  if (!e) return;
  showAllYears();
  const lps = [...e.lpIds].map((id) => lpById.get(id));
  let fly = null;
  if (lps.length) {
    // fly to the centroid of this country's landing stations
    const lat = lps.reduce((s, p) => s + p.lat, 0) / lps.length;
    let lngs = lps.map((p) => p.lng);
    // countries spanning the antimeridian (Fiji, NZ…): average in 0–360 space
    if (Math.max(...lngs) - Math.min(...lngs) > 180)
      lngs = lngs.map((l) => (l < 0 ? l + 360 : l));
    let lng = lngs.reduce((s, l) => s + l, 0) / lngs.length;
    if (lng > 180) lng -= 360;
    const spread = Math.max(
      Math.max(...lps.map((p) => p.lat)) - Math.min(...lps.map((p) => p.lat)),
      Math.max(...lngs) - Math.min(...lngs)
    );
    fly = { lat, lng, altitude: Math.min(2.4, Math.max(0.7, spread / 40)) };
  }
  selectGroup([...e.indices], {
    title: name,
    subtitle: `${e.indices.size} cables · ${e.lpIds.size} landing stations`,
    fly,
    ringPoints: lps.length <= 40 ? lps : null,
    ringColor: '#ffd479',
  });
}

// ---------- search ----------
const countryNames = [...countryIndex.keys()];
const searchIndex = cables.map((c, ci) => ({
  ci,
  hay: [c.name, c.owners, c.suppliers, ...c.landingPoints.map((l) => `${l.name} ${l.country}`)]
    .join(' ')
    .toLowerCase(),
  name: c.name.toLowerCase(),
}));

const searchInput = $('search');
const resultsEl = $('search-results');

function runSearch(q) {
  q = q.trim().toLowerCase();
  if (q.length < 2) { resultsEl.hidden = true; return; }

  const countryHits = countryNames
    .filter((n) => n.toLowerCase().includes(q))
    .sort((a, b) => countryIndex.get(b).indices.size - countryIndex.get(a).indices.size)
    .slice(0, 3);
  const cableHits = searchIndex
    .filter((e) => e.hay.includes(q))
    .sort((a, b) => (b.name.includes(q) ? 1 : 0) - (a.name.includes(q) ? 1 : 0))
    .slice(0, 12 - countryHits.length);

  resultsEl.innerHTML =
    countryHits
      .map(
        (n) => `<li data-country="${n}">
        <span class="dot country-dot"></span>
        <span class="r-name">${n}</span>
        <span class="r-tag">country</span>
        <span class="r-meta">${countryIndex.get(n).indices.size} cables</span>
      </li>`
      )
      .join('') +
    cableHits
      .map((e) => {
        const c = cables[e.ci];
        return `<li data-ci="${e.ci}">
        <span class="dot" style="background:${c.dispColor}"></span>
        <span class="r-name">${c.name}</span>
        <span class="r-meta">${c.year === YEAR_UNKNOWN ? '—' : c.year}${c.length ? ' · ' + c.length : ''}</span>
      </li>`;
      })
      .join('');
  resultsEl.hidden = countryHits.length + cableHits.length === 0;
}
function pickResult(ci) {
  resultsEl.hidden = true;
  searchInput.blur();
  showAllYears();
  selectCable(ci);
}
searchInput.addEventListener('input', () => runSearch(searchInput.value));
searchInput.addEventListener('focus', () => runSearch(searchInput.value));
function activateResult(li) {
  resultsEl.hidden = true;
  searchInput.blur();
  if (li.dataset.country) selectCountry(li.dataset.country);
  else pickResult(+li.dataset.ci);
}
searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    const first = resultsEl.querySelector('li[data-ci], li[data-country]');
    if (first) activateResult(first);
  }
});
resultsEl.addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-ci], li[data-country]');
  if (li) activateResult(li);
});
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#search-wrap')) resultsEl.hidden = true;
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (!$('tour').hidden) endTour();
    clearSelection();
    resultsEl.hidden = true;
    searchInput.blur();
    $('discover').hidden = true;
  }
  if (ev.key === '/' && document.activeElement !== searchInput) {
    ev.preventDefault();
    searchInput.focus();
  }
});

// ---------- discover drawer ----------
const CHOKEPOINTS = [
  { name: 'Egypt & the Red Sea', lat: 27.5, lng: 34, r: 7, alt: 1.1, blurb: 'Europe ↔ Asia shortcut' },
  { name: 'Strait of Malacca', lat: 2.5, lng: 101.5, r: 5, alt: 1.0, blurb: 'East Asia ↔ Indian Ocean' },
  { name: 'Luzon Strait', lat: 20.5, lng: 121, r: 4.5, alt: 1.0, blurb: 'China / HK ↔ Pacific' },
  { name: 'Strait of Gibraltar', lat: 35.9, lng: -5.5, r: 4, alt: 1.0, blurb: 'Mediterranean gateway' },
  { name: 'English Channel', lat: 50.3, lng: -1.5, r: 4, alt: 1.0, blurb: 'UK ↔ Europe crossings' },
];

const BIG_TECH = ['Google', 'Meta', 'Microsoft', 'Amazon'];

const hubRank = [...lpCables.entries()]
  .map(([id, list]) => ({ lp: lpById.get(id), n: list.length }))
  .filter((h) => h.lp)
  .sort((a, b) => b.n - a.n)
  .slice(0, 8);

const longest = [...cables.keys()]
  .filter((ci) => cables[ci].km > 0)
  .sort((a, b) => cables[b].km - cables[a].km)
  .slice(0, 8);

function drawerRow(label, meta, attrs = '') {
  return `<button class="d-row" ${attrs}><span>${label}</span><span class="d-meta">${meta}</span></button>`;
}

$('discover-body').innerHTML = `
  <button id="tour-start">✦ Start the guided tour <span class="d-meta">~3 min</span></button>

  <h4>Chokepoints</h4>
  ${CHOKEPOINTS.map((c, i) =>
    drawerRow(c.name, c.blurb, `data-choke="${i}"`)
  ).join('')}

  <h4>Busiest landing hubs</h4>
  ${hubRank.map((h) =>
    drawerRow(h.lp.name.split(',')[0], `${h.n} cables`, `data-hub="${h.lp.id}"`)
  ).join('')}

  <h4>Longest cables</h4>
  ${longest.map((ci) =>
    drawerRow(cables[ci].name, cables[ci].length, `data-cable="${ci}"`)
  ).join('')}

  <h4>Big Tech's cables</h4>
  ${BIG_TECH.map((o) => {
    const n = cables.filter((c) => (c.owners || '').includes(o)).length;
    return drawerRow(o, `${n} cables`, `data-owner="${o}"`);
  }).join('')}
`;

$('discover-btn').onclick = () => ($('discover').hidden = !$('discover').hidden);
$('discover-close').onclick = () => ($('discover').hidden = true);

function selectChokepoint(c) {
  showAllYears();
  const indices = cablesNear(c.lat, c.lng, c.r);
  selectGroup(indices, {
    title: c.name,
    subtitle: `${indices.length} cables pass through · ${c.blurb}`,
    fly: { lat: c.lat, lng: c.lng, altitude: c.alt },
  });
}

function selectOwner(owner) {
  showAllYears();
  const indices = [...cables.keys()].filter((ci) => (cables[ci].owners || '').includes(owner));
  selectGroup(indices, {
    title: `${owner}'s cables`,
    subtitle: `${indices.length} cables · co-owned or wholly owned`,
  });
}

$('discover-body').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  if (btn.id === 'tour-start') { $('discover').hidden = true; startTour(); return; }
  if (btn.dataset.choke !== undefined) selectChokepoint(CHOKEPOINTS[+btn.dataset.choke]);
  else if (btn.dataset.hub) { showAllYears(); selectHub(lpById.get(btn.dataset.hub)); }
  else if (btn.dataset.cable !== undefined) { showAllYears(); selectCable(+btn.dataset.cable); }
  else if (btn.dataset.owner) selectOwner(btn.dataset.owner);
  if (innerWidth < 900) $('discover').hidden = true;
});

// ---------- guided tour ----------
const findCable = (q) => cables.findIndex((c) => c.name.toLowerCase().includes(q));

const TOUR = [
  {
    title: 'The hidden backbone',
    text: 'Nearly all intercontinental internet traffic — not satellites, but over a million kilometres of fibre on the ocean floor. Every glowing thread is a real cable, every pulse a river of data.',
    dur: 12000, spin: true,
    run() { clearSelection(); showAllYears(); globe.pointOfView({ lat: 20, lng: -30, altitude: 2.3 }, 1400); },
  },
  {
    title: 'The transatlantic highway',
    text: 'The busiest deep-sea corridor on Earth. Cables like MAREA carry over 200 terabits per second between North America and Europe — enough to stream millions of videos at once.',
    dur: 14000, spin: false,
    run() {
      showAllYears();
      const indices = cablesNear(42, -40, 14);
      selectGroup(indices, { title: 'Transatlantic corridor', subtitle: `${indices.length} cables cross the North Atlantic` });
      globe.pointOfView({ lat: 42, lng: -40, altitude: 1.6 }, 1400);
    },
  },
  {
    title: "Egypt: the internet's chokepoint",
    text: 'The shortest path between Europe and Asia squeezes through the Suez Canal and Red Sea. A few hundred kilometres of desert coastline carry a huge share of all Europe–Asia traffic.',
    dur: 14000, spin: false,
    run() { selectChokepoint(CHOKEPOINTS[0]); },
  },
  {
    title: '2Africa: the longest cable ever built',
    text: '45,000 km — longer than the circumference of the Earth. It rings the entire African continent, built by Meta, Vodafone, Orange and partners to connect three billion people.',
    dur: 14000, spin: false,
    run() { showAllYears(); const ci = findCable('2africa'); if (ci >= 0) selectCable(ci); },
  },
  {
    title: 'Big Tech lays its own',
    text: 'Google, Meta, Microsoft and Amazon used to rent capacity. Now they build their own cables — hyperscalers fund most new transoceanic fibre laid today.',
    dur: 13000, spin: true,
    run() { selectOwner('Google'); globe.pointOfView({ lat: 10, lng: -120, altitude: 2.2 }, 1400); },
  },
  {
    title: 'A single thread: Tonga',
    text: "Some nations hang by one cable. When the 2022 Hunga Tonga volcano severed Tonga's only link, the whole country went dark for weeks — repaired by a single cable ship.",
    dur: 13000, spin: false,
    run() { showAllYears(); const ci = findCable('tonga'); if (ci >= 0) selectCable(ci); },
  },
  {
    title: 'Watch it grow: 1989 → today',
    text: 'From the first fibre systems to the planned routes of 2029. Four decades of the internet physically wiring itself around the planet.',
    dur: 21000, spin: true,
    run() {
      clearSelection();
      globe.pointOfView({ lat: 20, lng: 0, altitude: 2.4 }, 1400);
      yearInput.value = YEAR_MIN;
      updateTimeline();
      startPlay();
    },
  },
  {
    title: 'Now explore',
    text: 'Click any cable or landing station. Press / to search. Open ✦ Discover for chokepoints, hubs and records. Scrub the timeline. The whole map is real, current data.',
    dur: 12000, spin: true,
    run() { clearSelection(); showAllYears(); },
  },
];

let tourIdx = 0, tourTimer = 0;

function renderTourStop() {
  const s = TOUR[tourIdx];
  $('tour-title').textContent = s.title;
  $('tour-text').textContent = s.text;
  $('tour-dots').innerHTML = TOUR.map(
    (_, i) => `<i class="${i === tourIdx ? 'on' : ''}"></i>`
  ).join('');
  $('tour-prev').disabled = tourIdx === 0;
  tourSpin = s.spin;
  updateRotate();
  s.run();
  clearTimeout(tourTimer);
  tourTimer = setTimeout(() => {
    tourIdx < TOUR.length - 1 ? goTour(tourIdx + 1) : endTour();
  }, s.dur);
}
function goTour(i) { tourIdx = i; renderTourStop(); }
function startTour() {
  $('tour').hidden = false;
  $('hint').hidden = true;
  goTour(0);
}
function endTour() {
  clearTimeout(tourTimer);
  $('tour').hidden = true;
  $('hint').hidden = false;
  tourSpin = null;
  stopPlay();
  showAllYears();
  clearSelection();
}
$('tour-next').onclick = () => (tourIdx < TOUR.length - 1 ? goTour(tourIdx + 1) : endTour());
$('tour-prev').onclick = () => tourIdx > 0 && goTour(tourIdx - 1);
$('tour-close').onclick = endTour;

// deep links: #tour starts the guided tour, #discover opens the drawer
if (location.hash === '#tour') startTour();
else if (location.hash === '#discover') $('discover').hidden = false;
else if (location.hash === '#satellite') viewBtn.onclick();
else if (location.hash.startsWith('#country=')) {
  const q = decodeURIComponent(location.hash.slice(9)).toLowerCase();
  const name = countryNames.find((n) => n.toLowerCase() === q);
  if (name) selectCountry(name);
}

// ---------- header stats ----------
const totalKm = cables.reduce((s, c) => s + c.km, 0);
$('stat-line').textContent = `${cables.length} cables · ${Math.round(totalKm / 1000).toLocaleString()}k km · ${landingPoints.length} landings`;
updateTimeline();
}
