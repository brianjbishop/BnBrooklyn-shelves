import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// World unit = 1 inch. Keeps grid math and slider ranges directly readable.
const MM_PER_INCH = 25.4;

const state = {
  unit: "mm",
  width: 54,  // X
  height: 36, // Y
  depth: 24,  // Z
  dowelRadius: 0.5, // 1" diameter closet rod default
  squareSize: 13.5, // max printable square edge; linked to the divisions count (4 divisions @ width 54)
  brace: "identity", // math function bracing the front/back faces only ("off" = none)
  braceFlip: true,   // mirror the brace across the cell (flips "/" <-> "\"); true = "\" (left) by default
  // Row Brace governs every x-z plane (top/bottom exterior faces AND
  // interior row decks); Col Brace governs every z-y plane (side exterior
  // faces AND interior column partitions) — "parallel" planes share one
  // brace function, independent of the front/back "Braces" control.
  rowBrace: "identity",
  rowBraceFlip: true,
  colBrace: "identity",
  colBraceFlip: true,
  // "Skip" is a stride: 0 = every interior cut gets a deck/partition, 1 =
  // every other, 2 = every 3rd, ... up to maxRowSkip/maxColSkip (the count
  // of interior cuts) = none at all. 999 is a sentinel that always clamps
  // down to "none" for the current geometry, matching the old rows/columns
  // default of off.
  rowSkip: 999,
  colSkip: 999,
  openFront: true,  // drop the +Z face's infill so it reads as a usable shelf

  connectorType: "T", // "T" (hub + socket stubs) | "blob" (solid rounded mass, no stubs)
  connectorColor: 0x0d0d0d,
  dowelColor: 0xd8b98a,
  braceColor: 0x9b6bd6,    // Depth (front/back) braces
  rowBraceColor: 0x9b6bd6,
  colBraceColor: 0x9b6bd6,

  // Per-element removal, keyed by stable position-derived strings (not
  // array index — index order shifts across rebuilds, position doesn't,
  // as long as the element's geometry didn't itself move). Toggled via
  // click in the 3D view; excluded from parts counts/export.
  removedConnectors: new Set(),
  removedDowels: new Set(),
  removedBraces: new Set(),
};

// Shared "recently used" color history across every picker in the app
// (connector/dowel/3 brace slots) — session-only, not saved to project files.
let recentColors = [];
function pushRecentColor(hex) {
  const h = hex.toLowerCase();
  recentColors = [h, ...recentColors.filter((c) => c !== h)].slice(0, 12);
}

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

// preserveDrawingBuffer so the canvas can be captured via toDataURL for the
// snapshot-export feature — otherwise the buffer may already be cleared by
// the time an export button click reads it.
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
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
// "Blob" connector mode has no protruding stubs, so the hub itself needs to
// read as a solid rounded mass covering where sockets would radiate out —
// bigger than the T-mode hub, which relies on stubs for that visual bulk.
const BLOB_TO_DOWEL_RATIO = 2.0;
// Socket "collars" (short stub cylinders per arm) read slightly thicker
// than the dowel they wrap, and extend a fraction of the hub radius.
const STUB_RADIUS_RATIO = 1.15;
const STUB_LENGTH_RATIO = 1.3;

// User-colorable per element kind (connector / dowel / each brace slot).
// White rim light by default — a black connector body stays readable as a
// silhouette against the dark scene even without direct color.
const connectorMaterial = makeShaderMaterial(state.connectorColor, 0xffffff);
const edgeMaterial = makeShaderMaterial(state.dowelColor, 0xf2b64c);
const braceMaterialBySlot = {
  depth: makeShaderMaterial(state.braceColor, 0xf2b64c),
  row: makeShaderMaterial(state.rowBraceColor, 0xf2b64c),
  col: makeShaderMaterial(state.colBraceColor, 0xf2b64c),
};
// Shared "removed" ghost appearance — one neutral gray regardless of kind,
// so a removed part reads as a consistent, deliberate absence.
const grayMaterial = makeShaderMaterial(0x57544a, 0x8a8672);
// Backface-shell outline: a slightly-scaled duplicate rendered back-face-only
// reads as a rim around the original mesh — cheap, no post-processing pass,
// fits the existing pooled-mesh render loop untouched.
const outlineMaterial = new THREE.MeshBasicMaterial({ color: 0xf2b64c, side: THREE.BackSide });

function setMaterialColor(mat, hex) {
  mat.uniforms.baseColor.value.set(hex);
}

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

// Stable identity for a world position, surviving rebuilds as long as the
// underlying geometry didn't itself move (e.g. dragging dowel radius or
// picking a color doesn't change any node position, so removal state set
// via click persists correctly; changing dimensions/tiling does move nodes,
// so old removed-keys simply go stale/orphaned — expected, not a bug).
function posKey(v) {
  return Math.round(v.x * 100) + "," + Math.round(v.y * 100) + "," + Math.round(v.z * 100);
}

let nodes = []; // world positions (inches), y=0 at the floor
let edges = []; // [nodeIndexA, nodeIndexB] — straight structural dowels
let braceSegs = [];       // flat list of [Vec3, Vec3] cylinder segments for curved braces
let braceSegMeta = [];    // parallel to braceSegs: { key, slot } — one physical brace instance per key
let braceTypeCounts = {}; // brace function key -> count of cells using it
let armDirs = [];    // parallel to nodes — unit vectors of each connector's arms
let armSources = []; // parallel to armDirs[i] — { kind: "dowel"|"brace", key } each arm came from,
                      // so a removed dowel/brace can be excluded from that connector's effective arms
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

// A trailing remainder strip narrower than this fraction of the dowel
// diameter would seat its connectors closer together than the rod they're
// printed around — not printable. Merge it into the previous cell instead
// of adding a doomed sliver (see the reference photo of two dowels almost
// touching at a too-close pair of connectors).
const MIN_SLIVER_RATIO = 1.0; // 100% of dowel diameter

function axisCuts(length) {
  const cuts = [0];
  for (let k = 1; k * state.squareSize < length - MERGE_TOL; k++) {
    cuts.push(k * state.squareSize);
  }
  const minGap = state.dowelRadius * 2 * MIN_SLIVER_RATIO;
  if (cuts.length > 1 && length - cuts[cuts.length - 1] < minGap) {
    cuts.pop();
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
  braceSegMeta = [];
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
  // slot identifies which of the 3 independently-colored brace families this
  // cell belongs to ("depth" | "row" | "col") and, combined with the corner
  // positions, gives every physical brace instance a stable removal-state key.
  const emit = (c, type, flip, slot) => {
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
    const instKey = slot + "|" + c.map((corner) => posKey(corner.pos)).sort().join("|");
    local.segs.forEach(([p, q]) => {
      braceSegs.push([to3D(p[0], p[1]), to3D(q[0], q[1])]);
      braceSegMeta.push({ key: instKey, slot, type });
    });
    local.arms.forEach(({ at, dir }) => {
      const id = c[(U(at[0]) ? 1 : 0) + (at[1] ? 2 : 0)].id;
      const p0 = to3D(at[0], at[1]);
      const p1 = to3D(at[0] + 0.001 * dir[0], at[1] + 0.001 * dir[1]);
      braceArms.push({ id, dir: p1.sub(p0).normalize(), key: instKey });
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
            emit([nodeRef(i, j, k), nodeRef(i + 1, j, k), nodeRef(i, j + 1, k), nodeRef(i + 1, j + 1, k)], brace, braceFlip, "depth");
    }
  }
  // Side faces + column partitions — every z-y plane (exterior boundary
  // AND interior planes selected by the skip pad) shares one Col Brace
  // function, so it reads as a consistent family of parallel braces.
  if (state.colBrace !== "off") {
    for (let i = 0; i < xs.length; i++) {
      const boundary = i === 0 || i === xs.length - 1;
      if (!boundary && !colsInclude(i)) continue;
      for (let k = 0; k + 1 < zs.length; k++)
        for (let j = 0; j + 1 < ys.length; j++)
          if (isSquare(zs[k + 1] - zs[k], ys[j + 1] - ys[j]))
            emit([nodeRef(i, j, k), nodeRef(i, j, k + 1), nodeRef(i, j + 1, k), nodeRef(i, j + 1, k + 1)], state.colBrace, state.colBraceFlip, "col");
    }
  }
  // Top/bottom faces + row decks — every x-z plane (exterior boundary AND
  // interior planes selected by the skip pad) shares one Row Brace function.
  if (state.rowBrace !== "off") {
    for (let j = 0; j < ys.length; j++) {
      const boundary = j === 0 || j === ys.length - 1;
      if (!boundary && !rowsInclude(j)) continue;
      for (let i = 0; i + 1 < xs.length; i++)
        for (let k = 0; k + 1 < zs.length; k++)
          if (isSquare(xs[i + 1] - xs[i], zs[k + 1] - zs[k]))
            emit([nodeRef(i, j, k), nodeRef(i + 1, j, k), nodeRef(i, j, k + 1), nodeRef(i + 1, j, k + 1)], state.rowBrace, state.rowBraceFlip, "row");
    }
  }

  // Arm directions per connector — straight rails plus brace endpoints —
  // feeds both the socket-stub geometry and the parts-list classifier.
  // armSources tags each arm with the dowel/brace it came from, so a
  // connector's *effective* arms (below) can exclude ones whose dowel or
  // brace has been individually removed.
  armDirs = nodes.map(() => []);
  armSources = nodes.map(() => []);
  edges.forEach(([ai, bi]) => {
    const dir = new THREE.Vector3().subVectors(nodes[bi], nodes[ai]).normalize();
    const key = dowelKey(ai, bi);
    armDirs[ai].push(dir);
    armSources[ai].push({ kind: "dowel", key });
    armDirs[bi].push(dir.clone().negate());
    armSources[bi].push({ kind: "dowel", key });
  });
  braceArms.forEach(({ id, dir, key }) => {
    armDirs[id].push(dir);
    armSources[id].push({ kind: "brace", key });
  });
}

// A connector's arms minus any whose source dowel/brace is individually
// removed — this is what classification/rendering should actually see, not
// the full authored geometry, so a removed brace's socket stops showing up
// on the connector it used to plug into.
function effectiveArmDirs(i) {
  const dirs = armDirs[i], sources = armSources[i];
  const out = [];
  for (let k = 0; k < dirs.length; k++) {
    const src = sources[k];
    const removed = src.kind === "dowel" ? state.removedDowels.has(src.key) : state.removedBraces.has(src.key);
    if (!removed) out.push(dirs[k]);
  }
  return out;
}
// A connector counts as removed either because it was explicitly clicked,
// or because every arm touching it has been removed out from under it —
// an orphaned hub with nothing plugged in serves no purpose, so it drops
// out of the view/BOM automatically rather than needing a separate click.
function isConnectorEffectivelyRemoved(i) {
  return state.removedConnectors.has(connKey(i)) || effectiveArmDirs(i).length === 0;
}

// Mesh pools — reused across rebuilds so slider drags don't churn objects.
// Each visible pool has a parallel "outline" pool: a slightly-scaled
// backface-only shell that reads as a rim around the original when shown —
// the mechanism behind the removed/hover visual states, with no
// post-processing pass and no change to the existing render loop.
const hubPool = [], hubOutlinePool = [];
const stubPool = [], stubOutlinePool = [];
const edgePool = [], edgeOutlinePool = [];
const bracePool = [], braceOutlinePool = [];
const OUTLINE_SCALE = 1.15;

const UP = new THREE.Vector3(0, 1, 0);
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

function ensurePool(pool, count, geometry, material) {
  while (pool.length < count) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    scene.add(mesh);
    pool.push(mesh);
  }
  pool.forEach((mesh, i) => {
    mesh.visible = i < count;
  });
}

function connKey(i) {
  return posKey(nodes[i]);
}
function dowelKey(ai, bi) {
  const a = posKey(nodes[ai]), b = posKey(nodes[bi]);
  return a < b ? a + "|" + b : b + "|" + a;
}

// key -> the pool indices making up that physical element, rebuilt every
// rebuildScene() call. meshToElement is the reverse direction, used by the
// raycaster to resolve a hit mesh back to an element identity.
let connectorIndex = new Map(); // key -> { hubI, stubIs: [] }
let dowelIndex = new Map();     // key -> edgeI
let braceIndex = new Map();     // key -> { segIs: [], slot }
let meshToElement = new Map();  // mesh -> { kind, key }

function rebuildScene() {
  generateFrame();
  const r = state.dowelRadius;
  const isBlob = state.connectorType === "blob";
  const hubR = r * (isBlob ? BLOB_TO_DOWEL_RATIO : HUB_TO_DOWEL_RATIO);
  const stubR = r * STUB_RADIUS_RATIO;
  const stubLen = hubR * STUB_LENGTH_RATIO;

  connectorIndex = new Map();
  dowelIndex = new Map();
  braceIndex = new Map();
  meshToElement = new Map();

  // ---- connectors: hub always; socket stubs only in "T" mode — "blob"
  // mode relies on the bigger hub alone to read as a solid rounded mass ----
  ensurePool(hubPool, nodes.length, hubGeometry, connectorMaterial);
  ensurePool(hubOutlinePool, nodes.length, hubGeometry, outlineMaterial);
  nodes.forEach((pos, i) => {
    hubPool[i].position.copy(pos);
    hubPool[i].scale.setScalar(hubR);
    hubOutlinePool[i].position.copy(pos);
    hubOutlinePool[i].scale.setScalar(hubR * OUTLINE_SCALE);
    meshToElement.set(hubPool[i], { kind: "connector", key: connKey(i) });
    connectorIndex.set(connKey(i), { hubI: i, stubIs: [] });
  });

  const stubList = []; // { pos, dir, nodeIndex }
  if (!isBlob) {
    nodes.forEach((pos, i) => effectiveArmDirs(i).forEach((dir) => stubList.push({ pos, dir, nodeIndex: i })));
  }
  ensurePool(stubPool, stubList.length, edgeGeometry, connectorMaterial);
  ensurePool(stubOutlinePool, stubList.length, edgeGeometry, outlineMaterial);
  stubList.forEach(({ pos, dir, nodeIndex }, i) => {
    _quat.setFromUnitVectors(UP, dir);
    const mesh = stubPool[i], outline = stubOutlinePool[i];
    mesh.position.copy(pos).addScaledVector(dir, stubLen / 2);
    mesh.quaternion.copy(_quat);
    mesh.scale.set(stubR, stubLen, stubR);
    outline.position.copy(mesh.position);
    outline.quaternion.copy(_quat);
    outline.scale.set(stubR * OUTLINE_SCALE, stubLen, stubR * OUTLINE_SCALE);
    const key = connKey(nodeIndex);
    meshToElement.set(mesh, { kind: "connector", key });
    connectorIndex.get(key).stubIs.push(i);
  });

  // ---- dowels ----
  ensurePool(edgePool, edges.length, edgeGeometry, edgeMaterial);
  ensurePool(edgeOutlinePool, edges.length, edgeGeometry, outlineMaterial);
  edges.forEach(([ai, bi], i) => {
    orientCylinder(edgePool[i], nodes[ai], nodes[bi], r);
    orientCylinder(edgeOutlinePool[i], nodes[ai], nodes[bi], r * OUTLINE_SCALE);
    const key = dowelKey(ai, bi);
    meshToElement.set(edgePool[i], { kind: "dowel", key });
    dowelIndex.set(key, i);
  });

  // ---- curved function braces — one cylinder per sampled segment ----
  const braceR = r * 0.8;
  ensurePool(bracePool, braceSegs.length, edgeGeometry, braceMaterialBySlot.depth);
  ensurePool(braceOutlinePool, braceSegs.length, edgeGeometry, outlineMaterial);
  braceSegs.forEach(([a, b], i) => {
    orientCylinder(bracePool[i], a, b, braceR);
    orientCylinder(braceOutlinePool[i], a, b, braceR * OUTLINE_SCALE);
    const { key, slot } = braceSegMeta[i];
    meshToElement.set(bracePool[i], { kind: "brace", key });
    const entry = braceIndex.get(key) || { segIs: [], slot };
    entry.segIs.push(i);
    braceIndex.set(key, entry);
  });

  applyAllVisualStates();
  controls.target.set(0, state.height / 2, 0);
}

// ---------- removed / hover visual states ----------
// 3 states per element: added (normal color, no outline), removed (gray
// fill + outline), hover (temporary preview — outline always, fill flips
// to the *other* state's color: gray if currently added, real color if
// currently removed). hovered tracks at most one element at a time.

function isElementRemoved(kind, key) {
  if (kind === "connector") {
    const entry = connectorIndex.get(key);
    return entry ? isConnectorEffectivelyRemoved(entry.hubI) : state.removedConnectors.has(key);
  }
  const set = kind === "dowel" ? state.removedDowels : state.removedBraces;
  return set.has(key);
}

let hovered = null; // { kind, key } | null

function applyElementVisual(kind, key) {
  const removedActual = isElementRemoved(kind, key);
  const isHover = !!hovered && hovered.kind === kind && hovered.key === key;
  const showRemoved = isHover ? !removedActual : removedActual;
  const showOutline = removedActual || isHover;

  if (kind === "connector") {
    const entry = connectorIndex.get(key);
    if (!entry) return;
    const mat = showRemoved ? grayMaterial : connectorMaterial;
    hubPool[entry.hubI].material = mat;
    hubOutlinePool[entry.hubI].visible = showOutline;
    entry.stubIs.forEach((i) => {
      stubPool[i].material = mat;
      stubOutlinePool[i].visible = showOutline;
    });
  } else if (kind === "dowel") {
    const i = dowelIndex.get(key);
    if (i === undefined) return;
    edgePool[i].material = showRemoved ? grayMaterial : edgeMaterial;
    edgeOutlinePool[i].visible = showOutline;
  } else if (kind === "brace") {
    const entry = braceIndex.get(key);
    if (!entry) return;
    const mat = showRemoved ? grayMaterial : braceMaterialBySlot[entry.slot];
    entry.segIs.forEach((i) => {
      bracePool[i].material = mat;
      braceOutlinePool[i].visible = showOutline;
    });
  }
}

function applyAllVisualStates() {
  connectorIndex.forEach((_, key) => applyElementVisual("connector", key));
  dowelIndex.forEach((_, key) => applyElementVisual("dowel", key));
  braceIndex.forEach((_, key) => applyElementVisual("brace", key));
}

rebuildScene();

// ---------- click-to-remove / hover preview ----------

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();

function pickableMeshes() {
  const list = [];
  hubPool.forEach((m) => m.visible && list.push(m));
  stubPool.forEach((m) => m.visible && list.push(m));
  edgePool.forEach((m) => m.visible && list.push(m));
  bracePool.forEach((m) => m.visible && list.push(m));
  return list;
}

function pickAt(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNDC, camera);
  const hits = raycaster.intersectObjects(pickableMeshes(), false);
  return hits.length ? meshToElement.get(hits[0].object) || null : null;
}

function setHovered(next) {
  const same = hovered && next && hovered.kind === next.kind && hovered.key === next.key;
  if (same) return;
  const prev = hovered;
  hovered = next;
  if (prev) applyElementVisual(prev.kind, prev.key);
  if (next) applyElementVisual(next.kind, next.key);
  renderer.domElement.style.cursor = next ? "pointer" : "";
}

renderer.domElement.addEventListener("pointermove", (e) => {
  if (e.buttons) return; // a held button means an orbit/pan drag — don't fight OrbitControls
  setHovered(pickAt(e.clientX, e.clientY));
});
renderer.domElement.addEventListener("pointerleave", () => setHovered(null));

let pointerDownPos = null;
renderer.domElement.addEventListener("pointerdown", (e) => {
  pointerDownPos = [e.clientX, e.clientY];
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!pointerDownPos) return;
  const dx = e.clientX - pointerDownPos[0], dy = e.clientY - pointerDownPos[1];
  pointerDownPos = null;
  if (dx * dx + dy * dy > 16) return; // moved more than a few px — an orbit drag, not a click
  const el = pickAt(e.clientX, e.clientY);
  if (!el) return;
  const set = el.kind === "connector" ? state.removedConnectors : el.kind === "dowel" ? state.removedDowels : state.removedBraces;
  if (set.has(el.key)) set.delete(el.key); else set.add(el.key);
  if (el.kind === "connector") {
    // Removing a connector doesn't change anyone else's arm count — a
    // targeted material/outline patch is enough, no need to touch geometry.
    applyElementVisual(el.kind, el.key);
  } else {
    // Removing a dowel or brace can shrink (or restore) the socket count on
    // the connector(s) it plugs into, and may orphan one to zero arms —
    // that changes actual stub geometry, so it needs a real rebuild, not
    // just a visual patch. Same cost as a slider drag; not a concern.
    rebuildScene();
  }
  updateExport();
});

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
  shuffleDims: document.getElementById("shuffleDims"),
  shuffleTiling: document.getElementById("shuffleTiling"),
  shuffleStructure: document.getElementById("shuffleStructure"),
  shuffleAll: document.getElementById("shuffleAll"),
  dowelCount: document.getElementById("dowelCount"),
  dowelBreakdown: document.getElementById("dowelBreakdown"),
  braceCount: document.getElementById("braceCount"),
  braceBreakdown: document.getElementById("braceBreakdown"),
  rcSkipDisplay: document.getElementById("rcSkipDisplay"),
  tabExportBtn: document.getElementById("tabExportBtn"),
  tabSaveLoadBtn: document.getElementById("tabSaveLoadBtn"),
  fileName: document.getElementById("fileName"),
  snapshotBtn: document.getElementById("snapshotBtn"),
  copyBtn: document.getElementById("copyBtn"),
  exportBtn: document.getElementById("exportBtn"),
  saveAsBtn: document.getElementById("saveAsBtn"),
  loadFile: document.getElementById("loadFile"),
  connTypeSel: document.getElementById("connTypeSel"),
  connSwatch: document.getElementById("connSwatch"),
  braceSwatch: document.getElementById("braceSwatch"),
  rowBraceSwatch: document.getElementById("rowBraceSwatch"),
  colBraceSwatch: document.getElementById("colBraceSwatch"),
  dwlSwatch: document.getElementById("dwlSwatch"),
  colorPicker: document.getElementById("colorPicker"),
  colorWheel: document.getElementById("colorWheel"),
  colorWheelKnob: document.getElementById("colorWheelKnob"),
  colorBright: document.getElementById("colorBright"),
  colorHex: document.getElementById("colorHex"),
  colorPreview: document.getElementById("colorPreview"),
  recentColorsRow: document.getElementById("recentColorsRow"),
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
  // Unitless (direction vectors, local u/v curve coords) — just trims float noise.
  const round4 = (v) => Math.round(v * 10000) / 10000;

  // Removed elements (toggled via click in the 3D view) don't need to be
  // printed — excluded from every count/breakdown below.
  const byLength = new Map();
  edges.forEach(([ai, bi], i) => {
    if (state.removedDowels.has(dowelKey(ai, bi))) return;
    const len = toUnit(nodes[ai].distanceTo(nodes[bi]));
    byLength.set(len, (byLength.get(len) || 0) + 1);
  });
  const dowelCount = [...byLength.values()].reduce((a, b) => a + b, 0);

  // One representative arm-vector set per distinct connector type — every
  // node classified the same way has congruent arm geometry (that's what
  // the classifier guarantees), so this is the one shape a fabrication
  // pipeline needs per type, not one per node.
  const byType = new Map();
  const typeArmVectors = new Map();
  armDirs.forEach((_, i) => {
    if (isConnectorEffectivelyRemoved(i)) return;
    const dirs = effectiveArmDirs(i);
    const type = classifyConnector(dirs);
    byType.set(type, (byType.get(type) || 0) + 1);
    if (!typeArmVectors.has(type)) {
      typeArmVectors.set(
        type,
        dirs.map((d) => ({ x: round4(d.x), y: round4(d.y), z: round4(d.z) }))
      );
    }
  });
  const connectorCount = [...byType.values()].reduce((a, b) => a + b, 0);

  // Braces: count each physical instance (keyed the same way as the
  // removal-state click target) once, not once per rendered segment.
  const filteredBraceTypeCounts = {};
  const seenBraceInstances = new Set();
  braceSegMeta.forEach(({ key, type }) => {
    if (state.removedBraces.has(key) || seenBraceInstances.has(key)) return;
    seenBraceInstances.add(key);
    filteredBraceTypeCounts[type] = (filteredBraceTypeCounts[type] || 0) + 1;
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
      count: connectorCount,
      // hubRadius is informational (dowelRadius * HUB_TO_DOWEL_RATIO) — the
      // socket ID a fabrication pipeline should actually cut is a printing
      // tolerance decision (see connectors_v1: dowel diameter + ~0.3mm/side
      // clearance), not something this tool bakes in.
      hubRadius: toFine(state.dowelRadius * HUB_TO_DOWEL_RATIO),
      byType: [...byType.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({ type, count, armVectors: typeArmVectors.get(type) })),
    },
    dowels: {
      count: dowelCount,
      radius: toFine(state.dowelRadius),
      diameter: toFine(state.dowelRadius * 2),
      byLength: [...byLength.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([length, count]) => ({ length, count })),
    },
    braces: {
      count: Object.values(filteredBraceTypeCounts).reduce((a, b) => a + b, 0),
      // polyline/arms are in local unit-cell (u,v) coords, u,v in [0,1] —
      // scale by cellSize (same unit as the rest of this export) to get
      // real-world points. A flipped brace is the same physical part
      // installed rotated 180°, not a different shape, so flip doesn't
      // create a second entry here (verified: every brace cell is planar,
      // and a planar curve's mirror image is always reachable by physically
      // turning the printed part over).
      byType: Object.entries(filteredBraceTypeCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => {
          const local = buildBraceLocal(key);
          return {
            type: BRACE_NAMES[key] || key,
            count,
            cellSize: toFine(state.squareSize),
            radius: toFine(state.dowelRadius * 0.8),
            polyline: local.segs.map(([p, q]) => [
              [round4(p[0]), round4(p[1])],
              [round4(q[0]), round4(q[1])],
            ]),
            arms: local.arms.map((a) => ({ at: a.at.map(round4), dir: a.dir.map(round4) })),
          };
        }),
    },
  };
}

function hexNumToStr(n) {
  return "#" + Math.max(0, Math.min(0xffffff, n | 0)).toString(16).padStart(6, "0");
}
function hexStrToNum(s, fallback) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s || "");
  return m ? parseInt(m[1], 16) : fallback;
}

// A project file captures every parameter needed to exactly reproduce this
// design — unlike the parts BOM above, it's meant to be loaded back in.
function serializeState() {
  return {
    app: "cartesian-shelf",
    version: 1,
    unit: state.unit,
    width: state.width,
    height: state.height,
    depth: state.depth,
    dowelRadius: state.dowelRadius,
    squareSize: state.squareSize,
    brace: state.brace,
    braceFlip: state.braceFlip,
    rowBrace: state.rowBrace,
    rowBraceFlip: state.rowBraceFlip,
    colBrace: state.colBrace,
    colBraceFlip: state.colBraceFlip,
    rowSkip: state.rowSkip,
    colSkip: state.colSkip,
    openFront: state.openFront,
    connectorType: state.connectorType,
    connectorColor: hexNumToStr(state.connectorColor),
    dowelColor: hexNumToStr(state.dowelColor),
    braceColor: hexNumToStr(state.braceColor),
    rowBraceColor: hexNumToStr(state.rowBraceColor),
    colBraceColor: hexNumToStr(state.colBraceColor),
    removedConnectors: [...state.removedConnectors],
    removedDowels: [...state.removedDowels],
    removedBraces: [...state.removedBraces],
  };
}

// Restores state from a loaded project file. Every field is validated and
// clamped against the same bounds the sliders/dropdowns enforce, so a
// hand-edited or stale file can't push the app into a broken state.
function applyLoadedState(obj) {
  if (!obj || typeof obj !== "object") throw new Error("Not a valid project file.");
  const clampNum = (v, min, max, fallback) =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  const braceKeys = new Set(["off", ...Object.keys(BRACE_NAMES)]);
  const validBrace = (v, fallback) => (braceKeys.has(v) ? v : fallback);
  const bool = (v, fallback) => (typeof v === "boolean" ? v : fallback);

  state.unit = obj.unit === "mm" || obj.unit === "in" ? obj.unit : state.unit;
  state.width = clampNum(obj.width, parseFloat(el.wid.min), parseFloat(el.wid.max), state.width);
  state.height = clampNum(obj.height, parseFloat(el.hgt.min), parseFloat(el.hgt.max), state.height);
  state.depth = clampNum(obj.depth, parseFloat(el.dep.min), parseFloat(el.dep.max), state.depth);
  state.dowelRadius = clampNum(obj.dowelRadius, parseFloat(el.dwl.min), parseFloat(el.dwl.max), state.dowelRadius);
  state.squareSize = clampNum(obj.squareSize, SQS_MIN, SQS_MAX, state.squareSize);
  state.brace = validBrace(obj.brace, state.brace);
  state.braceFlip = bool(obj.braceFlip, state.braceFlip);
  state.rowBrace = validBrace(obj.rowBrace, state.rowBrace);
  state.rowBraceFlip = bool(obj.rowBraceFlip, state.rowBraceFlip);
  state.colBrace = validBrace(obj.colBrace, state.colBrace);
  state.colBraceFlip = bool(obj.colBraceFlip, state.colBraceFlip);
  state.rowSkip = clampNum(obj.rowSkip, 0, 999, state.rowSkip);
  state.colSkip = clampNum(obj.colSkip, 0, 999, state.colSkip);
  state.openFront = bool(obj.openFront, state.openFront);

  state.connectorType = obj.connectorType === "blob" ? "blob" : "T";
  state.connectorColor = hexStrToNum(obj.connectorColor, state.connectorColor);
  state.dowelColor = hexStrToNum(obj.dowelColor, state.dowelColor);
  state.braceColor = hexStrToNum(obj.braceColor, state.braceColor);
  state.rowBraceColor = hexStrToNum(obj.rowBraceColor, state.rowBraceColor);
  state.colBraceColor = hexStrToNum(obj.colBraceColor, state.colBraceColor);
  setMaterialColor(connectorMaterial, state.connectorColor);
  setMaterialColor(edgeMaterial, state.dowelColor);
  setMaterialColor(braceMaterialBySlot.depth, state.braceColor);
  setMaterialColor(braceMaterialBySlot.row, state.rowBraceColor);
  setMaterialColor(braceMaterialBySlot.col, state.colBraceColor);
  state.removedConnectors = new Set(Array.isArray(obj.removedConnectors) ? obj.removedConnectors : []);
  state.removedDowels = new Set(Array.isArray(obj.removedDowels) ? obj.removedDowels : []);
  state.removedBraces = new Set(Array.isArray(obj.removedBraces) ? obj.removedBraces : []);

  el.wid.value = state.width;
  el.hgt.value = state.height;
  el.dep.value = state.depth;
  el.dwl.value = state.dowelRadius;
  el.unitIn.classList.toggle("active", state.unit === "in");
  el.unitMM.classList.toggle("active", state.unit === "mm");

  filenameDirty = false; // a freshly-loaded project re-derives its filename
  syncStructureUI();
  syncColorSwatches();
  rebuildScene();
  updateLabels();
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

// ---------- export tabs: parts BOM vs. full project save/load ----------
// "Export" copies/saves the parts bill-of-materials (computeParts, as
// before). "Save / Load" copies/saves every parameter (serializeState) so
// the exact design can be restored later — and repurposes the copy button
// as the load trigger, since a clipboard "copy" has no load equivalent.

let exportTab = "export";

function currentPayloadObject() {
  return exportTab === "saveload" ? serializeState() : computeParts();
}

function syncExportTabUI() {
  el.tabExportBtn.classList.toggle("active", exportTab === "export");
  el.tabSaveLoadBtn.classList.toggle("active", exportTab === "saveload");
  el.copyBtn.textContent = exportTab === "saveload" ? "Load Project…" : "Copy JSON";
  el.exportBtn.textContent = exportTab === "saveload" ? "Save Project" : "Export";
}
el.tabExportBtn.addEventListener("click", () => {
  exportTab = "export";
  syncExportTabUI();
});
el.tabSaveLoadBtn.addEventListener("click", () => {
  exportTab = "saveload";
  syncExportTabUI();
});
syncExportTabUI();

el.copyBtn.addEventListener("click", async () => {
  if (exportTab === "saveload") {
    el.loadFile.click();
    return;
  }
  const json = JSON.stringify(currentPayloadObject(), null, 2);
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

el.loadFile.addEventListener("change", async () => {
  const file = el.loadFile.files[0];
  el.loadFile.value = ""; // allow reselecting the same file later
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    applyLoadedState(obj);
    flashButton(el.copyBtn, "Loaded!");
  } catch (err) {
    const box = document.getElementById("errbox");
    box.style.display = "block";
    box.textContent = "Couldn't load project file:\n" + (err && err.message ? err.message : String(err));
  }
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

// Captures the current 3D view as a standalone PNG — same base name as
// whatever's in the filename field, .png instead of .json.
function downloadSnapshot(jsonFilename) {
  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = jsonFilename.replace(/\.json$/i, "") + ".png";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function flashIcon(btn) {
  btn.classList.add("copied");
  setTimeout(() => btn.classList.remove("copied"), 1200);
}
el.snapshotBtn.addEventListener("click", () => {
  downloadSnapshot(ensureJsonExt(el.fileName.value));
  flashIcon(el.snapshotBtn);
});

// Silent save straight to the browser's default download location.
el.exportBtn.addEventListener("click", () => {
  const json = JSON.stringify(currentPayloadObject(), null, 2);
  downloadJSON(json, ensureJsonExt(el.fileName.value));
  flashButton(el.exportBtn, "Saved!");
});

// Native "Save As" picker for a custom location, where supported — falls
// back to the silent download (e.g. file:// origin, non-Chromium browser).
el.saveAsBtn.addEventListener("click", async () => {
  const json = JSON.stringify(currentPayloadObject(), null, 2);
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
  el.connTypeSel.value = state.connectorType;
}

// Sets a swatch button's background to the given color, picking a readable
// text color (dark-on-light or light-on-dark) by relative luminance so the
// label stays legible across the full color range.
function paintSwatch(btn, hexNum) {
  const hex = hexNumToStr(hexNum);
  btn.style.background = hex;
  const r = (hexNum >> 16) & 255, g = (hexNum >> 8) & 255, b = hexNum & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  btn.style.color = luminance > 0.55 ? "#14140f" : "#f2ede0";
}

function syncColorSwatches() {
  paintSwatch(el.connSwatch, state.connectorColor);
  paintSwatch(el.dwlSwatch, state.dowelColor);
  paintSwatch(el.braceSwatch, state.braceColor);
  paintSwatch(el.rowBraceSwatch, state.rowBraceColor);
  paintSwatch(el.colBraceSwatch, state.colBraceColor);
}
syncColorSwatches();

el.connTypeSel.addEventListener("change", () => {
  state.connectorType = el.connTypeSel.value === "blob" ? "blob" : "T";
  rebuildScene();
  updateLabels();
});

// ---------- color picker: hue/saturation wheel + brightness + hex + recents ----------

function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : d / max, max];
}
function rgbToHexNum(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

let pickerState = null; // { h, s, v, onChange } while the popover is open

function drawColorWheel() {
  const canvas = el.colorWheel;
  const size = canvas.width;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const cx = size / 2, cy = size / 2, radius = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;
      if (dist > radius) continue; // leave alpha 0 — transparent outside the disc
      let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (angle < 0) angle += 360;
      const [r, g, b] = hsvToRgb(angle, Math.min(1, dist / radius), 1);
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
drawColorWheel();

function updateKnobPosition() {
  const radius = el.colorWheel.clientWidth / 2;
  const rad = (pickerState.h * Math.PI) / 180;
  el.colorWheelKnob.style.left = radius + Math.cos(rad) * pickerState.s * radius + "px";
  el.colorWheelKnob.style.top = radius + Math.sin(rad) * pickerState.s * radius + "px";
}
function currentPickerHex() {
  const [r, g, b] = hsvToRgb(pickerState.h, pickerState.s, pickerState.v);
  return rgbToHexNum(r, g, b);
}
function refreshPickerUI(fromHexInput) {
  const hexNum = currentPickerHex();
  updateKnobPosition();
  const [r, g, b] = hsvToRgb(pickerState.h, pickerState.s, 1);
  el.colorBright.style.background = `linear-gradient(to right, #000, rgb(${r},${g},${b}))`;
  el.colorPreview.style.background = hexNumToStr(hexNum);
  if (!fromHexInput) el.colorHex.value = hexNumToStr(hexNum);
  el.colorBright.value = Math.round(pickerState.v * 100);
  if (pickerState.onChange) pickerState.onChange(hexNum);
}

function renderRecentColors() {
  el.recentColorsRow.innerHTML = "";
  recentColors.forEach((hex) => {
    const sw = document.createElement("button");
    sw.className = "recentSwatch";
    sw.style.background = hex;
    sw.addEventListener("click", () => {
      const n = hexStrToNum(hex, currentPickerHex());
      const [h, s, v] = rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255);
      pickerState.h = h; pickerState.s = s; pickerState.v = v;
      refreshPickerUI();
    });
    el.recentColorsRow.appendChild(sw);
  });
}

function wheelPointerToHS(clientX, clientY) {
  const rect = el.colorWheel.getBoundingClientRect();
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  return [angle, Math.min(1, Math.sqrt(dx * dx + dy * dy) / (rect.width / 2))];
}

let wheelDragging = false;
el.colorWheel.addEventListener("pointerdown", (e) => {
  wheelDragging = true;
  el.colorWheel.setPointerCapture(e.pointerId);
  [pickerState.h, pickerState.s] = wheelPointerToHS(e.clientX, e.clientY);
  refreshPickerUI();
});
el.colorWheel.addEventListener("pointermove", (e) => {
  if (!wheelDragging) return;
  [pickerState.h, pickerState.s] = wheelPointerToHS(e.clientX, e.clientY);
  refreshPickerUI();
});
window.addEventListener("pointerup", () => { wheelDragging = false; });

el.colorBright.addEventListener("input", () => {
  pickerState.v = el.colorBright.value / 100;
  refreshPickerUI();
});

el.colorHex.addEventListener("input", () => {
  const n = hexStrToNum(el.colorHex.value, null);
  if (n === null) return;
  [pickerState.h, pickerState.s, pickerState.v] = rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255);
  refreshPickerUI(true);
});

function openColorPicker(anchorEl, currentHexNum, onChange) {
  const [h, s, v] = rgbToHsv((currentHexNum >> 16) & 255, (currentHexNum >> 8) & 255, currentHexNum & 255);
  pickerState = { h, s, v, onChange };

  // display must flip to "block" before anything reads layout (clientWidth
  // etc.) — while display:none, every child reports 0, which is exactly
  // what was sending the wheel knob to (0,0) on every open.
  el.colorPicker.style.display = "block";
  renderRecentColors();
  refreshPickerUI();

  const rect = anchorEl.getBoundingClientRect();
  const popW = el.colorPicker.offsetWidth || 190;
  const popH = el.colorPicker.offsetHeight || 380;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - popW - 8));
  // Prefer opening below the anchor; flip above if it wouldn't fit, then
  // clamp either way so it's never pushed off the top or bottom edge.
  let top = rect.bottom + 8;
  if (top + popH > window.innerHeight - 8) top = rect.top - popH - 8;
  top = Math.max(8, Math.min(top, window.innerHeight - popH - 8));
  el.colorPicker.style.left = left + "px";
  el.colorPicker.style.top = top + "px";
}

function closeColorPicker(commit) {
  if (!pickerState) return;
  if (commit) pushRecentColor(hexNumToStr(currentPickerHex()));
  pickerState = null;
  el.colorPicker.style.display = "none";
}

el.colorPicker.addEventListener("pointerdown", (e) => e.stopPropagation());
document.addEventListener("pointerdown", (e) => {
  if (pickerState && !el.colorPicker.contains(e.target)) closeColorPicker(true);
});
document.addEventListener("keydown", (e) => {
  if (pickerState && e.key === "Escape") closeColorPicker(true);
});

function bindColorSwatch(swatchEl, getHex, setHex) {
  swatchEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  swatchEl.addEventListener("click", () => {
    openColorPicker(swatchEl, getHex(), (hexNum) => {
      setHex(hexNum);
      syncColorSwatches();
    });
  });
}

bindColorSwatch(el.connSwatch, () => state.connectorColor, (n) => { state.connectorColor = n; setMaterialColor(connectorMaterial, n); });
bindColorSwatch(el.dwlSwatch, () => state.dowelColor, (n) => { state.dowelColor = n; setMaterialColor(edgeMaterial, n); });
bindColorSwatch(el.braceSwatch, () => state.braceColor, (n) => { state.braceColor = n; setMaterialColor(braceMaterialBySlot.depth, n); });
bindColorSwatch(el.rowBraceSwatch, () => state.rowBraceColor, (n) => { state.rowBraceColor = n; setMaterialColor(braceMaterialBySlot.row, n); });
bindColorSwatch(el.colBraceSwatch, () => state.colBraceColor, (n) => { state.colBraceColor = n; setMaterialColor(braceMaterialBySlot.col, n); });

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

// ---------- randomize ----------

function randFloat(min, max) {
  return min + Math.random() * (max - min);
}
function randInt(min, max) {
  return Math.floor(randFloat(min, max + 1));
}
function randPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomizeDimensions() {
  state.width = Math.round(randFloat(parseFloat(el.wid.min), parseFloat(el.wid.max)) * 10) / 10;
  state.height = Math.round(randFloat(parseFloat(el.hgt.min), parseFloat(el.hgt.max)) * 10) / 10;
  state.depth = Math.round(randFloat(parseFloat(el.dep.min), parseFloat(el.dep.max)) * 10) / 10;
  state.dowelRadius = Math.round(randFloat(parseFloat(el.dwl.min), parseFloat(el.dwl.max)) * 20) / 20;
  el.wid.value = state.width;
  el.hgt.value = state.height;
  el.dep.value = state.depth;
  el.dwl.value = state.dowelRadius;
  rebuildScene();
  updateLabels();
}

// Picks a random division count (rather than a raw square size) so the
// result stays a sane, visibly-tiled shelf instead of an arbitrary sliver.
function randomizeTiling() {
  setDivisions(randInt(1, 8));
}

function randomizeStructure() {
  const braceKeys = ["off", ...Object.keys(BRACE_NAMES)];
  state.brace = randPick(braceKeys);
  state.braceFlip = Math.random() < 0.5;
  state.rowBrace = randPick(braceKeys);
  state.rowBraceFlip = Math.random() < 0.5;
  state.colBrace = randPick(braceKeys);
  state.colBraceFlip = Math.random() < 0.5;
  state.rowSkip = randInt(0, maxRowSkip());
  state.colSkip = randInt(0, maxColSkip());
  state.openFront = Math.random() < 0.5;
  syncStructureUI();
  rebuildScene();
  updateLabels();
}

// Random hue at a constrained saturation/value range — avoids the muddy or
// neon-garish results of uniform RGB random while still covering the full
// color wheel.
function randomNiceColor() {
  const [r, g, b] = hsvToRgb(randFloat(0, 360), randFloat(0.45, 0.85), randFloat(0.55, 0.95));
  return rgbToHexNum(r, g, b);
}

// Colors change far less often than everything else the shuffle button
// touches — each of the 5 is independently re-rolled at a low probability,
// so most shuffles leave colors alone and only occasionally nudge one.
const COLOR_SHUFFLE_CHANCE = 0.18;
function randomizeColors() {
  const maybe = (setter) => {
    if (Math.random() < COLOR_SHUFFLE_CHANCE) setter(randomNiceColor());
  };
  maybe((c) => { state.connectorColor = c; setMaterialColor(connectorMaterial, c); });
  maybe((c) => { state.dowelColor = c; setMaterialColor(edgeMaterial, c); });
  maybe((c) => { state.braceColor = c; setMaterialColor(braceMaterialBySlot.depth, c); });
  maybe((c) => { state.rowBraceColor = c; setMaterialColor(braceMaterialBySlot.row, c); });
  maybe((c) => { state.colBraceColor = c; setMaterialColor(braceMaterialBySlot.col, c); });
  syncColorSwatches();
}

// Order matters: tiling's division range and structure's skip ranges both
// depend on the current dimensions, and structure's skip range also
// depends on square size — so dimensions, then tiling, then structure.
function randomizeAll() {
  randomizeDimensions();
  randomizeTiling();
  randomizeStructure();
  randomizeColors();
}

el.shuffleDims.addEventListener("click", randomizeDimensions);
el.shuffleTiling.addEventListener("click", randomizeTiling);
el.shuffleStructure.addEventListener("click", randomizeStructure);
el.shuffleAll.addEventListener("click", randomizeAll);

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

const shaderMaterials = [connectorMaterial, edgeMaterial, grayMaterial, ...Object.values(braceMaterialBySlot)];
function animate() {
  requestAnimationFrame(animate);
  shaderMaterials.forEach((mat) => mat.uniforms.cameraPos.value.copy(camera.position));
  controls.update();
  renderer.render(scene, camera);
}
animate();
