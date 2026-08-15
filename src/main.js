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
const [cables, landingPoints] = await Promise.all(
  ['data/cables.json', 'data/landing-points.json'].map((u) => fetch(u).then((r) => r.json()))
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
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
controls.minDistance = 115;

const bloom = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight), 0.38, 0.5, 0.3
);
globe.postProcessingComposer().addPass(bloom);

addEventListener('resize', () => globe.width(innerWidth).height(innerHeight));

// ---------- merged cable geometry (one draw call for all 724 cables) ----------
// Per-vertex: position, color, phase (arc distance for pulses), year, sel, hov
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

// ---------- landing points (one Points cloud) ----------
const lpYear = new Map(); // landing point id -> earliest cable year
for (const c of cables)
  for (const lp of c.landingPoints) {
    if (!lp.id) continue;
    lpYear.set(lp.id, Math.min(lpYear.get(lp.id) ?? Infinity, c.year));
  }

const lpPos = [], lpYears = [];
const lpById = new Map();
for (const lp of landingPoints) {
  const { x, y, z } = globe.getCoords(lp.lat, lp.lng, 0.002);
  lpPos.push(x, y, z);
  lpYears.push(lpYear.get(lp.id) ?? YEAR_UNKNOWN);
  lpById.set(lp.id, lp);
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

// ---------- picking (nearest cable to a lat/lng, via the 2° grid) ----------
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

const pickThreshold = () => Math.max(0.5, (globe.pointOfView().altitude ?? 2) * 1.1);

// ---------- selection & hover state ----------
let selectedIdx = null, hoverIdx = null;

function fillRange(arr, ci, value) {
  if (ci === null) return;
  const [start, count] = ranges[ci];
  arr.fill(value, start, start + count);
}

function setHover(ci) {
  if (ci === hoverIdx) return;
  fillRange(hovArr, hoverIdx, 0);
  fillRange(hovArr, ci, 1);
  cableGeom.attributes.aHov.needsUpdate = true;
  hoverIdx = ci;
  globeEl.classList.toggle('cable-hover', ci !== null);
}

function selectCable(ci, fly = true) {
  fillRange(selArr, selectedIdx, 0);
  selectedIdx = ci;
  if (ci === null) {
    uniforms.uSelActive.value = 0;
    globe.ringsData([]);
    $('panel').hidden = true;
    controls.autoRotate = true;
    return;
  }
  fillRange(selArr, ci, 1);
  cableGeom.attributes.aSel.needsUpdate = true;
  uniforms.uSelActive.value = 1;
  controls.autoRotate = false;

  const cable = cables[ci];
  if (fly) {
    const [lat, lng] = cable.focus;
    const altitude = Math.min(2.4, Math.max(0.5, cable.lengthDeg / 55));
    globe.pointOfView({ lat, lng, altitude }, 1100);
  }

  // radar rings on this cable's landing stations
  const ringColor = cable.dispColor;
  globe
    .ringsData(cable.landingPoints.map((lp) => lpById.get(lp.id)).filter(Boolean))
    .ringColor(() => (t) => `rgba(${hexToRgb(ringColor)},${1 - t})`)
    .ringMaxRadius(2.2)
    .ringPropagationSpeed(1.6)
    .ringRepeatPeriod(1100)
    .ringAltitude(0.003);

  showPanel(cable);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

// ---------- panel ----------
function showPanel(cable) {
  $('panel-accent').style.background = cable.dispColor;
  $('panel-name').textContent = cable.name;

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
      return `<li><b>${city}</b>, ${lp.country}</li>`;
    })
    .join('');
  $('panel-lps-wrap').style.display = cable.landingPoints.length ? '' : 'none';

  const url = $('panel-url');
  url.hidden = !cable.url;
  if (cable.url) url.href = cable.url;

  $('panel').hidden = false;
}
$('panel-close').onclick = () => selectCable(null);

// ---------- pointer interaction ----------
globe.onGlobeClick(({ lat, lng }) => {
  selectCable(nearestCable(lat, lng, pickThreshold()));
});

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
  if (selectedIdx !== null && cables[selectedIdx].year > yearMax()) selectCable(null);
}
yearInput.addEventListener('input', () => { stopPlay(); updateTimeline(); });

let playing = false, playRaf = 0;
function stopPlay() {
  playing = false;
  cancelAnimationFrame(playRaf);
  $('play').textContent = '▶';
}
$('play').onclick = () => {
  if (playing) return stopPlay();
  playing = true;
  $('play').textContent = '❚❚';
  if (+yearInput.value >= YEAR_ALL) yearInput.value = YEAR_MIN;
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
};

// ---------- search ----------
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
  const hits = searchIndex
    .filter((e) => e.hay.includes(q))
    .sort((a, b) => (b.name.includes(q) ? 1 : 0) - (a.name.includes(q) ? 1 : 0))
    .slice(0, 12);
  resultsEl.innerHTML = hits
    .map((e) => {
      const c = cables[e.ci];
      return `<li data-ci="${e.ci}">
        <span class="dot" style="background:${c.dispColor}"></span>
        <span class="r-name">${c.name}</span>
        <span class="r-meta">${c.year === YEAR_UNKNOWN ? '—' : c.year}${c.length ? ' · ' + c.length : ''}</span>
      </li>`;
    })
    .join('');
  resultsEl.hidden = hits.length === 0;
}
searchInput.addEventListener('input', () => runSearch(searchInput.value));
searchInput.addEventListener('focus', () => runSearch(searchInput.value));
resultsEl.addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-ci]');
  if (!li) return;
  resultsEl.hidden = true;
  searchInput.blur();
  yearInput.value = YEAR_ALL; // make sure it's visible
  updateTimeline();
  selectCable(+li.dataset.ci);
});
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#search-wrap')) resultsEl.hidden = true;
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { selectCable(null); resultsEl.hidden = true; searchInput.blur(); }
  if (ev.key === '/' && document.activeElement !== searchInput) {
    ev.preventDefault();
    searchInput.focus();
  }
});

// ---------- header stats ----------
const totalKm = cables.reduce((s, c) => s + (parseInt((c.length || '').replace(/,/g, '')) || 0), 0);
$('stat-line').textContent = `${cables.length} cables · ${Math.round(totalKm / 1000).toLocaleString()}k km · ${landingPoints.length} landings`;
updateTimeline();
}
