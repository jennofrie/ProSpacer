# Contributing to ProSpacer

ProSpacer welcomes focused improvements that preserve its deterministic world, coherent cockpit experience, and measurable rendering performance. The project is created and maintained by Profexor.

## Before starting

1. Search existing issues and the [roadmap](ROADMAP.md).
2. Open an enhancement proposal before large gameplay, rendering, dependency, or architecture changes.
3. Keep each branch and pull request focused on one outcome.
4. Read [ARCHITECTURE.md](ARCHITECTURE.md), [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), and [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Local setup

```bash
git clone https://github.com/jennofrie/ProSpacer.git
cd ProSpacer
npm ci
npm run dev
```

Use a Node.js version supported by Vite (`20.19+` or `22.12+`).

## Branch naming

Use a short category and subject:

- `feature/save-migrations`
- `fix/fold-transition-depth`
- `perf/terrain-shadow-budget`
- `docs/encounter-authoring`
- `chore/dependency-refresh`

## Commit style

Write imperative, scoped commit messages:

```text
feat(archive): add discovery filters
fix(surface): stabilize distant ridge sampling
perf(postfx): merge low-tier bloom passes
docs(architecture): record save schema boundary
```

Avoid mixing mechanical formatting, generated assets, and behavioral changes in one commit.

## Quality gates

Run before every pull request:

```bash
npm ci
npm run check
```

For gameplay or renderer changes, also run the relevant tools:

```bash
npm run smoke
node tools/play.mjs
node tools/survey.mjs
node tools/levels.mjs shots/*.png
```

Document any platform-specific tool requirements and attach fixed-seed evidence for visual changes.

## Engineering expectations

### JavaScript

- Use ES modules.
- Keep per-frame allocations out of hot paths.
- Reuse scratch vectors, matrices, colors, and buffers.
- Make transitions idempotent when they can be interrupted.
- Keep development-only tooling outside runtime imports.

### Three.js and GLSL

- Measure draw calls, shader variants, GPU time, and render-target memory.
- Preserve logarithmic-depth support where overlapping astronomical geometry requires it.
- Band-limit procedural detail against mesh and pixel scale.
- Merge static geometry where material and interaction boundaries allow it.
- Provide a lower-cost behavior for expensive effects.

### Procedural generation

- Derive randomness from stable seeds.
- Do not depend on iteration or frame order unless it is explicitly versioned.
- Add representative seeds for regression review.
- Consider save compatibility before changing generation order or ranges.

### Documentation

- Update the architecture, development guide, roadmap, or changelog when behavior changes.
- Every Markdown file must retain the ProSpacer™ and Profexor notice.
- Do not remove or weaken the MIT copyright notice or trademark policy.

## Pull requests

A strong pull request includes:

- the player or engineering problem;
- a concise implementation summary;
- screenshots or captures for visual changes;
- performance before/after data for rendering changes;
- deterministic seeds and reproduction steps;
- tests and tools run;
- save, input, accessibility, and deployment impact;
- documentation updates.

Maintainer approval is required for changes to `LICENSE`, ownership metadata, trademark policy, brand assets, CI integrity checks, and project Markdown notices.

## Generated and baked assets

Do not hand-edit generated textures or GLB output without documenting the source. Include:

- the generating script and command;
- source parameters;
- tool version;
- output size change;
- visual comparison;
- runtime performance impact.

## Reporting security issues

Do not open public issues for exploitable security findings. Follow [SECURITY.md](SECURITY.md).

## Community expectations

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---

ProSpacer™ and its visual identity are trademarks of Profexor. Copyright © 2026 Profexor. The software is licensed under the [MIT License](LICENSE); trademark rights are not granted by the software license.
