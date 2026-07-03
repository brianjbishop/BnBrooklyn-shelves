import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// World unit = 1 inch. Keeps grid math and slider ranges directly readable.
const MM_PER_INCH = 25.4;

const state = {
  unit: "in",
  width: 54,  // X
  height: 36, // Y
  depth: 24,  // Z
  dowelRadius: 0.5, // 1" diameter closet rod default
  squareSize: 13.5, // max printable square edge; linked to the divisions count (4 divisions @ width 54)
  brace: "identity", // math function bracing the six exterior faces ("off" = none)
  braceFlip: true,   // mirror the brace across the cell (flips "/" <-> "\"); true = "\" (left) by default
  rowBrace: "off",   // math function bracing row-deck cells specifically (independent of the face brace)
  rowBraceFlip: true,
  colBrace: "off",   // math function bracing column-partition cells specifically
  colBraceFlip: true,
  // "Skip" is a stride: 0 = every interior cut gets a deck/partition, 1 =
  // every other, 2 = every 3rd, ... up to maxRowSkip/maxColSkip (the count
  // of interior cuts) = none at all. 999 is a sentinel that always clamps
  // down to "none" for the current geometry, matching the old rows/columns
  // default of off.
  rowSkip: 999,
  colSkip: 999,
  openFront: true,  // drop the +Z face's infill so it reads as a usable shelf
};

// Interior-cut counts for the rows/columns skip pad — depend only on the
// box dimensions and square size, so callable without rebuilding the frame.
function maxRowSkip() {
  return Math.max(0, axisCuts(state.height).length - 2);
}
function maxColSkip() {
  return Math.max(0, axisCuts(state.width).length - 2);
}

// Math functions available as cell braces. Each is a printed curved member
// (see buildBraceLocal) that kinks to 45 degrees at its ends so it seats
// into the diagonal sockets of the corner connectors — the "math" in
// math-furniture. Display names shown in the UI and parts export.
const BRACE_NAMES = {
  identity: "Identity",
  quadratic: "Quadratic",
  abs: "Absolute Value",
  zigzag: "ZigZag",
  exponential: "Exponential",
  cubic: "Cubic",
  hyperbola: "Hyperbola",
  circle: "Unit Circle",
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
  uniform vec3 rimColor;
  uniform vec3 cameraPos;

  varying vec3 vWorldPos;
  varying vec3 vNormal;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize(lightDir);
    float diff = max(dot(N, L), 0.0);
    float ambient = 0.42;
    vec3 color = baseColor * (ambient + diff * 0.58);

    // Fresnel rim light so rods and connectors read clearly against the background.
    vec3 V = normalize(cameraPos - vWorldPos);
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.5);
    color += rimColor * fresnel * 0.5;

    gl_FragColor = vec4(color, 1.0);
  }
`;

function makeShaderMaterial(colorHex, rimHex = 0xf2b64c) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      lightDir: { value: new THREE.Vector3(0.6, 1.0, 0.4) },
      baseColor: { value: new THREE.Color(colorHex) },
      rimColor: { value: new THREE.Color(rimHex) },
      cameraPos: { value: camera.position.clone() },
    },
  });
}

// Connector hub OD grows past the dowel OD, same ratio as the printed
// connectors_v1 hardware (36mm hub / 25.4mm dowel ≈ 1.4×) — the hub should
// read as a distinct bulge the dowel plugs into, not a smaller ball joint.
const HUB_TO_DOWEL_RATIO = 1.4;
// Socket "collars" (short stub cylinders per arm) read slightly thicker
// than the dowel they wrap, and extend a fraction of the hub radius.
const STUB_RADIUS_RATIO = 1.15;
const STUB_LENGTH_RATIO = 1.3;

// Black body with a white rim light — the black print material stays
// readable as a silhouette against the dark scene even without direct color.
const connectorMaterial = makeShaderMaterial(0x0d0d0d, 0xffffff);
const edgeMaterial = makeShaderMaterial(0xd8b98a, 0xf2b64c); // dowel wood tone
const braceMaterial = makeShaderMaterial(0x9b6bd6, 0xf2b64c); // function-brace accent (purple)

// Unit-radius primitives; actual radius applied per-mesh in rebuildScene
// so the dowel-radius slider rescales without rebuilding geometry.
const hubGeometry = new THREE.SphereGeometry(1, 20, 16);
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
let edges = []; // [nodeIndexA, nodeIndexB] — straight structural dowels
let braceSegs = [];       // flat list of [Vec3, Vec3] cylinder segments for curved braces
let braceTypeCounts = {}; // brace function key -> count of cells using it
let armDirs = []; // parallel to nodes — unit vectors of each connector's arms
let effRowSkip = 0, effColSkip = 0; // state.rowSkip/colSkip clamped to the current geometry

// A brace lives in a unit (u,v) cell, v = up, spanning [0,1]x[0,1]. Returns
// { segs, arms }: segs is the polyline(s) to render as cylinders (each a
// [[u,v],[u,v]] pair); arms lists the endpoints that plug into a corner
// connector, with a local direction that is 45 degrees so the socket seats
// cleanly. emitBrace maps this onto the real cell (and applies the flip).
const BRACE_K = 0.14;      // 45-degree stub inset at each end (fraction of the cell)
const BRACE_SAMPLES = 26;  // interior samples for smooth curves

function bracePolyToSegs(pts) {
  const segs = [];
  for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
  return segs;
}

// Diagonal-spanning brace, corner (0,0) -> (1,1), with 45-degree stubs at
// each end and interior height g(s):[0,1]->[0,1] between them.
function braceSmooth(g) {
  const u0 = BRACE_K, u1 = 1 - BRACE_K;
  const pts = [[0, 0], [u0, u0]];
  for (let i = 1; i < BRACE_SAMPLES; i++) {
    const s = i / BRACE_SAMPLES;
    pts.push([u0 + (u1 - u0) * s, u0 + (u1 - u0) * g(s)]);
  }
  pts.push([u1, u1], [1, 1]);
  return { segs: bracePolyToSegs(pts), arms: [{ at: [0, 0], dir: [1, 1] }, { at: [1, 1], dir: [-1, -1] }] };
}

function buildBraceLocal(type) {
  switch (type) {
    case "identity":
      return { segs: bracePolyToSegs([[0, 0], [1, 1]]), arms: [{ at: [0, 0], dir: [1, 1] }, { at: [1, 1], dir: [-1, -1] }] };
    case "quadratic": {
      // Parabola hanging between the two TOP corners, dipping down close to
      // the bar below (but never touching it), with 45-degree kinks into
      // each top corner.
      const u0 = BRACE_K, u1 = 1 - BRACE_K, vTop = 1 - u0, vMin = 0.12;
      const pts = [[0, 1], [u0, vTop]];
      for (let i = 1; i < BRACE_SAMPLES; i++) {
        const u = u0 + (u1 - u0) * (i / BRACE_SAMPLES);
        const t = (u - 0.5) / (0.5 - u0);
        pts.push([u, vMin + (vTop - vMin) * t * t]);
      }
      pts.push([u1, vTop], [1, 1]);
      return { segs: bracePolyToSegs(pts), arms: [{ at: [0, 1], dir: [1, -1] }, { at: [1, 1], dir: [-1, -1] }] };
    }
    case "abs":
      // V between the two top corners, vertex at center (never touches bottom).
      return { segs: bracePolyToSegs([[0, 1], [0.5, 0.5], [1, 1]]), arms: [{ at: [0, 1], dir: [1, -1] }, { at: [1, 1], dir: [-1, -1] }] };
    case "zigzag": {
      // Sharp multi-peak triangle wave riding the corner-to-corner diagonal,
      // 45-degree stubs at both ends. Amplitude is large relative to the
      // cell so the peaks read as real zigzags, not a gentle wobble.
      const u0 = BRACE_K, u1 = 1 - BRACE_K, N = 6, amp = 0.16;
      const pts = [[0, 0], [u0, u0]];
      for (let i = 1; i < N; i++) {
        const u = u0 + (u1 - u0) * (i / N);
        const sign = i % 2 === 1 ? 1 : -1;
        pts.push([u, Math.max(0.02, Math.min(0.98, u + sign * amp))]);
      }
      pts.push([u1, u1], [1, 1]);
      return { segs: bracePolyToSegs(pts), arms: [{ at: [0, 0], dir: [1, 1] }, { at: [1, 1], dir: [-1, -1] }] };
    }
    case "exponential":
      return braceSmooth((s) => (Math.exp(3 * s) - 1) / (Math.exp(3) - 1));
    case "cubic":
      // True cubic wiggle (hump then dip, like y = x^3 - 3x) rather than a
      // monotonic ease — g(0)=0, g(1)=1, g(0.5)=0.5 always; A controls how
      // far the hump/dip overshoot the straight diagonal.
      return braceSmooth((s) => {
        const A = -6;
        const h = s * (1 - s) * (2 * s - 1);
        return s + A * h;
      });
    case "hyperbola":
      // Rectangular-hyperbola branch (a Möbius transform of 1/x): a sharp
      // near-vertical rise right off the corner, then a long flat
      // asymptotic approach — the same family as y = 1/x, just the
      // increasing branch, tuned for a dramatic knee like the reference.
      return braceSmooth((s) => (18 * s) / (1 + 17 * s));
    case "circle": {
      // Ring floating in the middle (touches no side) plus two 45-degree
      // stubs out to opposite corners so it seats into two connectors.
      const cx = 0.5, cy = 0.5, R = 0.3, N = 28, segs = [];
      let prev = null;
      for (let i = 0; i <= N; i++) {
        const a = (2 * Math.PI * i) / N;
        const p = [cx + R * Math.cos(a), cy + R * Math.sin(a)];
        if (prev) segs.push([prev, p]);
        prev = p;
      }
      const d = R / Math.SQRT2;
      segs.push([[0, 0], [cx - d, cy - d]]);
      segs.push([[1, 1], [cx + d, cy + d]]);
      return { segs, arms: [{ at: [0, 0], dir: [1, 1] }, { at: [1, 1], dir: [-1, -1] }] };
    }
    default:
      return { segs: [], arms: [] };
  }
}

function axisCuts(length) {
  const cuts = [0];
  for (let k = 1; k * state.squareSize < length - MERGE_TOL; k++) {
    cuts.push(k * state.squareSize);
  }
  cuts.push(length);
  return cuts;
}

// Segments exist where they lie on a rendered plane: always the six faces;
// plus, per the rows/columns skip pad, the horizontal planes at selected
// interior height cuts (shelf decks) and the vertical planes at selected
// interior width cuts (partitions). Shared segments are emitted once — the
// include conditions are OR'd, never duplicated. Nodes are created lazily
// from the segments that use them, so no orphan connectors appear in the
// parts list.
//
// Open Front drops the infill on the +Z face (the face toward the default
// camera) so the box reads as a usable shelf. Only the interior grid on
// that face disappears — the perimeter rails/corner posts stay, since
// they're shared with the top/bottom/side faces and still need to exist.
function generateFrame() {
  const L = state.width, H = state.height, W = state.depth;
  const xs = axisCuts(L), ys = axisCuts(H), zs = axisCuts(W);
  const onB = (v, max) => v < MERGE_TOL || v > max - MERGE_TOL;
  const { brace, braceFlip, openFront } = state;
  const isFront = (k) => k === zs.length - 1;
  const zClosed = (k) => onB(zs[k], W) && !(openFront && isFront(k));

  // Row/column skip selection: boundary indices always included; interior
  // indices included every (skip+1)-th position, starting from the first,
  // until skip reaches the interior count, at which point none qualify.
  const numRowInterior = Math.max(0, ys.length - 2);
  const numColInterior = Math.max(0, xs.length - 2);
  effRowSkip = Math.min(state.rowSkip, numRowInterior);
  effColSkip = Math.min(state.colSkip, numColInterior);
  const rowsInclude = (j) => {
    if (j === 0 || j === ys.length - 1) return true;
    if (effRowSkip >= numRowInterior) return false;
    return (j - 1) % (effRowSkip + 1) === 0;
  };
  const colsInclude = (i) => {
    if (i === 0 || i === xs.length - 1) return true;
    if (effColSkip >= numColInterior) return false;
    return (i - 1) % (effColSkip + 1) === 0;
  };

  nodes = [];
  edges = [];
  braceSegs = [];
  braceTypeCounts = {};
  const braceArms = [];
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
  const addEdge = (a, b) => edges.push([nodeId(...a), nodeId(...b)]);

  // Straight structural rails (dowels only — braces are handled below).
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < ys.length; j++) {
      for (let k = 0; k < zs.length; k++) {
        if (i + 1 < xs.length && (rowsInclude(j) || zClosed(k)))
          addEdge([i, j, k], [i + 1, j, k]);
        if (j + 1 < ys.length && (colsInclude(i) || zClosed(k)))
          addEdge([i, j, k], [i, j + 1, k]);
        if (k + 1 < zs.length && (rowsInclude(j) || colsInclude(i)))
          addEdge([i, j, k], [i, j, k + 1]);
      }
    }
  }

  // Function braces: one per square cell on each rendered plane. Only square
  // cells qualify (a rectangle can't hold a 45-degree brace). The six
  // exterior faces use the main "Braces" function; row decks and column
  // partitions (the interior planes selected by the skip pad) each use
  // their own independent function, so a shelf can wiggle a Cubic on its
  // faces while row decks trace a ZigZag, say. Each math function is built
  // once (cached) in unit (u,v) coords, then mapped onto every qualifying
  // cell: bilinear for the geometry, and the endpoint arms are registered
  // on the corner connectors so they read as 45-degree sockets.
  const isSquare = (a, b) => Math.abs(a - b) < MERGE_TOL;
  const nodeRef = (i, j, k) => ({
    id: nodeId(i, j, k),
    pos: new THREE.Vector3(xs[i] - L / 2, ys[j], zs[k] - W / 2),
  });
  const localCache = {};
  const getLocal = (type) => (localCache[type] ||= buildBraceLocal(type));

  // c = [c00, c10, c01, c11] for cell corners (u,v) = (0,0),(1,0),(0,1),(1,1).
  const emit = (c, type, flip) => {
    const local = getLocal(type);
    const U = (u) => (flip ? 1 - u : u);
    const to3D = (u, v) => {
      const uu = U(u);
      return new THREE.Vector3()
        .addScaledVector(c[0].pos, (1 - uu) * (1 - v))
        .addScaledVector(c[1].pos, uu * (1 - v))
        .addScaledVector(c[2].pos, (1 - uu) * v)
        .addScaledVector(c[3].pos, uu * v);
    };
    local.segs.forEach(([p, q]) =>
      braceSegs.push([to3D(p[0], p[1]), to3D(q[0], q[1])]));
    local.arms.forEach(({ at, dir }) => {
      const id = c[(U(at[0]) ? 1 : 0) + (at[1] ? 2 : 0)].id;
      const p0 = to3D(at[0], at[1]);
      const p1 = to3D(at[0] + 0.001 * dir[0], at[1] + 0.001 * dir[1]);
      braceArms.push({ id, dir: p1.sub(p0).normalize() });
    });
    braceTypeCounts[type] = (braceTypeCounts[type] || 0) + 1;
  };

  // Front/back faces (x-y planes; u = x, v = y up) — exterior only.
  if (brace !== "off") {
    for (let k = 0; k < zs.length; k++) {
      if (!onB(zs[k], W) || (openFront && isFront(k))) continue;
      for (let i = 0; i + 1 < xs.length; i++)
        for (let j = 0; j + 1 < ys.length; j++)
          if (isSquare(xs[i + 1] - xs[i], ys[j + 1] - ys[j]))
            emit([nodeRef(i, j, k), nodeRef(i + 1, j, k), nodeRef(i, j + 1, k), nodeRef(i + 1, j + 1, k)], brace, braceFlip);
    }
  }
  // Side faces (exterior i, main brace) + column partitions (interior i
  // selected by the skip pad, independent colBrace) — z-y planes.
  for (let i = 0; i < xs.length; i++) {
    const boundary = i === 0 || i === xs.length - 1;
    if (!boundary && !colsInclude(i)) continue;
    const type = boundary ? brace : state.colBrace;
    const flip = boundary ? braceFlip : state.colBraceFlip;
    if (type === "off") continue;
    for (let k = 0; k + 1 < zs.length; k++)
      for (let j = 0; j + 1 < ys.length; j++)
        if (isSquare(zs[k + 1] - zs[k], ys[j + 1] - ys[j]))
          emit([nodeRef(i, j, k), nodeRef(i, j, k + 1), nodeRef(i, j + 1, k), nodeRef(i, j + 1, k + 1)], type, flip);
  }
  // Top/bottom faces (exterior j, main brace) + row decks (interior j
  // selected by the skip pad, independent rowBrace) — x-z planes.
  for (let j = 0; j < ys.length; j++) {
    const boundary = j === 0 || j === ys.length - 1;
    if (!boundary && !rowsInclude(j)) continue;
    const type = boundary ? brace : state.rowBrace;
    const flip = boundary ? braceFlip : state.rowBraceFlip;
    if (type === "off") continue;
    for (let i = 0; i + 1 < xs.length; i++)
      for (let k = 0; k + 1 < zs.length; k++)
        if (isSquare(xs[i + 1] - xs[i], zs[k + 1] - zs[k]))
          emit([nodeRef(i, j, k), nodeRef(i + 1, j, k), nodeRef(i, j, k + 1), nodeRef(i + 1, j, k + 1)], type, flip);
  }

  // Arm directions per connector — straight rails plus brace endpoints —
  // feeds both the socket-stub geometry and the parts-list classifier.
  armDirs = nodes.map(() => []);
  edges.forEach(([ai, bi]) => {
    const dir = new THREE.Vector3().subVectors(nodes[bi], nodes[ai]).normalize();
    armDirs[ai].push(dir);
    armDirs[bi].push(dir.clone().negate());
  });
  braceArms.forEach(({ id, dir }) => armDirs[id].push(dir));
}

// Mesh pools — reused across rebuilds so slider drags don't churn objects.
const hubPool = [];
const stubPool = [];
const edgePool = [];
const bracePool = [];

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _quat = new THREE.Quaternion();

// Orient a unit cylinder mesh to span a -> b with the given radius.
function orientCylinder(mesh, a, b, radius) {
  _dir.subVectors(b, a);
  const len = _dir.length();
  _mid.addVectors(a, b).multiplyScalar(0.5);
  _quat.setFromUnitVectors(UP, _dir.normalize());
  mesh.position.copy(_mid);
  mesh.quaternion.copy(_quat);
  mesh.scale.set(radius, len, radius);
}

function rebuildScene() {
  generateFrame();
  const r = state.dowelRadius;
  const hubR = r * HUB_TO_DOWEL_RATIO;
  const stubR = r * STUB_RADIUS_RATIO;
  const stubLen = hubR * STUB_LENGTH_RATIO;

  while (hubPool.length < nodes.length) {
    const mesh = new THREE.Mesh(hubGeometry, connectorMaterial);
    scene.add(mesh);
    hubPool.push(mesh);
  }
  hubPool.forEach((mesh, i) => {
    mesh.visible = i < nodes.length;
    if (!mesh.visible) return;
    mesh.position.copy(nodes[i]);
    mesh.scale.setScalar(hubR);
  });

  // Socket stubs: one short collar per arm, so each connector reads as a
  // hub with sockets radiating out — not a bare ball joint.
  const stubList = [];
  armDirs.forEach((dirs, i) => {
    dirs.forEach((dir) => stubList.push({ pos: nodes[i], dir }));
  });

  while (stubPool.length < stubList.length) {
    const mesh = new THREE.Mesh(edgeGeometry, connectorMaterial);
    scene.add(mesh);
    stubPool.push(mesh);
  }
  stubPool.forEach((mesh, i) => {
    mesh.visible = i < stubList.length;
    if (!mesh.visible) return;
    const { pos, dir } = stubList[i];
    _quat.setFromUnitVectors(UP, dir);
    mesh.position.copy(pos).addScaledVector(dir, stubLen / 2);
    mesh.quaternion.copy(_quat);
    mesh.scale.set(stubR, stubLen, stubR);
  });

  while (edgePool.length < edges.length) {
    const mesh = new THREE.Mesh(edgeGeometry, edgeMaterial);
    scene.add(mesh);
    edgePool.push(mesh);
  }
  edgePool.forEach((mesh, i) => {
    mesh.visible = i < edges.length;
    if (!mesh.visible) return;
    const [ai, bi] = edges[i];
    orientCylinder(mesh, nodes[ai], nodes[bi], r);
  });

  // Curved function braces — one cylinder per sampled segment, thinner than
  // the structural dowels and rendered in the purple brace accent.
  const braceR = r * 0.8;
  while (bracePool.length < braceSegs.length) {
    const mesh = new THREE.Mesh(edgeGeometry, braceMaterial);
    scene.add(mesh);
    bracePool.push(mesh);
  }
  bracePool.forEach((mesh, i) => {
    mesh.visible = i < braceSegs.length;
    if (!mesh.visible) return;
    orientCylinder(mesh, braceSegs[i][0], braceSegs[i][1], braceR);
  });

  controls.target.set(0, state.height / 2, 0);
}
rebuildScene();

// ---------- UI wiring ----------

const el = {
  wid: document.getElementById("wid"),
  hgt: document.getElementById("hgt"),
  dep: document.getElementById("dep"),
  widVal: document.getElementById("widVal"),
  hgtVal: document.getElementById("hgtVal"),
  depVal: document.getElementById("depVal"),
  widMM: document.getElementById("widMM"),
  hgtMM: document.getElementById("hgtMM"),
  depMM: document.getElementById("depMM"),
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
  braceSel: document.getElementById("braceSel"),
  braceFlip: document.getElementById("braceFlip"),
  rowBraceSel: document.getElementById("rowBraceSel"),
  rowBraceFlip: document.getElementById("rowBraceFlip"),
  colBraceSel: document.getElementById("colBraceSel"),
  colBraceFlip: document.getElementById("colBraceFlip"),
  rcCanvas: document.getElementById("rcCanvas"),
  openFrontBtn: document.getElementById("openFrontBtn"),
  dowelCount: document.getElementById("dowelCount"),
  dowelBreakdown: document.getElementById("dowelBreakdown"),
  braceCount: document.getElementById("braceCount"),
  braceBreakdown: document.getElementById("braceBreakdown"),
  rcSkipDisplay: document.getElementById("rcSkipDisplay"),
  fileName: document.getElementById("fileName"),
  copyBtn: document.getElementById("copyBtn"),
  exportBtn: document.getElementById("exportBtn"),
  saveAsBtn: document.getElementById("saveAsBtn"),
};

function formatPrimary(inches) {
  return state.unit === "in" ? `${inches.toFixed(1)}"` : `${(inches * MM_PER_INCH).toFixed(0)}mm`;
}
function formatSecondary(inches) {
  return state.unit === "in" ? `${(inches * MM_PER_INCH).toFixed(0)}mm` : `${inches.toFixed(2)}"`;
}

function longestAxis() {
  return Math.max(state.width, state.height, state.depth);
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

// ---------- rows/columns skip pad ----------
// X = column skip (interior width cuts), Y = row skip (interior height
// cuts). Independent axes, unlike the tiling pad — every (col, row)
// combination is a valid, distinct state, so no link curve to draw.
// Bottom-left (0,0) = every interior cut gets a deck/partition (fully on);
// top-right (max,max) = none at all (fully off).

function rcPadMetrics() {
  const cw = el.rcCanvas.clientWidth;
  const ch = el.rcCanvas.clientHeight;
  const mL = 10, mR = 8, mT = 10, mB = 10;
  const maxC = maxColSkip(), maxR = maxRowSkip();
  const cToX = (c) => (maxC === 0 ? mL + (cw - mL - mR) / 2 : mL + (c / maxC) * (cw - mL - mR));
  const xToC = (x) => (maxC === 0 ? 0 : Math.round(((x - mL) / (cw - mL - mR)) * maxC));
  const rToY = (r) => (maxR === 0 ? ch - mB - (ch - mT - mB) / 2 : ch - mB - (r / maxR) * (ch - mT - mB));
  const yToR = (y) => (maxR === 0 ? 0 : Math.round(((ch - mB - y) / (ch - mT - mB)) * maxR));
  return { cw, ch, maxC, maxR, cToX, xToC, rToY, yToR };
}

function drawRowColPad() {
  const canvas = el.rcCanvas;
  const { cw, ch, maxC, maxR, cToX, rToY } = rcPadMetrics();
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

  // Stepwise grid — one line per integer skip value on each axis.
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let c = 0; c <= maxC; c++) {
    ctx.beginPath();
    ctx.moveTo(cToX(c), 0);
    ctx.lineTo(cToX(c), ch);
    ctx.stroke();
  }
  for (let r = 0; r <= maxR; r++) {
    ctx.beginPath();
    ctx.moveTo(0, rToY(r));
    ctx.lineTo(cw, rToY(r));
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(242,182,76,0.75)";
  ctx.font = "bold 11px Menlo, monospace";
  ctx.textAlign = "left";
  ctx.fillText("R", 4, 12);
  ctx.textAlign = "right";
  ctx.fillText("C", cw - 4, ch - 3);

  const colSkip = Math.min(state.colSkip, maxC);
  const rowSkip = Math.min(state.rowSkip, maxR);
  const hx = cToX(colSkip), hy = rToY(rowSkip);
  ctx.beginPath();
  ctx.arc(hx, hy, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#f2b64c";
  ctx.fill();
  ctx.strokeStyle = "#14140f";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function rcPadDrag(e) {
  const rect = el.rcCanvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const { xToC, yToR, maxC, maxR } = rcPadMetrics();
  state.colSkip = Math.max(0, Math.min(maxC, xToC(px)));
  state.rowSkip = Math.max(0, Math.min(maxR, yToR(py)));
  rebuildScene();
  updateLabels();
}

el.rcCanvas.addEventListener("pointerdown", (e) => {
  el.rcCanvas.setPointerCapture(e.pointerId);
  rcPadDrag(e);
});
el.rcCanvas.addEventListener("pointermove", (e) => {
  if (e.buttons) rcPadDrag(e);
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
  edges.forEach(([ai, bi]) => {
    const len = toUnit(nodes[ai].distanceTo(nodes[bi]));
    byLength.set(len, (byLength.get(len) || 0) + 1);
  });

  const byType = new Map();
  armDirs.forEach((dirs) => {
    const type = classifyConnector(dirs);
    byType.set(type, (byType.get(type) || 0) + 1);
  });

  return {
    unit: state.unit,
    dimensions: {
      width: toUnit(state.width),
      height: toUnit(state.height),
      depth: toUnit(state.depth),
    },
    squareSize: toFine(state.squareSize),
    divisions: currentDivisions(),
    structure: {
      brace: state.brace,
      braceFlip: state.braceFlip,
      rowBrace: state.rowBrace,
      rowBraceFlip: state.rowBraceFlip,
      colBrace: state.colBrace,
      colBraceFlip: state.colBraceFlip,
      rowSkip: effRowSkip,
      colSkip: effColSkip,
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
    braces: {
      count: Object.values(braceTypeCounts).reduce((a, b) => a + b, 0),
      byType: Object.entries(braceTypeCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => ({ type: BRACE_NAMES[key] || key, count })),
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
  // Curved braces are printed pieces, listed by function name.
  el.braceCount.textContent = parts.braces.count;
  el.braceBreakdown.textContent = "";
  parts.braces.byType.forEach((b) => {
    const line = document.createElement("div");
    line.textContent = `${b.count} × ${b.type}`;
    el.braceBreakdown.appendChild(line);
  });
  // Rows/columns skip readout — the pad itself no longer spells this out.
  el.rcSkipDisplay.textContent = `R${parts.structure.rowSkip} · C${parts.structure.colSkip}`;
}

function flashButton(btn, label) {
  const original = btn.textContent;
  btn.classList.add("copied");
  btn.textContent = label;
  setTimeout(() => {
    btn.classList.remove("copied");
    btn.textContent = original;
  }, 1200);
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
  flashButton(el.copyBtn, "Copied!");
});

// ---------- filename + export ----------

// Tracks whether the user has hand-edited the filename — while clean, it
// live-updates to match the current dimensions on every change.
let filenameDirty = false;

function defaultFilename() {
  const d = computeParts().dimensions;
  return `Cartesian-Shelf-${d.width}-${d.height}-${d.depth}.json`;
}
function ensureJsonExt(name) {
  name = (name || "").trim();
  if (!name) return defaultFilename();
  return /\.json$/i.test(name) ? name : `${name}.json`;
}
function updateFilename() {
  if (!filenameDirty) el.fileName.value = defaultFilename();
}
el.fileName.addEventListener("input", () => {
  filenameDirty = true;
});
el.fileName.addEventListener("blur", () => {
  if (!el.fileName.value.trim()) {
    filenameDirty = false;
    updateFilename();
  }
});

function downloadJSON(json, filename) {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Silent save straight to the browser's default download location.
el.exportBtn.addEventListener("click", () => {
  const json = JSON.stringify(computeParts(), null, 2);
  downloadJSON(json, ensureJsonExt(el.fileName.value));
  flashButton(el.exportBtn, "Saved!");
});

// Native "Save As" picker for a custom location, where supported — falls
// back to the silent download (e.g. file:// origin, non-Chromium browser).
el.saveAsBtn.addEventListener("click", async () => {
  const json = JSON.stringify(computeParts(), null, 2);
  const filename = ensureJsonExt(el.fileName.value);
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      flashButton(el.saveAsBtn, "Saved!");
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return; // user cancelled
    }
  }
  downloadJSON(json, filename);
  flashButton(el.saveAsBtn, "Saved!");
});

// ---------- labels ----------

function updateLabels() {
  el.widVal.value = formatPrimary(state.width);
  el.hgtVal.value = formatPrimary(state.height);
  el.depVal.value = formatPrimary(state.depth);
  el.widMM.textContent = formatSecondary(state.width);
  el.hgtMM.textContent = formatSecondary(state.height);
  el.depMM.textContent = formatSecondary(state.depth);
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
  drawRowColPad();
  updateExport();
  updateFilename();
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

bindEditable(el.widVal, el.wid, "width");
bindEditable(el.hgtVal, el.hgt, "height");
bindEditable(el.depVal, el.dep, "depth");
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

el.wid.addEventListener("input", () => {
  state.width = parseFloat(el.wid.value);
  rebuildScene();
  updateLabels();
});
el.hgt.addEventListener("input", () => {
  state.height = parseFloat(el.hgt.value);
  rebuildScene();
  updateLabels();
});
el.dep.addEventListener("input", () => {
  state.depth = parseFloat(el.dep.value);
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
  el.braceSel.value = state.brace;
  el.braceFlip.textContent = state.braceFlip ? "\\" : "/";
  el.braceFlip.disabled = state.brace === "off";
  el.rowBraceSel.value = state.rowBrace;
  el.rowBraceFlip.textContent = state.rowBraceFlip ? "\\" : "/";
  el.rowBraceFlip.disabled = state.rowBrace === "off";
  el.colBraceSel.value = state.colBrace;
  el.colBraceFlip.textContent = state.colBraceFlip ? "\\" : "/";
  el.colBraceFlip.disabled = state.colBrace === "off";
  el.openFrontBtn.classList.toggle("active", state.openFront);
}

function bindBraceControl(sel, flipBtn, braceKey, flipKey) {
  sel.addEventListener("change", () => {
    state[braceKey] = sel.value;
    syncStructureUI();
    rebuildScene();
    updateLabels();
  });
  flipBtn.addEventListener("click", () => {
    state[flipKey] = !state[flipKey];
    syncStructureUI();
    rebuildScene();
    updateLabels();
  });
}
bindBraceControl(el.braceSel, el.braceFlip, "brace", "braceFlip");
bindBraceControl(el.rowBraceSel, el.rowBraceFlip, "rowBrace", "rowBraceFlip");
bindBraceControl(el.colBraceSel, el.colBraceFlip, "colBrace", "colBraceFlip");

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
  drawRowColPad();
});

function animate() {
  requestAnimationFrame(animate);
  connectorMaterial.uniforms.cameraPos.value.copy(camera.position);
  edgeMaterial.uniforms.cameraPos.value.copy(camera.position);
  braceMaterial.uniforms.cameraPos.value.copy(camera.position);
  controls.update();
  renderer.render(scene, camera);
}
animate();
