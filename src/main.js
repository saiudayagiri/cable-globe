import Globe from 'globe.gl';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import TOUR_SCRIPT from './tour.json';

const YEAR_MIN = 1989;
const YEAR_ALL = 2030; // slider max = "All years"
const YEAR_UNKNOWN = 2031; // cables with no RFS year only show on "All"
const CABLE_ALT = 0.004;
const PULSE_SPACING_DEG = 14; // one light packet every ~14° of arc

const $ = (id) => document.getElementById(id);

main().catch((err) => console.error(err));

async function main() {
const [cables, landingPoints, borders, places] = await Promise.all(
  ['data/cables.json', 'data/landing-points.json', 'data/borders.json', 'data/places.json'].map(
    (u) => fetch(u).then((r) => r.json())
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

// ---------- country & city labels on the globe ----------
let labelsOn = true, lastLabelZoom = -99;
const labelData = [
  ...places.countries.map((p) => ({
    lat: p.lat, lng: p.lng, text: p.n.toUpperCase(), z: p.z, r: p.r ?? 0, city: false,
  })),
  ...places.cities
    .filter((p) => (p.r ?? 999) < 400)
    .map((p) => ({ lat: p.lat, lng: p.lng, text: p.n, z: p.z, r: p.r ?? 0, city: true })),
];

function updateLabels(force = false) {
  const alt = globe.pointOfView().altitude ?? 2;
  const zoomEq = Math.log2(4.5 / Math.max(alt, 0.02)); // same scale as the 2D map
  if (!force && Math.abs(zoomEq - lastLabelZoom) < 0.25) return;
  lastLabelZoom = zoomEq;
  if (!labelsOn) { globe.labelsData([]); return; }
  const visible = labelData
    .filter((l) => zoomEq + 0.9 >= l.z) // globe has no label collisions — show a bucket early
    .sort((a, b) => a.r - b.r)
    .slice(0, 260);
  globe
    .labelsData(visible)
    .labelLat((d) => d.lat)
    .labelLng((d) => d.lng)
    .labelText((d) => d.text)
    .labelSize((d) => (d.city ? alt * 0.55 + 0.08 : alt * 0.85 + 0.15))
    .labelColor((d) => (d.city ? 'rgba(255,214,170,0.75)' : 'rgba(168,184,206,0.62)'))
    .labelDotRadius((d) => (d.city ? Math.max(0.06, alt * 0.05) : 0))
    .labelAltitude(0.008)
    .labelResolution(2)
    .labelsTransitionDuration(0);
}
controls.addEventListener('change', () => updateLabels());
updateLabels(true);

const labelsBtn = $('ctl-labels');
labelsBtn.onclick = () => {
  labelsOn = !labelsOn;
  labelsBtn.classList.toggle('on', labelsOn);
  updateLabels(true);
};

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

// ---------- satellites: real CelesTrak elements, Kepler-propagated ----------
// Positions are propagated from each satellite's epoch and aligned with real
// Earth rotation (GMST), so GEO sats sit over their true longitudes and the
// ISS is where it actually is. Time runs 60x so orbits are visible.
const SAT_TIME_SCALE = 60;
const EARTH_ROT = (2 * Math.PI) / 1436.068; // rad per sidereal minute
let satsOn = false, satsPref = false, satParams = null, satMeta = null, satPosAttr = null;
let selectedSat = null, orbitLine = null, suppressGlobeClickUntil = 0;
const satsGroup = new THREE.Group();
satsGroup.visible = false;
globe.scene().add(satsGroup);
const activeBeams = [];
let lastBeam = 0;

// scene basis for ECEF axes: x -> (0°N,0°E), y -> (0°N,90°E), z -> north pole
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
{
  const a = globe.getCoords(0, 0, 0), b = globe.getCoords(0, 90, 0), c = globe.getCoords(90, 0, 0);
  _bx.set(a.x, a.y, a.z).normalize();
  _by.set(b.x, b.y, b.z).normalize();
  _bz.set(c.x, c.y, c.z).normalize();
}
// GMST at page load (radians)
const _d2000Now = Date.now() / 86400000 + 2440587.5 - 2451545.0;
const GMST0 = (((280.46061837 + 360.98564736629 * _d2000Now) % 360) * Math.PI) / 180;

// a tiny drawn satellite (solar wings + body + dish) so it reads as a
// spacecraft, not another star
function satTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.translate(32, 34);
  x.rotate(-Math.PI / 5);
  // solar panel wings
  x.fillStyle = '#6db8ff';
  x.fillRect(-30, -7, 21, 14);
  x.fillRect(9, -7, 21, 14);
  x.strokeStyle = 'rgba(4,10,22,0.95)';
  x.lineWidth = 2;
  for (const px of [-24, -17, -10, 15, 22]) {
    x.beginPath();
    x.moveTo(px, -7);
    x.lineTo(px, 7);
    x.stroke();
  }
  x.strokeRect(-30, -7, 21, 14);
  x.strokeRect(9, -7, 21, 14);
  // body
  x.fillStyle = '#f4f8ff';
  x.fillRect(-8, -10, 16, 20);
  x.strokeRect(-8, -10, 16, 20);
  // dish
  x.fillStyle = '#ffd479';
  x.beginPath();
  x.arc(0, -14, 5, 0, Math.PI * 2);
  x.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

async function initSats() {
  const data = await fetch('data/satellites.json').then((r) => r.json());
  satMeta = data;
  const D = Math.PI / 180;
  satParams = data.map((s) => ({
    // compress display altitude so LEO, MEO and GEO all fit in frame
    r: 100 * (1 + 0.5 * Math.pow(s.a / 6371, 0.6)),
    i: s.i * D,
    o: s.o * D,
    w: s.w * D,
    e: s.e,
    m0: s.m * D,
    n: (2 * Math.PI) / s.p, // rad per minute
    dt0: (_d2000Now - s.ep) * 1440, // minutes from element epoch to page load
    y: parseInt(s.d) || 0, // launch year from intl designator — timeline filter
  }));
  satPosAttr = new THREE.BufferAttribute(new Float32Array(satParams.length * 3), 3);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', satPosAttr);
  satsGroup.add(
    new THREE.Points(
      geom,
      new THREE.PointsMaterial({
        map: satTexture(),
        size: 13,
        sizeAttenuation: false,
        transparent: true,
        alphaTest: 0.05,
        depthWrite: false,
      })
    )
  );
  // orbit path shown for the selected satellite
  const orbitGeom = new THREE.BufferGeometry();
  orbitGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(128 * 3), 3));
  orbitLine = new THREE.LineLoop(
    orbitGeom,
    new THREE.LineBasicMaterial({
      color: 0x9fd8ff,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  orbitLine.visible = false;
  satsGroup.add(orbitLine);
}

// ECEF unit vector -> scene position (writes into out, scaled by r)
function ecefToScene(x, y, z, r, out) {
  return out
    .set(0, 0, 0)
    .addScaledVector(_bx, x * r)
    .addScaledVector(_by, y * r)
    .addScaledVector(_bz, z * r);
}

// position of satellite k at visual time tMin, written into out
function computeSatPos(k, tMin, out, nuOverride = null) {
  const s = satParams[k];
  let nu;
  if (nuOverride === null) {
    const M = s.m0 + s.n * (s.dt0 + tMin);
    let E = M;
    for (let j = 0; j < 4; j++)
      E = E - (E - s.e * Math.sin(E) - M) / (1 - s.e * Math.cos(E));
    nu = 2 * Math.atan2(
      Math.sqrt(1 + s.e) * Math.sin(E / 2),
      Math.sqrt(1 - s.e) * Math.cos(E / 2)
    );
  } else nu = nuOverride;
  const u = s.w + nu;
  const cu = Math.cos(u), su = Math.sin(u);
  const cO = Math.cos(s.o), sO = Math.sin(s.o);
  const ci = Math.cos(s.i), si = Math.sin(s.i);
  // ECI unit vector
  const xi = cO * cu - sO * su * ci;
  const yi = sO * cu + cO * su * ci;
  const zi = su * si;
  // rotate by Earth angle -> ECEF
  const th = GMST0 + EARTH_ROT * tMin;
  const ct = Math.cos(th), st = Math.sin(th);
  return ecefToScene(xi * ct + yi * st, -xi * st + yi * ct, zi, s.r, out);
}

async function setSats(on) {
  if (on && !satParams) await initSats();
  satsOn = on;
  satsGroup.visible = on;
}
const satsBtn = $('ctl-sats');
satsBtn.onclick = async () => {
  satsPref = !satsPref;
  satsBtn.classList.toggle('on', satsPref);
  await setSats(satsPref);
  updateTimeline(); // refresh "· N sats" in the year readout
};

function satPos(k, out) {
  return out.set(satPosAttr.getX(k), satPosAttr.getY(k), satPosAttr.getZ(k));
}

function spawnBeam() {
  const ymax = yearMax();
  let k = -1;
  for (let tries = 0; tries < 12; tries++) {
    const c = Math.floor(Math.random() * satParams.length);
    if (satParams[c].y <= ymax) { k = c; break; }
  }
  if (k === -1) return;
  const lp = landingPoints[Math.floor(Math.random() * landingPoints.length)];
  const g = globe.getCoords(lp.lat, lp.lng, 0.005);
  const ground = new THREE.Vector3(g.x, g.y, g.z);
  const lineGeom = new THREE.BufferGeometry().setFromPoints([ground, ground.clone()]);
  const line = new THREE.Line(
    lineGeom,
    new THREE.LineBasicMaterial({
      color: 0x9fd8ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  const dotGeom = new THREE.BufferGeometry();
  dotGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  const dot = new THREE.Points(
    dotGeom,
    new THREE.PointsMaterial({
      color: 0xffffff,
      size: 3.5,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  satsGroup.add(line, dot);
  activeBeams.push({ k, line, dot, ground, t0: performance.now() / 1000, up: Math.random() < 0.5 });
}

const _satV = new THREE.Vector3(), _beamV = new THREE.Vector3(), _orbV = new THREE.Vector3();
function updateSats(tSec) {
  const tMin = (tSec * SAT_TIME_SCALE) / 60;
  const ymax = yearMax();
  for (let k = 0; k < satParams.length; k++) {
    if (satParams[k].y > ymax) {
      satPosAttr.setXYZ(k, 0, 0, 0); // parked inside the globe = invisible
      continue;
    }
    computeSatPos(k, tMin, _satV);
    satPosAttr.setXYZ(k, _satV.x, _satV.y, _satV.z);
  }
  satPosAttr.needsUpdate = true;

  // orbit path of the selected satellite (recomputed as Earth turns)
  if (selectedSat !== null && orbitLine) {
    const attr = orbitLine.geometry.attributes.position;
    for (let j = 0; j < 128; j++) {
      computeSatPos(selectedSat, tMin, _orbV, (j / 128) * 2 * Math.PI);
      attr.setXYZ(j, _orbV.x, _orbV.y, _orbV.z);
    }
    attr.needsUpdate = true;
  }

  // occasional light traveling between ground and a satellite
  if (tSec - lastBeam > 2.4 && activeBeams.length < 2) {
    lastBeam = tSec;
    spawnBeam();
  }
  const now = performance.now() / 1000;
  for (let i = activeBeams.length - 1; i >= 0; i--) {
    const b = activeBeams[i];
    const u = (now - b.t0) / 1.5;
    if (u >= 1) {
      satsGroup.remove(b.line, b.dot);
      b.line.geometry.dispose();
      b.dot.geometry.dispose();
      activeBeams.splice(i, 1);
      continue;
    }
    satPos(b.k, _satV);
    b.line.geometry.setFromPoints([b.ground, _satV]);
    b.line.material.opacity = Math.sin(Math.PI * u) * 0.3;
    _beamV.copy(b.ground).lerp(_satV, b.up ? u : 1 - u);
    b.dot.geometry.attributes.position.setXYZ(0, _beamV.x, _beamV.y, _beamV.z);
    b.dot.geometry.attributes.position.needsUpdate = true;
    b.dot.material.opacity = Math.sin(Math.PI * u);
  }
}

// screen-space picking of satellites (with globe occlusion test)
const _pickV = new THREE.Vector3(), _camV = new THREE.Vector3(), _rayV = new THREE.Vector3(), _occV = new THREE.Vector3();
function pickSat(clientX, clientY) {
  if (!satsOn || !satParams) return null;
  const cam = globe.camera();
  cam.getWorldPosition(_camV);
  const rect = globeEl.getBoundingClientRect();
  let best = null, bestD2 = 14 * 14;
  const ymax = yearMax();
  for (let k = 0; k < satParams.length; k++) {
    if (satParams[k].y > ymax) continue;
    _pickV.set(satPosAttr.getX(k), satPosAttr.getY(k), satPosAttr.getZ(k));
    // occluded by the globe? (closest approach of cam->sat ray to Earth's center)
    _rayV.copy(_pickV).sub(_camV);
    const dist = _rayV.length();
    _rayV.divideScalar(dist);
    const tc = -_camV.dot(_rayV);
    if (tc > 0 && tc < dist) {
      _occV.copy(_camV).addScaledVector(_rayV, tc);
      if (_occV.lengthSq() < 100 * 100) continue;
    }
    _pickV.project(cam);
    if (_pickV.z > 1) continue;
    const px = rect.left + (_pickV.x * 0.5 + 0.5) * rect.width;
    const py = rect.top + (-_pickV.y * 0.5 + 0.5) * rect.height;
    const d2 = (px - clientX) ** 2 + (py - clientY) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = k; }
  }
  return best;
}

function selectSatellite(k) {
  clearSelection();
  selectedSat = k;
  if (orbitLine) orbitLine.visible = true;
  renderSatPanel(satMeta[k]);
}

function renderSatPanel(s) {
  panelBase(s.n);
  $('panel-accent').style.background = '#9fd8ff';
  $('panel-badges').innerHTML = `<span class="badge">${s.g}</span><span class="badge">NORAD ${s.id}</span>`;
  const orbitsPerDay = (1440 / s.p).toFixed(1);
  const period = s.p >= 120 ? `${(s.p / 60).toFixed(1)} h` : `${Math.round(s.p)} min`;
  const stats = [
    ['Altitude', `${s.a.toLocaleString()} km`],
    ['Period', period],
    ['Inclination', `${s.i.toFixed(1)}°`],
    ['Orbits / day', orbitsPerDay],
  ];
  $('panel-stats').innerHTML = stats
    .map(([k2, v]) => `<div><dt>${k2}</dt><dd>${v}</dd></div>`)
    .join('');
  const launchYear = /^(\d{4})/.exec(s.d)?.[1];
  $('panel-owners').innerHTML =
    (launchYear ? `<span class="chip">Launched ${launchYear}</span>` : '') +
    `<span class="chip">${s.d}</span>` +
    `<span class="chip">live CelesTrak elements · position approximate</span>`;
}

// pulse clock
(function tick(t) {
  uniforms.uTime.value = t / 1000;
  if (satsOn && satParams) updateSats(t / 1000);
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
  viewBtn.textContent = dayView ? '🌙 night' : '☀️ day';
};

const bordersBtn = $('ctl-borders');
bordersBtn.onclick = () => {
  borderLines.visible = !borderLines.visible;
  bordersBtn.classList.toggle('on', borderLines.visible);
};

// ---------- 2D map toggle (module lazy-loads on first use) ----------
let map2dApi = null, is2D = false;
const dimBtn = $('ctl-dim');

// route camera flights to whichever view is active
function flyView(pov, ms = 1100) {
  if (is2D && map2dApi) map2dApi.flyTo(pov, ms);
  else globe.pointOfView(pov, ms);
}

function sync2DSelection() {
  map2dApi?.setSelection(selSet.size ? [...selSet].map((ci) => cables[ci].id) : null);
}

async function toggle2D() {
  if (!is2D) {
    if (!map2dApi) {
      dimBtn.disabled = true;
      dimBtn.textContent = '… loading';
      // map needs a laid-out container to finish its first render
      $('map2d').hidden = false;
      $('map2d').style.visibility = 'hidden';
      try {
        const { createMap2D } = await import('./map2d.js');
        map2dApi = await createMap2D({
          container: $('map2d'),
          cables,
          lps: landingPoints.map((lp) => ({ ...lp, year: lpYear.get(lp.id) ?? YEAR_UNKNOWN })),
          borders,
          callbacks: {
            onCable: (ci) => selectCable(ci, false),
            onHub: (id) => { const lp = lpById.get(id); if (lp) selectHub(lp, false); },
            onClear: () => clearSelection(),
            onHover: (ci, pt) => {
              if (ci !== null && pt) {
                const c = cables[ci];
                tooltip.innerHTML = `${c.name} <span class="t-meta">${
                  c.year === YEAR_UNKNOWN ? '' : c.year
                }${c.length ? ' · ' + c.length : ''}</span>`;
                tooltip.style.left = `${Math.min(pt.x + 14, innerWidth - 220)}px`;
                tooltip.style.top = `${pt.y + 14}px`;
                tooltip.hidden = false;
              } else tooltip.hidden = true;
            },
          },
        });
      } catch (err) {
        console.error(err);
        $('map2d').hidden = true;
        $('map2d').style.visibility = '';
        dimBtn.textContent = '🗺 2D map';
        dimBtn.disabled = false;
        return;
      }
      dimBtn.disabled = false;
    }
    is2D = true;
    map2dApi.setYear(yearMax());
    sync2DSelection();
    $('map2d').hidden = false;
    $('map2d').style.visibility = '';
    map2dApi.show(globe.pointOfView());
    globeEl.style.display = 'none';
    globe.pauseAnimation();
    dimBtn.textContent = '🌍 3D globe';
  } else {
    is2D = false;
    const pov = map2dApi.hide();
    $('map2d').hidden = true;
    globeEl.style.display = '';
    globe.resumeAnimation();
    globe.pointOfView(pov, 0);
    dimBtn.textContent = '🗺 2D map';
    tooltip.hidden = true;
  }
}
dimBtn.onclick = toggle2D;

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
  sync2DSelection();
}

function clearSelection() {
  selSet.clear();
  applySel();
  globe.ringsData([]);
  map2dApi?.setLpHighlight(null);
  selectedSat = null;
  if (orbitLine) orbitLine.visible = false;
  if (routeActive) {
    routeActive = false;
    globe.arcsData([]);
  }
  $('panel').hidden = true;
}

function ringOn(points, color) {
  map2dApi?.setLpHighlight(points.map((p) => p.id));
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
    flyView({ lat, lng, altitude });
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
  if (fly) flyView(fly);
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
function handleGlobePoint(lat, lng) {
  if (performance.now() < suppressGlobeClickUntil) return; // satellite click won
  const thr = pickThreshold();
  const lp = nearestLandingPoint(lat, lng, Math.min(0.45, thr * 0.4));
  if (lp && (lpCables.get(lp.id)?.length ?? 0) > 0) return selectHub(lp, false);
  const ci = nearestCable(lat, lng, thr);
  ci === null ? clearSelection() : selectCable(ci, false);
}
globe.onGlobeClick(({ lat, lng }) => handleGlobePoint(lat, lng));
// label sprites sit in front of the globe — forward their clicks
globe.onLabelClick((l, ev) => {
  const c = globe.toGlobeCoords(ev.clientX, ev.clientY);
  if (c) handleGlobePoint(c.lat, c.lng);
});

// satellite clicks (satellites float off the globe, so onGlobeClick misses them)
let downX = 0, downY = 0;
globeEl.addEventListener('pointerdown', (ev) => { downX = ev.clientX; downY = ev.clientY; });
globeEl.addEventListener('click', (ev) => {
  if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 6) return; // drag, not click
  const k = pickSat(ev.clientX, ev.clientY);
  if (k !== null) {
    suppressGlobeClickUntil = performance.now() + 200;
    selectSatellite(k);
  }
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
    // satellites first — they float above the globe
    const k = pickSat(ev.clientX, ev.clientY);
    if (k !== null) {
      setHover(null);
      const s = satMeta[k];
      tooltip.innerHTML = `${s.n} <span class="t-meta">${s.g} · ${s.a.toLocaleString()} km</span>`;
      tooltip.style.left = `${Math.min(ev.clientX + 14, innerWidth - 220)}px`;
      tooltip.style.top = `${ev.clientY + 14}px`;
      tooltip.hidden = false;
      globeEl.classList.add('cable-hover');
      return;
    }
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
  map2dApi?.setYear(yearMax());
  const all = v >= YEAR_ALL;
  $('year-label').textContent = all ? 'All years' : v;
  const n = all ? cables.length : cables.filter((c) => c.year <= v).length;
  let satNote = '';
  if (satsOn && satMeta) {
    const ns = all ? satMeta.length : satParams.filter((s) => s.y <= v).length;
    satNote = ` · ${ns} sats`;
  }
  $('year-count').textContent = `${n} cables${satNote}`;
  if (selSet.size === 1) {
    const [only] = selSet;
    if (cables[only].year > yearMax()) clearSelection();
  }
  if (selectedSat !== null && satParams[selectedSat].y > yearMax()) clearSelection();
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
    if (!$('route-wrap').hidden) closeRoute();
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

// ---------- city-to-city routes over the real cable graph ----------
const DR = Math.PI / 180;
function haversine(a, b) {
  const h =
    Math.sin(((b.lat - a.lat) * DR) / 2) ** 2 +
    Math.cos(a.lat * DR) * Math.cos(b.lat * DR) * Math.sin(((b.lng - a.lng) * DR) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

let routeGraph = null;
function buildRouteGraph() {
  const adj = new Map();
  const add = (a, b, w, cable) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, w, cable });
  };
  // any two landing stations on the same cable are connected by that cable
  cables.forEach((c, ci) => {
    const ids = c.landingPoints.map((lp) => lp.id).filter((id) => id && lpById.has(id));
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const w = haversine(lpById.get(ids[i]), lpById.get(ids[j])) + 60; // +hop cost
        add(ids[i], ids[j], w, ci);
        add(ids[j], ids[i], w, ci);
      }
  });
  // short overland links between nearby stations (crossing isthmuses, backhaul)
  for (const a of landingPoints) {
    const near = [];
    for (const b of landingPoints) {
      if (a === b) continue;
      const d = haversine(a, b);
      if (d < 1000) near.push([d, b.id]);
    }
    near.sort((x, y) => x[0] - y[0]).slice(0, 6)
      .forEach(([d, id]) => add(a.id, id, d * 3 + 120, null));
  }
  return adj;
}

function nearestStations(pt, count, maxKm) {
  return landingPoints
    .map((lp) => ({ id: lp.id, d: haversine(pt, lp) }))
    .filter((x) => x.d < maxKm)
    .sort((x, y) => x.d - y.d)
    .slice(0, count);
}

function shortestRoute(from, to) {
  routeGraph ??= buildRouteGraph();
  const starts = nearestStations(from, 4, 4000);
  const ends = nearestStations(to, 4, 4000);
  if (!starts.length || !ends.length) return null;
  const endW = new Map(ends.map((e) => [e.id, e.d * 3]));

  const dist = new Map(), prev = new Map(), done = new Set();
  for (const s of starts) {
    dist.set(s.id, s.d * 3);
    prev.set(s.id, null);
  }
  while (true) {
    let u = null, du = Infinity;
    for (const [id, d] of dist) if (!done.has(id) && d < du) { u = id; du = d; }
    if (u === null) break;
    done.add(u);
    for (const e of routeGraph.get(u) ?? []) {
      const nd = du + e.w;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: u, cable: e.cable });
      }
    }
  }

  let best = null, bestCost = Infinity;
  for (const [id, w] of endW) {
    const d = dist.get(id);
    if (d !== undefined && d + w < bestCost) { bestCost = d + w; best = id; }
  }
  if (best === null) return null;

  const hops = [];
  let cur = best;
  while (prev.get(cur)) {
    const p = prev.get(cur);
    hops.unshift({ a: p.from, b: cur, cable: p.cable });
    cur = p.from;
  }
  return { firstLp: cur, lastLp: best, hops };
}

let routeActive = false;
function showRoute(from, to) {
  const res = shortestRoute(from, to);
  if (!res) {
    renderGroupPanel(`${from.name} ⇄ ${to.name}`, 'no cable route found', []);
    return;
  }
  routeActive = true;

  // highlight the cables the route rides
  selSet.clear();
  for (const h of res.hops) if (h.cable !== null) selSet.add(h.cable);
  applySel();
  globe.ringsData([]);

  // animated arcs: overland legs gold, cable legs cyan
  const arcs = [];
  const leg = (p, q, type) =>
    arcs.push({ slat: p.lat, slng: p.lng, elat: q.lat, elng: q.lng, type });
  const first = lpById.get(res.firstLp), last = lpById.get(res.lastLp);
  if (haversine(from, first) > 30) leg(from, first, 'land');
  for (const h of res.hops)
    leg(lpById.get(h.a), lpById.get(h.b), h.cable === null ? 'land' : 'sea');
  if (haversine(to, last) > 30) leg(last, to, 'land');

  globe
    .arcsData(arcs)
    .arcStartLat((d) => d.slat)
    .arcStartLng((d) => d.slng)
    .arcEndLat((d) => d.elat)
    .arcEndLng((d) => d.elng)
    .arcColor((d) => (d.type === 'land' ? 'rgba(255,212,121,0.9)' : 'rgba(110,231,255,0.95)'))
    .arcAltitudeAutoScale(0.25)
    .arcStroke(0.55)
    .arcDashLength(0.35)
    .arcDashGap(0.18)
    .arcDashAnimateTime(1500)
    .arcsTransitionDuration(0);

  // camera: frame the whole route
  let lng1 = from.lng, lng2 = to.lng;
  if (Math.abs(lng2 - lng1) > 180) { if (lng1 < 0) lng1 += 360; if (lng2 < 0) lng2 += 360; }
  let midLng = (lng1 + lng2) / 2;
  if (midLng > 180) midLng -= 360;
  const span = haversine(from, to);
  flyView({
    lat: (from.lat + to.lat) / 2,
    lng: midLng,
    altitude: Math.min(2.5, Math.max(0.6, span / 5500)),
  });

  renderRoutePanel(from, to, res);
}

function renderRoutePanel(from, to, res) {
  const cityName = (p) => p.name.split(',')[0];
  panelBase(`${cityName(from)} ⇄ ${cityName(to)}`);
  $('panel-accent').style.background =
    'linear-gradient(90deg, #ffd479, #6ee7ff)';

  // merge consecutive hops on the same cable for display
  const legs = [];
  for (const h of res.hops) {
    const last = legs[legs.length - 1];
    if (last && last.cable === h.cable) last.b = h.b;
    else legs.push({ ...h });
  }
  const totalKm = Math.round(
    res.hops.reduce((s, h) => s + haversine(lpById.get(h.a), lpById.get(h.b)), 0)
  );
  $('panel-badges').innerHTML =
    `<span class="badge">~${totalKm.toLocaleString()} km undersea</span>` +
    `<span class="badge">${legs.filter((l) => l.cable !== null).length} cable${legs.filter((l) => l.cable !== null).length === 1 ? '' : 's'}</span>`;

  const list = $('panel-list');
  const city = (id) => lpById.get(id).name.split(',')[0];
  list.innerHTML = legs
    .map((l) => {
      if (l.cable === null)
        return `<li><span class="dot" style="background:#ffd479"></span>
          <span class="r-name">${city(l.a)} ⇢ ${city(l.b)} <span class="r-meta">overland</span></span></li>`;
      const c = cables[l.cable];
      return `<li data-ci="${l.cable}">
        <span class="dot" style="background:${c.dispColor}"></span>
        <span class="r-name">${city(l.a)} ⇢ ${city(l.b)}<br><span class="r-meta">via ${c.name}</span></span>
      </li>`;
    })
    .join('');
  list.hidden = false;
  $('panel-owners').innerHTML =
    `<span class="chip">illustrative — real cables, operator routing varies</span>`;
}

// ----- route UI -----
const routeWrap = $('route-wrap');
let placeIndex = null;
let routeFrom = null, routeTo = null;

function ensurePlaceIndex() {
  placeIndex ??= [
    ...places.cities.map((c) => ({ name: c.n, sub: 'city', lat: c.lat, lng: c.lng })),
    ...landingPoints.map((lp) => ({ name: lp.name, sub: 'landing point', lat: lp.lat, lng: lp.lng })),
  ];
}

function openRoute() {
  routeWrap.hidden = false;
  document.body.classList.add('routing');
  ensurePlaceIndex();
  $('route-a').focus();
}
function closeRoute() {
  routeWrap.hidden = true;
  document.body.classList.remove('routing');
  routeFrom = routeTo = null;
  $('route-a').value = $('route-b').value = '';
  if (routeActive) {
    routeActive = false;
    globe.arcsData([]);
    clearSelection();
  }
}
$('ctl-route').onclick = () => (routeWrap.hidden ? openRoute() : closeRoute());
$('route-close').onclick = closeRoute;

function wireRouteInput(inputId, resId, setter) {
  const input = $(inputId), res = $(resId);
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { res.hidden = true; return; }
    ensurePlaceIndex();
    const hits = placeIndex
      .filter((p) => p.name.toLowerCase().includes(q))
      .sort((a, b) => (b.sub === 'city' ? 1 : 0) - (a.sub === 'city' ? 1 : 0))
      .slice(0, 8);
    res.innerHTML = hits
      .map((p, i) => `<li data-i="${i}"><span>${p.name}</span><span class="rr-sub">${p.sub}</span></li>`)
      .join('');
    res.hidden = hits.length === 0;
    res._hits = hits;
  });
  res.addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-i]');
    if (!li) return;
    const p = res._hits[+li.dataset.i];
    setter(p);
    input.value = p.name;
    res.hidden = true;
    if (routeFrom && routeTo) {
      showAllYears();
      showRoute(routeFrom, routeTo);
    }
  });
}
wireRouteInput('route-a', 'route-a-res', (p) => (routeFrom = p));
wireRouteInput('route-b', 'route-b-res', (p) => (routeTo = p));

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

const TOUR_RUNS = [
  () => {
    clearSelection();
    showAllYears();
    setSats(true); // "you'd think satellites…" — show them for the reveal
    globe.pointOfView({ lat: 20, lng: -30, altitude: 2.3 }, 1400);
  },
  () => {
    setSats(satsPref); // …no. Back to the cables.
    showAllYears();
    const indices = cablesNear(42, -40, 14);
    selectGroup(indices, { title: 'Transatlantic corridor', subtitle: `${indices.length} cables cross the North Atlantic` });
    globe.pointOfView({ lat: 42, lng: -40, altitude: 1.6 }, 1400);
  },
  () => { selectChokepoint(CHOKEPOINTS[0]); },
  () => { showAllYears(); const ci = findCable('2africa'); if (ci >= 0) selectCable(ci); },
  () => { selectOwner('Google'); globe.pointOfView({ lat: 10, lng: -120, altitude: 2.2 }, 1400); },
  () => { showAllYears(); const ci = findCable('tonga'); if (ci >= 0) selectCable(ci); },
  () => {
    clearSelection();
    globe.pointOfView({ lat: 20, lng: 0, altitude: 2.4 }, 1400);
    yearInput.value = YEAR_MIN;
    updateTimeline();
    startPlay();
  },
  () => { clearSelection(); showAllYears(); },
];
const TOUR = TOUR_SCRIPT.map((s, i) => ({ ...s, run: TOUR_RUNS[i] }));

let tourIdx = 0, tourTimer = 0, tourSeq = 0;

// ----- narration: pre-generated neural TTS MP3s, speech synthesis as fallback -----
const synth = window.speechSynthesis ?? null;
let narrVoice = null;
function pickVoice() {
  const vs = synth?.getVoices() ?? [];
  narrVoice =
    vs.find((v) => /Samantha|Google US English|en.*Natural/i.test(v.name)) ||
    vs.find((v) => v.lang?.startsWith('en')) ||
    vs[0] || null;
}
pickVoice();
synth?.addEventListener?.('voiceschanged', pickVoice);

let tourAudio = null, preloadAudio = null;
function stopNarration() {
  if (tourAudio) {
    tourAudio.onended = tourAudio.onerror = null;
    tourAudio.pause();
    tourAudio = null;
  }
  synth?.cancel();
}

// ----- ambient bed: a soft synthesized drone under the narration -----
let amb = null;
function startAmbient() {
  if (amb || !voiceOn) return;
  try {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    lp.connect(master);
    for (const [freq, vol] of [[55, 0.5], [55.4, 0.5], [110.2, 0.16], [164.9, 0.07]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = vol;
      o.connect(g);
      g.connect(lp);
      o.start();
    }
    const lfo = ctx.createOscillator(); // slow filter drift = "breathing" ocean
    lfo.frequency.value = 0.045;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 60;
    lfo.connect(lfoG);
    lfoG.connect(lp.frequency);
    lfo.start();
    master.gain.linearRampToValueAtTime(0.045, ctx.currentTime + 4);
    amb = {
      stop() {
        master.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.5);
        setTimeout(() => ctx.close(), 1800);
      },
    };
  } catch { /* no WebAudio — fine */ }
}
function stopAmbient() {
  amb?.stop();
  amb = null;
}

let voiceOn = localStorage.getItem('tourVoice') !== 'off';
const voiceBtn = $('tour-voice');
const syncVoiceBtn = () => {
  voiceBtn.textContent = voiceOn ? '🔊' : '🔇';
  voiceBtn.title = voiceOn ? 'Mute narration' : 'Unmute narration';
};
syncVoiceBtn();
voiceBtn.onclick = () => {
  voiceOn = !voiceOn;
  localStorage.setItem('tourVoice', voiceOn ? 'on' : 'off');
  syncVoiceBtn();
  stopNarration();
  if (voiceOn) {
    startAmbient();
    if (!$('tour').hidden) renderTourStop(); // restart current stop with voice
  } else stopAmbient();
};

function renderTourStop() {
  const s = TOUR[tourIdx];
  const seq = ++tourSeq;
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
  stopNarration();
  const t0 = performance.now();
  const goNext = () => {
    if (seq !== tourSeq) return;
    tourIdx < TOUR.length - 1 ? goTour(tourIdx + 1) : endTour();
  };
  // advance when narration ends AND the visual has had its minimum time
  const afterNarration = () => {
    if (seq !== tourSeq) return;
    clearTimeout(tourTimer);
    tourTimer = setTimeout(goNext, Math.max(800, s.dur - (performance.now() - t0)));
  };
  const speakFallback = () => {
    if (seq !== tourSeq) return;
    if (synth && narrVoice) {
      const u = new SpeechSynthesisUtterance(`${s.title}. ${s.text}`);
      u.voice = narrVoice;
      u.rate = 1.02;
      u.onend = afterNarration;
      u.onerror = afterNarration;
      synth.speak(u);
    } else afterNarration();
  };

  if (voiceOn) {
    const a = new Audio(`audio/tour-${tourIdx}.mp3`);
    tourAudio = a;
    a.onended = afterNarration;
    a.onerror = speakFallback;
    tourTimer = setTimeout(goNext, s.dur + 25000); // safety net
    a.play().catch(speakFallback); // autoplay blocked (deep link) or missing file
    if (tourIdx < TOUR.length - 1) {
      preloadAudio = new Audio();
      preloadAudio.preload = 'auto';
      preloadAudio.src = `audio/tour-${tourIdx + 1}.mp3`;
    }
  } else {
    tourTimer = setTimeout(goNext, s.dur);
  }
}
function goTour(i) { tourIdx = i; renderTourStop(); }
async function startTour() {
  if (is2D) await toggle2D(); // tour cinematics live on the globe
  $('tour').hidden = false;
  $('hint').hidden = true;
  startAmbient();
  goTour(0);
}
function endTour() {
  tourSeq++; // invalidate pending narration/timer callbacks
  clearTimeout(tourTimer);
  stopNarration();
  stopAmbient();
  $('tour').hidden = true;
  $('hint').hidden = false;
  tourSpin = null;
  stopPlay();
  showAllYears();
  clearSelection();
  setSats(satsPref);
}
$('tour-next').onclick = () => (tourIdx < TOUR.length - 1 ? goTour(tourIdx + 1) : endTour());
$('tour-prev').onclick = () => tourIdx > 0 && goTour(tourIdx - 1);
$('tour-close').onclick = endTour;

// deep links: #tour starts the guided tour, #discover opens the drawer
if (location.hash === '#tour') startTour();
else if (location.hash === '#discover') $('discover').hidden = false;
else if (location.hash === '#satellite') viewBtn.onclick();
else if (location.hash === '#2d') toggle2D();
else if (location.hash === '#satellites') satsBtn.onclick();
else if (location.hash.startsWith('#sat=')) {
  const q = decodeURIComponent(location.hash.slice(5)).toLowerCase();
  satsPref = true;
  satsBtn.classList.add('on');
  setSats(true).then(() => {
    const k = satMeta.findIndex((s) => s.n.toLowerCase().includes(q));
    if (k >= 0) selectSatellite(k);
  });
}
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
