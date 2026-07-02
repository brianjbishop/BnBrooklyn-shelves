# BnBrooklyn — Shelf Pre-Vis

A parametric, self-contained 3D previewer for **BnBrooklyn**'s dowel-and-connector
shelving system — part of **COMMAND SPACE**, Brian's fabrication/design practice.
Full project background, existing physical designs, and hardware specs are in
[PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md).

The goal: preview a shelf frame's geometry and get an exact bill of materials
*before* modeling it in Blender or printing anything — length, height, width,
dowel diameter, print-bed tiling, and structural options (shelf decks, column
partitions, diagonal braces, open front) are all adjustable live, with the
resulting connector/dowel counts exportable as JSON.

## Using it

Open [`previs/index.html`](./previs/index.html) directly in a browser —
double-click it in Finder, or drag it into a browser tab. It's fully
self-contained (Three.js is bundled inline), so it needs no local server and
no internet connection after the file is loaded.

## What it does

- **Dimensions** — length, height, width sliders, each with a typed-input
  fallback (click the value, type a number, hit Enter). Inches/mm toggle.
- **Dowel Radius** — rod thickness; connector hub size scales with it.
- **Tiling pad** (top right) — an XY pad linking *max square size* (your
  print-bed constraint) to *divisions* (segments along the longest axis).
  They're one degree of freedom, so the handle rides a curve rather than
  filling the plane; drag or type either value.
- **Structure toggles** (bottom left) — diagonal bracing direction
  (none/left/right, square cells only — keeps every connector socket at a
  consistent angle), horizontal shelf decks (rows), vertical partitions
  (columns), and an open-front option that drops the front face's infill
  while keeping the perimeter framing.
- **Parts export** (bottom right) — live connector and dowel counts, broken
  out by connector type (named to match the physical `connectors_v1` family:
  3-way corner, 4-way T, 4-way intermediate, X-brace, etc.) and dowel length.
  "Copy JSON" puts the full spec on your clipboard.

Connector types and dowel lengths are derived from the actual generated
geometry, not hardcoded — so every new structural feature (divisions, rows,
columns, diagonals, open front) automatically produces correct, correctly-named
parts counts without changes to the export code.

## Developing it

Source lives in `previs/src/`:

- `app.js` — all scene/geometry/UI logic
- `template.html` — page shell and styles, with a `/*__BUNDLE__*/` marker

`previs/index.html` is a **build artifact** — never hand-edit it. After
changing anything in `src/`, rebuild it:

```sh
previs/build.sh
```

This bundles `app.js` (and Three.js) via esbuild into a single inline
`<script>`, injected into `template.html`, producing a new self-contained
`previs/index.html`. Commit both the source changes and the rebuilt
`index.html` together.

Why fully self-contained rather than loading Three.js from a CDN: the app
needs to keep working when opened as a bare file with no network access —
see PROJECT_CONTEXT.md's environment notes.
