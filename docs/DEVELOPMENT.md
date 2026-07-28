# ProSpacer Development Guide

This guide covers local setup, daily workflows, verification tools, asset generation, debugging, and release preparation.

## Prerequisites

| Tool | Requirement | Used for |
|---|---|---|
| Node.js | `20.19+` or `22.12+` | Runtime tooling |
| npm | Bundled with Node.js | Reproducible dependency installation |
| Chromium | Installed by Playwright when required | Automated interaction and capture |
| WebGL2-capable GPU | Hardware acceleration enabled | Runtime and visual verification |
| Blender + BlenderMCP | Optional | Interior and terrain asset baking |
| FFmpeg | Optional | Trailer/capture editing |

## Setup

```bash
git clone https://github.com/jennofrie/ProSpacer.git
cd ProSpacer
npm ci
npm run dev
```

Vite serves the game at [http://localhost:5173](http://localhost:5173).

Use `npm ci` for clean and CI-equivalent installs. Use `npm install` only when intentionally changing dependencies and committing the resulting lockfile.

## Core workflows

### Runtime development

```bash
npm run dev
```

Vite hot reload is useful for UI and shader iteration. Some capture tools deliberately wait for the boot overlay to disappear because a reload can otherwise produce a plausible but invalid screenshot.

### Production validation

```bash
npm run check
npm run preview
```

`npm run check` verifies ownership/branding integrity and builds the optimized application.

### Browser interaction pass

Start the development server in one terminal, then:

```bash
npm run smoke
node tools/play.mjs
```

`play.mjs` exercises flight, scanning, landing, fold travel, archive behavior, and navigation. Keep assertions deterministic and avoid visual timing assumptions when a state condition is available.

## Tool map

| Tool | Purpose |
|---|---|
| `tools/boot.mjs` | Reliably enter a ready game state after reloads |
| `tools/play.mjs` | Interaction assertions |
| `tools/smoke.mjs` | Fast browser startup check |
| `tools/survey.mjs` | Capture set pieces with FPS/draw statistics |
| `tools/probe.mjs` | Evaluate one browser expression and optionally capture a frame |
| `tools/shot.mjs` | Capture a configured shot |
| `tools/sheet.mjs` | Build a visual contact sheet |
| `tools/levels.mjs` | Report image luminance and clipping statistics |
| `tools/passcost.mjs` | Compare render-pass cost |
| `tools/drawcost.mjs` | Inspect draw-call contributors |
| `tools/perfprobe.mjs` | Sample runtime performance |
| `tools/fieldcheck.mjs` | Compare terrain field implementations |
| `tools/aocheck.mjs` | Inspect ambient-occlusion output |
| `tools/leaks.mjs` | Look for lifecycle/resource regressions |
| `tools/capture.mjs` | Capture launch/trailer sequences |
| `tools/edit.mjs` | Assemble launch footage |

Tools that drive a browser expect the development server unless their usage text says otherwise.

## Debugging

### Runtime handle

The game exposes `window.__game` for development tooling. Prefer read-only inspection in the console; permanent behavior belongs in source.

### Frame statistics

Press `P` to show the runtime statistics layer. Compare:

- frame time;
- render scale;
- draw calls;
- triangle count;
- active mode and scene.

### Fixed-seed reproduction

A useful issue report records:

- commit SHA;
- browser and GPU renderer;
- viewport and device pixel ratio;
- quality tier and render scale;
- galaxy/system/body seed;
- player mode and camera;
- exact input sequence;
- screenshot or short capture.

### Shader failures

When a shader fails:

1. capture the complete compiler message;
2. identify the generated material and quality tier;
3. check shared chunk inclusion and log-depth definitions;
4. reduce with the same defines and precision;
5. verify on at least two GPU vendors when possible.

## Adding dependencies

Before adding a runtime dependency:

1. explain why existing code or a small local utility is insufficient;
2. check maintenance, license, bundle size, and browser support;
3. measure the production bundle;
4. keep development-only packages in `devDependencies`;
5. commit `package.json` and `package-lock.json` together.

Dependency license metadata must remain intact.

## Asset pipeline

### Interior assets

The optional Blender pipeline writes to `public/models/`:

```bash
python3 tools/bake_interior.py
python3 tools/bake_interior.py tiles
python3 tools/bake_interior.py kit
python3 tools/bake_interior.py soft
```

The pipeline expects a connected BlenderMCP socket for Blender-side operations. Paths are derived from the repository, not a developer-specific home directory.

### Terrain assets

`tools/bake_terrain.py` generates terrain texture inputs. Record tool versions and parameters when outputs change.

### Asset review checklist

- Source and generator changes are committed.
- Output dimensions and formats are intentional.
- Albedo is evaluated in the expected color space.
- Normal and ORM textures use non-color sampling.
- Mip behavior is inspected at oblique distance.
- GLB attribute and material counts are checked.
- Bundle and load-size deltas are recorded.

## Deployment

The production output is a static Vite bundle. `wrangler.jsonc` is configured for static assets but intentionally contains no custom domain. Add deployment routing only after the target domain and ownership are confirmed.

```bash
npm run deploy
```

Never commit provider tokens or local Wrangler state.

## Release checklist

1. Update `CHANGELOG.md`.
2. Confirm version and metadata in `package.json`.
3. Run `npm ci`.
4. Run `npm audit`.
5. Run `npm run check`.
6. Run interaction and representative visual surveys.
7. Compare performance baselines.
8. Inspect social metadata and installable manifest.
9. Verify all Markdown notices with `npm run check:branding`.
10. Tag only the commit that produced the verified build.

## Troubleshooting

<details>
<summary><strong>The boot screen never enables WAKE</strong></summary>

Check the browser console for WebGL2, shader compilation, or asset-fetch errors. Confirm hardware acceleration is enabled and the model files under `public/models/` return HTTP 200.

</details>

<details>
<summary><strong>Automated captures show the title screen</strong></summary>

Use the shared boot helper and wait for the ready state instead of a fixed delay. Hot reload can restart initialization after navigation.

</details>

<details>
<summary><strong>The build succeeds but a world surface shimmers</strong></summary>

Inspect sampling scale, derivatives, and LOD transitions. Procedural detail must be band-limited against the mesh spacing in the vertex stage and the pixel footprint in the fragment stage.

</details>

---

ProSpacer™ and its visual identity are trademarks of Profexor. Copyright © 2026 Profexor. The software is licensed under the [MIT License](../LICENSE); trademark rights are not granted by the software license.
