import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// World unit = 1 inch. Keeps grid math and slider ranges directly readable.
const MM_PER_INCH = 25.4;

const state = {
  unit: "in",
  length: 36, // X
  height: 72, // Y
  width: 12,  // Z (depth)
  dowelRadius: 0.5, // 1" diameter closet rod default
  squareSize: 18,   // max printable square edge; linked to the divisions count
  diagonals: "none", // "none" | "left" | "right" — brace across each square cell
  rows: false,       // horizontal shelf decks at each interior level
  columns: false,    // vertical partitions at each interior length cut
  openFront: false,  // drop the +Z face's infill so it reads as a usable shelf
};

// ---------- renderer / scene / camera ----------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14140f);
scene.fog = new THREE.Fog(0x14140f, 200, 900);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(130, 100, 160);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, state.height / 2, 0);
controls.update();

// Reference floor grid — 1 foot (12") minor spacing, subtle.
const floorGrid = new THREE.GridHelper(480, 40, 0x3a3826, 0x24231a);
scene.add(floorGrid);

// ---------- shader material ----------

const vertexShader = `
  varying vec3 vWorldPos;
  varying vec3 vNormal;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const fragmentShader = `
  uniform vec3 lightDir;
  uniform vec3 baseColor;
  uniform vec3 cameraPos;

  varying vec3 vWorldPos;
  varying vec3 vNormal;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize(lightDir);
    float diff = max(dot(N, L), 0.0);
    float ambient = 0.42;
    vec3 color = baseColor * (ambient + diff * 0.58);

    // Fresnel rim light so rods and nodes read clearly against the background.
    vec3 V = normalize(cameraPos - vWorldPos);
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.5);
    color += vec3(0.95, 0.72, 0.32) * fresnel * 0.5;

    gl_FragColor = vec4(color, 1.0);
  }
`;

function makeShaderMaterial(colorHex) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      lightDir: { value: new THREE.Vector3(0.6, 1.0, 0.4) },
      baseColor: { value: new THREE.Color(colorHex) },
      cameraPos: { value: camera.position.clone() },
    },
  });
}

// Connector hub tracks the dowel it wraps, same as the printed connectors
// (socket OD grows with rod diameter). Ratio from connectors_v1: hub reads
// slightly under the rod so dowels stay visually dominant.
const HUB_TO_DOWEL_RATIO = 0.9;

const nodeMaterial = makeShaderMaterial(0xf2b64c); // connector accent
const edgeMaterial = makeShaderMaterial(0xd8b98a); // dowel wood tone
const diagMaterial = makeShaderMaterial(0x9b6bd6); // diagonal brace accent (purple)

// Unit-radius primitives; actual radius applied per-mesh in rebuildScene
// so the dowel-radius slider rescales without rebuilding geometry.
const nodeGeometry = new THREE.SphereGeometry(1, 20, 16);
const edgeGeometry = new THREE.CylinderGeometry(1, 1, 1, 16, 1);

// ---------- frame generation ----------
// Single tiling mode: every axis is cut every squareSize inches from the
// origin corner, with the remainder strip at the far end (slivers under
// MERGE_TOL merge into an exact fit). All six faces share these per-axis
// cut positions, so adjacent faces always agree on connector locations
// along shared edges, and each face reads as: full squares, then two
// rectangle strips and a smaller corner rectangle.
const MERGE_TOL = 0.05; // inches

let nodes = []; // world positions (inches), y=0 at the floor
let edges = []; // [nodeIndexA, nodeIndexB]
let edgeDiag = []; // parallel to edges — true where the segment is a 45° brace

function axisCuts(length) {
  const cuts = [0];
  for (let k = 1; k * state.squareSize < length - MERGE_TOL; k++) {
    cuts.push(k * state.squareSize);
  }
  cuts.push(length);
  return cuts;
}

// Segments exist where they lie on a rendered plane: always the six faces;
// with rows on, also the horizontal planes at each interior height cut
// (shelf decks); with columns on, the vertical planes at each interior
// length cut (partitions). Shared segments are emitted once — the include
// conditions are OR'd, never duplicated. Nodes are created lazily from the
// segments that use them, so no orphan connectors appear in the parts list.
//
// Open Front drops the infill on the +Z face (the face toward the default
// camera) so the box reads as a usable shelf. Only the interior grid on
// that face disappears — the perimeter rails/corner posts stay, since
// they're shared with the top/bottom/side faces and still need to exist.
function generateFrame() {
  const L = state.length, H = state.height, W = state.width;
  const xs = axisCuts(L), ys = axisCuts(H), zs = axisCuts(W);
  const onB = (v, max) => v < MERGE_TOL || v > max - MERGE_TOL;
  const { rows, columns, diagonals, openFront } = state;
  const isFront = (k) => k === zs.length - 1;
  const zClosed = (k) => onB(zs[k], W) && !(openFront && isFront(k));

  nodes = [];
  edges = [];
  edgeDiag = [];
  const index = new Map();
  const nodeId = (i, j, k) => {
    const key = i + "," + j + "," + k;
    let id = index.get(key);
    if (id === undefined) {
      id = nodes.length;
      index.set(key, id);
      nodes.push(new THREE.Vector3(xs[i] - L / 2, ys[j], zs[k] - W / 2));
    }
    return id;
  };
  const addEdge = (a, b, diag = false) => {
    edges.push([nodeId(...a), nodeId(...b)]);
    edgeDiag.push(diag);
  };

  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < ys.length; j++) {
      for (let k = 0; k < zs.length; k++) {
        if (i + 1 < xs.length && (onB(ys[j], H) || zClosed(k) || rows))
          addEdge([i, j, k], [i + 1, j, k]);
        if (j + 1 < ys.length && (onB(xs[i], L) || zClosed(k) || columns))
          addEdge([i, j, k], [i, j + 1, k]);
        if (k + 1 < zs.length && (onB(xs[i], L) || onB(ys[j], H) || rows || columns))
          addEdge([i, j, k], [i, j, k + 1]);
      }
    }
  }

  // Diagonal braces: one per square cell on every rendered plane. Only
  // square cells qualify — rectangles would need non-45° connectors, which
  // the physical system deliberately avoids. "Right" runs lower-left →
  // upper-right in each plane's local axes; "left" is the mirror.
  if (diagonals !== "none") {
    const right = diagonals === "right";
    const isSquare = (a, b) => Math.abs(a - b) < MERGE_TOL;

    // Front/back faces (x-y planes at each depth boundary).
    for (let k = 0; k < zs.length; k++) {
      if (!onB(zs[k], W) || (openFront && isFront(k))) continue;
      for (let i = 0; i + 1 < xs.length; i++)
        for (let j = 0; j + 1 < ys.length; j++) {
          if (!isSquare(xs[i + 1] - xs[i], ys[j + 1] - ys[j])) continue;
          if (right) addEdge([i, j, k], [i + 1, j + 1, k], true);
          else addEdge([i + 1, j, k], [i, j + 1, k], true);
        }
    }
    // Side faces and column partitions (z-y planes).
    for (let i = 0; i < xs.length; i++) {
      if (!(onB(xs[i], L) || columns)) continue;
      for (let k = 0; k + 1 < zs.length; k++)
        for (let j = 0; j + 1 < ys.length; j++) {
          if (!isSquare(zs[k + 1] - zs[k], ys[j + 1] - ys[j])) continue;
          if (right) addEdge([i, j, k], [i, j + 1, k + 1], true);
          else addEdge([i, j, k + 1], [i, j + 1, k], true);
        }
    }
    // Top/bottom faces and row decks (x-z planes).
    for (let j = 0; j < ys.length; j++) {
      if (!(onB(ys[j], H) || rows)) continue;
      for (let i = 0; i + 1 < xs.length; i++)
        for (let k = 0; k + 1 < zs.length; k++) {
          if (!isSquare(xs[i + 1] - xs[i], zs[k + 1] - zs[k])) continue;
          if (right) addEdge([i, j, k], [i + 1, j, k + 1], true);
          else addEdge([i, j, k + 1], [i + 1, j, k], true);
        }
    }
  }
}

// Mesh pools — reused across rebuilds so slider drags don't churn objects.
const nodePool = [];
const edgePool = [];

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _quat = new THREE.Quaternion();

function rebuildScene() {
  generateFrame();
  const r = state.dowelRadius;
  const hubR = r * HUB_TO_DOWEL_RATIO;

  while (nodePool.length < nodes.length) {
    const mesh = new THREE.Mesh(nodeGeometry, nodeMaterial);
    scene.add(mesh);
    nodePool.push(mesh);
  }
  nodePool.forEach((mesh, i) => {
    mesh.visible = i < nodes.length;
    if (!mesh.visible) return;
    mesh.position.copy(nodes[i]);
    mesh.scale.setScalar(hubR);
  });

  while (edgePool.length < edges.length) {
    const mesh = new THREE.Mesh(edgeGeometry, edgeMaterial);
    scene.add(mesh);
    edgePool.push(mesh);
  }
  edgePool.forEach((mesh, i) => {
    mesh.visible = i < edges.length;
    if (!mesh.visible) return;
    mesh.material = edgeDiag[i] ? diagMaterial : edgeMaterial;
    const [ai, bi] = edges[i];
    _a.copy(nodes[ai]);
    _b.copy(nodes[bi]);
    _dir.subVectors(_b, _a);
    const len = _dir.length();
    _mid.addVectors(_a, _b).multiplyScalar(0.5);
    _quat.setFromUnitVectors(UP, _dir.normalize());
    mesh.position.copy(_mid);
    mesh.quaternion.copy(_quat);
    mesh.scale.set(r, len, r);
  });

  controls.target.set(0, state.height / 2, 0);
}
rebuildScene();

// ---------- UI wiring ----------

const el = {
  len: document.getElementById("len"),
  hgt: document.getElementById("hgt"),
  wid: document.getElementById("wid"),
  lenVal: document.getElementById("lenVal"),
  hgtVal: document.getElementById("hgtVal"),
  widVal: document.getElementById("widVal"),
  lenMM: document.getElementById("lenMM"),
  hgtMM: document.getElementById("hgtMM"),
  widMM: document.getElementById("widMM"),
  dwl: document.getElementById("dwl"),
  dwlVal: document.getElementById("dwlVal"),
  dwlMM: document.getElementById("dwlMM"),
  sqsVal: document.getElementById("sqsVal"),
  sqsMM: document.getElementById("sqsMM"),
  divVal: document.getElementById("divVal"),
  padCanvas: document.getElementById("padCanvas"),
  unitIn: document.getElementById("unit-in"),
  unitMM: document.getElementById("unit-mm"),
  connCount: document.getElementById("connCount"),
  connBreakdown: document.getElementById("connBreakdown"),
  diagSeg: document.getElementById("diagSeg"),
  rowsBtn: document.getElementById("rowsBtn"),
  colsBtn: document.getElementById("colsBtn"),
  openFrontBtn: document.getElementById("openFrontBtn"),
  dowelCount: document.getElementById("dowelCount"),
  dowelBreakdown: document.getElementById("dowelBreakdown"),
  copyBtn: document.getElementById("copyBtn"),
};

function formatPrimary(inches) {
  return state.unit === "in" ? `${inches.toFixed(1)}"` : `${(inches * MM_PER_INCH).toFixed(0)}mm`;
}
function formatSecondary(inches) {
  return state.unit === "in" ? `${(inches * MM_PER_INCH).toFixed(0)}mm` : `${inches.toFixed(2)}"`;
}

function longestAxis() {
  return Math.max(state.length, state.height, state.width);
}

// Divisions = segment count along the longest axis for the current square
// size. The two controls are views of the same quantity.
const SQS_MIN = 2, SQS_MAX = 96;
const DIV_MIN = 1, DIV_MAX = 24;

function currentDivisions() {
  return Math.max(1, Math.ceil((longestAxis() - MERGE_TOL) / state.squareSize));
}

function setSquareSize(s) {
  if (Number.isNaN(s)) return;
  state.squareSize = Math.max(SQS_MIN, Math.min(SQS_MAX, s));
  rebuildScene();
  updateLabels();
}

function setDivisions(n) {
  n = Math.round(n);
  if (Number.isNaN(n)) return;
  n = Math.max(DIV_MIN, Math.min(DIV_MAX, n));
  setSquareSize(longestAxis() / n);
}

// ---------- tiling XY pad ----------
// X axis = square size, Y axis = divisions. The two are one degree of
// freedom, so valid combinations form a staircase curve (N = ceil(L/S));
// the handle rides that curve and pointer input snaps to it.

function padMetrics() {
  const cw = el.padCanvas.clientWidth;
  const ch = el.padCanvas.clientHeight;
  const mL = 10, mR = 8, mT = 10, mB = 14;
  const sToX = (s) => mL + ((s - SQS_MIN) / (SQS_MAX - SQS_MIN)) * (cw - mL - mR);
  const xToS = (x) => SQS_MIN + ((x - mL) / (cw - mL - mR)) * (SQS_MAX - SQS_MIN);
  const nToY = (n) => ch - mB - ((n - DIV_MIN) / (DIV_MAX - DIV_MIN)) * (ch - mT - mB);
  const yToN = (y) => DIV_MIN + ((ch - mB - y) / (ch - mT - mB)) * (DIV_MAX - DIV_MIN);
  return { cw, ch, mL, mR, mT, mB, sToX, xToS, nToY, yToN };
}

function drawPad() {
  const canvas = el.padCanvas;
  const { cw, ch, sToX, nToY } = padMetrics();
  const dpr = Math.min(window.devicePixelRatio, 2);
  if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(0, 0, cw, ch);

  // Faint reference grid.
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let s = 12; s < SQS_MAX; s += 12) {
    ctx.beginPath();
    ctx.moveTo(sToX(s), 0);
    ctx.lineTo(sToX(s), ch);
    ctx.stroke();
  }
  for (let n = 6; n < DIV_MAX; n += 6) {
    ctx.beginPath();
    ctx.moveTo(0, nToY(n));
    ctx.lineTo(cw, nToY(n));
    ctx.stroke();
  }

  // The link curve: N = ceil(L/S) staircase.
  const L = longestAxis();
  ctx.strokeStyle = "rgba(242,182,76,0.55)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  for (let n = DIV_MAX; n >= DIV_MIN; n--) {
    let s0 = Math.max(L / n, SQS_MIN);
    let s1 = Math.min(n === 1 ? SQS_MAX : L / (n - 1), SQS_MAX);
    if (s0 >= s1) continue;
    if (!started) {
      ctx.moveTo(sToX(s0), nToY(n));
      started = true;
    } else {
      ctx.lineTo(sToX(s0), nToY(n));
    }
    ctx.lineTo(sToX(s1), nToY(n));
  }
  ctx.stroke();

  // Axis hints.
  ctx.fillStyle = "rgba(140,134,114,0.8)";
  ctx.font = "9px -apple-system, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("square size →", cw - 6, ch - 4);
  ctx.textAlign = "left";
  ctx.fillText("↑ divisions", 6, 12);

  // Handle at the current state.
  const hx = sToX(state.squareSize);
  const hy = nToY(Math.min(currentDivisions(), DIV_MAX));
  ctx.beginPath();
  ctx.arc(hx, hy, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#f2b64c";
  ctx.fill();
  ctx.strokeStyle = "#14140f";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// Snap pointer input to the curve: candidate A reads the pointer's x as a
// square size, candidate B reads its y as a division count — whichever
// lands closer to the pointer wins. Horizontal drags feel like a size
// control, vertical drags feel like a divisions control.
function padDrag(e) {
  const rect = el.padCanvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const { sToX, xToS, nToY, yToN } = padMetrics();
  const L = longestAxis();

  const sA = Math.max(SQS_MIN, Math.min(SQS_MAX, xToS(px)));
  const nA = Math.max(DIV_MIN, Math.min(DIV_MAX, Math.ceil((L - MERGE_TOL) / sA)));
  const dA = (py - nToY(nA)) ** 2;

  const nB = Math.max(DIV_MIN, Math.min(DIV_MAX, Math.round(yToN(py))));
  const sB = Math.max(SQS_MIN, Math.min(SQS_MAX, L / nB));
  const dB = (px - sToX(sB)) ** 2 + (py - nToY(nB)) ** 2;

  setSquareSize(dA <= dB ? sA : sB);
}

el.padCanvas.addEventListener("pointerdown", (e) => {
  el.padCanvas.setPointerCapture(e.pointerId);
  padDrag(e);
});
el.padCanvas.addEventListener("pointermove", (e) => {
  if (e.buttons) padDrag(e);
});

// ---------- parts export ----------

// Classify a connector by its incident dowel directions (unit vectors).
// Geometry-derived, so new node kinds introduced by divisions (mid-edge
// couplers, face T's/crosses...) name themselves — nothing is hardcoded.
// Names follow the connectors_v1 family where a match exists.
function classifyConnector(dirs) {
  // Diagonal brace arms (45° in a plane) are named separately from the
  // axis-aligned sockets — they're a different socket angle on the print.
  const axis = [];
  const diag = [];
  dirs.forEach((d) => {
    (Math.max(Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)) > 0.99 ? axis : diag).push(d);
  });

  let base;
  const arms = axis.length;
  let collinearPairs = 0;
  for (let i = 0; i < axis.length; i++) {
    for (let j = i + 1; j < axis.length; j++) {
      if (axis[i].dot(axis[j]) < -0.99) collinearPairs++;
    }
  }
  if (arms === 0) base = null;
  else if (arms === 1) base = "1-way cap";
  else if (arms === 2) base = collinearPairs ? "2-way inline" : "2-way elbow";
  else if (arms === 3) base = collinearPairs ? "3-way T" : "3-way corner";
  else if (arms === 4) {
    if (collinearPairs === 2) base = "4-way intermediate";
    else if (collinearPairs === 1) base = "4-way T";
    else base = "4-way corner";
  } else if (arms === 5) base = "5-way";
  else if (arms === 6) base = "6-way hub";
  else base = `${arms}-way`;

  if (diag.length === 0) return base;
  if (base === null) return diag.length === 4 ? "X-brace center" : `${diag.length}-diag brace`;
  return `${base} + ${diag.length} diag`;
}

// Derived from the actual node/edge lists, so counts stay correct for any
// tiling the generator produces.
function computeParts() {
  const toUnit = (inches) =>
    state.unit === "in" ? Math.round(inches * 10) / 10 : Math.round(inches * MM_PER_INCH);
  // Finer rounding for small values like the dowel radius.
  const toFine = (inches) =>
    state.unit === "in" ? Math.round(inches * 100) / 100 : Math.round(inches * MM_PER_INCH * 10) / 10;

  const byLength = new Map();
  const armDirs = nodes.map(() => []);
  edges.forEach(([ai, bi]) => {
    const len = toUnit(nodes[ai].distanceTo(nodes[bi]));
    byLength.set(len, (byLength.get(len) || 0) + 1);
    const dir = new THREE.Vector3().subVectors(nodes[bi], nodes[ai]).normalize();
    armDirs[ai].push(dir);
    armDirs[bi].push(dir.clone().negate());
  });

  const byType = new Map();
  armDirs.forEach((dirs) => {
    const type = classifyConnector(dirs);
    byType.set(type, (byType.get(type) || 0) + 1);
  });

  return {
    unit: state.unit,
    dimensions: {
      length: toUnit(state.length),
      height: toUnit(state.height),
      width: toUnit(state.width),
    },
    squareSize: toFine(state.squareSize),
    divisions: currentDivisions(),
    structure: {
      diagonals: state.diagonals,
      rows: state.rows,
      columns: state.columns,
      openFront: state.openFront,
    },
    connectors: {
      count: nodes.length,
      byType: [...byType.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({ type, count })),
    },
    dowels: {
      count: edges.length,
      radius: toFine(state.dowelRadius),
      diameter: toFine(state.dowelRadius * 2),
      byLength: [...byLength.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([length, count]) => ({ length, count })),
    },
  };
}

function updateExport() {
  const parts = computeParts();
  el.connCount.textContent = parts.connectors.count;
  el.dowelCount.textContent = parts.dowels.count;
  // One connector type per line — this is a pick list for printing.
  el.connBreakdown.textContent = "";
  parts.connectors.byType.forEach((c) => {
    const line = document.createElement("div");
    line.textContent = `${c.count} × ${c.type}`;
    el.connBreakdown.appendChild(line);
  });
  const suffix = state.unit === "in" ? '"' : "mm";
  // One dowel length per line — this is a pick list for printing.
  el.dowelBreakdown.textContent = "";
  parts.dowels.byLength.forEach((d) => {
    const line = document.createElement("div");
    line.textContent = `${d.count} × ${d.length}${suffix}`;
    el.dowelBreakdown.appendChild(line);
  });
}

el.copyBtn.addEventListener("click", async () => {
  const json = JSON.stringify(computeParts(), null, 2);
  try {
    await navigator.clipboard.writeText(json);
  } catch {
    // Clipboard API can be unavailable in sandboxed webviews — fall back.
    const ta = document.createElement("textarea");
    ta.value = json;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  el.copyBtn.classList.add("copied");
  el.copyBtn.textContent = "Copied!";
  setTimeout(() => {
    el.copyBtn.classList.remove("copied");
    el.copyBtn.textContent = "Copy JSON";
  }, 1200);
});

// ---------- labels ----------

function updateLabels() {
  el.lenVal.value = formatPrimary(state.length);
  el.hgtVal.value = formatPrimary(state.height);
  el.widVal.value = formatPrimary(state.width);
  el.lenMM.textContent = formatSecondary(state.length);
  el.hgtMM.textContent = formatSecondary(state.height);
  el.widMM.textContent = formatSecondary(state.width);
  // Radius needs finer precision than the big dimensions (0.05" steps).
  const r = state.dowelRadius;
  el.dwlVal.value =
    state.unit === "in" ? `${r.toFixed(2)}"` : `${(r * MM_PER_INCH).toFixed(1)}mm`;
  el.dwlMM.textContent =
    state.unit === "in" ? `${(r * MM_PER_INCH).toFixed(1)}mm` : `${r.toFixed(2)}"`;
  // Square size + divisions stay mutually consistent.
  const s = state.squareSize;
  el.sqsVal.value =
    state.unit === "in" ? `${s.toFixed(1)}"` : `${(s * MM_PER_INCH).toFixed(0)}mm`;
  el.sqsMM.textContent =
    state.unit === "in" ? `${(s * MM_PER_INCH).toFixed(0)}mm` : `${s.toFixed(2)}"`;
  el.divVal.value = currentDivisions();
  drawPad();
  updateExport();
}

// Each value label doubles as a typed input: Enter or click-away commits,
// Escape reverts. Typed values are read in the active display unit and
// clamped to the matching slider's range.
function bindEditable(input, slider, key) {
  const commit = () => {
    const raw = parseFloat(input.value);
    if (Number.isNaN(raw)) {
      updateLabels();
      return;
    }
    let inches = state.unit === "in" ? raw : raw / MM_PER_INCH;
    inches = Math.min(parseFloat(slider.max), Math.max(parseFloat(slider.min), inches));
    state[key] = inches;
    slider.value = inches;
    rebuildScene();
    updateLabels();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") {
      updateLabels();
      input.blur();
    }
  });
  input.addEventListener("focus", () => input.select());
}

bindEditable(el.lenVal, el.len, "length");
bindEditable(el.hgtVal, el.hgt, "height");
bindEditable(el.widVal, el.wid, "width");
bindEditable(el.dwlVal, el.dwl, "dowelRadius");

// Square size has no slider anymore — its typed input commits via the
// shared setter (which clamps and redraws the pad).
el.sqsVal.addEventListener("blur", () => {
  const raw = parseFloat(el.sqsVal.value);
  if (Number.isNaN(raw)) {
    updateLabels();
    return;
  }
  setSquareSize(state.unit === "in" ? raw : raw / MM_PER_INCH);
});
el.sqsVal.addEventListener("keydown", (e) => {
  if (e.key === "Enter") el.sqsVal.blur();
  if (e.key === "Escape") {
    updateLabels();
    el.sqsVal.blur();
  }
});
el.sqsVal.addEventListener("focus", () => el.sqsVal.select());

// Divisions is a unitless natural number — its own commit path.
el.divVal.addEventListener("blur", () => setDivisions(parseFloat(el.divVal.value)));
el.divVal.addEventListener("keydown", (e) => {
  if (e.key === "Enter") el.divVal.blur();
  if (e.key === "Escape") {
    updateLabels();
    el.divVal.blur();
  }
});
el.divVal.addEventListener("focus", () => el.divVal.select());

el.len.addEventListener("input", () => {
  state.length = parseFloat(el.len.value);
  rebuildScene();
  updateLabels();
});
el.hgt.addEventListener("input", () => {
  state.height = parseFloat(el.hgt.value);
  rebuildScene();
  updateLabels();
});
el.wid.addEventListener("input", () => {
  state.width = parseFloat(el.wid.value);
  rebuildScene();
  updateLabels();
});
el.dwl.addEventListener("input", () => {
  state.dowelRadius = parseFloat(el.dwl.value);
  rebuildScene();
  updateLabels();
});

// ---------- structure toggles ----------

function syncStructureUI() {
  el.diagSeg.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.v === state.diagonals);
  });
  el.rowsBtn.classList.toggle("active", state.rows);
  el.rowsBtn.textContent = state.rows ? "On" : "Off";
  el.colsBtn.classList.toggle("active", state.columns);
  el.colsBtn.textContent = state.columns ? "On" : "Off";
  el.openFrontBtn.classList.toggle("active", state.openFront);
  el.openFrontBtn.textContent = state.openFront ? "On" : "Off";
}

el.diagSeg.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.diagonals = btn.dataset.v;
    syncStructureUI();
    rebuildScene();
    updateLabels();
  });
});
el.rowsBtn.addEventListener("click", () => {
  state.rows = !state.rows;
  syncStructureUI();
  rebuildScene();
  updateLabels();
});
el.colsBtn.addEventListener("click", () => {
  state.columns = !state.columns;
  syncStructureUI();
  rebuildScene();
  updateLabels();
});
el.openFrontBtn.addEventListener("click", () => {
  state.openFront = !state.openFront;
  syncStructureUI();
  rebuildScene();
  updateLabels();
});
syncStructureUI();

el.unitIn.addEventListener("click", () => {
  state.unit = "in";
  el.unitIn.classList.add("active");
  el.unitMM.classList.remove("active");
  updateLabels();
});
el.unitMM.addEventListener("click", () => {
  state.unit = "mm";
  el.unitMM.classList.add("active");
  el.unitIn.classList.remove("active");
  updateLabels();
});

updateLabels();

// ---------- resize + render loop ----------

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  drawPad();
});

function animate() {
  requestAnimationFrame(animate);
  nodeMaterial.uniforms.cameraPos.value.copy(camera.position);
  edgeMaterial.uniforms.cameraPos.value.copy(camera.position);
  diagMaterial.uniforms.cameraPos.value.copy(camera.position);
  controls.update();
  renderer.render(scene, camera);
}
animate();
