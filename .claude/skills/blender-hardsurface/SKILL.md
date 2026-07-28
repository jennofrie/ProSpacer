---
name: blender-hardsurface
description: Model, light and render hard-surface spacecraft in Blender through the BlenderMCP socket, in this game's art direction. Load when asked to build a ship/station/asset in Blender, drive Blender from Claude, produce concept renders or a cinematic video, or export a model for the game. Covers the loft-and-recess modelling method, procedural texturing, deep-space lighting, and the Blender 5.x API traps that silently produce black frames.
---

# Hard-surface spacecraft in Blender

Everything here was learned building a 162 m survey tender end to end. The
techniques matter more than the ship: **primitive assembly has a hard ceiling,
and no amount of lighting or framing gets you past it.**

Working code for all of it is in `reference/`: `bmcp_client.py` (socket),
`build_tender.py` (the full ship — loft, recess, greeble, materials, lights),
`cinematic.py` (texturing, planet, starfield, camera move, lens). Run
`cat build_tender.py cinematic.py | python3 bmcp_client.py code` to rebuild the
whole scene from scratch in about two seconds.

## Connecting

BlenderMCP's addon opens a JSON socket on `localhost:9876`. The MCP tools load
at session start, so if the server was registered mid-session they will not be
in your tool list — talk to the socket directly instead. It is the same channel:

```python
import json, socket
def send(cmd, params=None, timeout=900.0):
    s = socket.socket(); s.settimeout(timeout); s.connect(("localhost", 9876))
    s.sendall(json.dumps({"type": cmd, "params": params or {}}).encode())
    buf = b""
    while True:
        buf += s.recv(65536)
        try: return json.loads(buf.decode())
        except json.JSONDecodeError: continue

def run(code): return send("execute_code", {"code": code})
```

Commands: `get_scene_info`, `get_object_info`, `execute_code`,
`get_viewport_screenshot`. `execute_code` is the one that matters — everything
below is `bpy` sent through it.

The addon **cannot start its server in background mode**. Blender must be open
with a GUI, sidebar (`N`) → BlenderMCP → *Connect to Claude*. The socket only
exists while that toggle is on. If you install the addon while Blender is
already running, that instance does not have it — restart Blender.

## Modelling: loft, recess, hierarchy

Three techniques, in order of impact.

**1. Loft cross-sections; never stack primitives.** Define a profile whose
width, height and chamfer vary along the length, sweep it through stations, and
bridge into one continuous skin. An octagon with independent chamfer widths
reads as rolled plate; a superellipse reads as a moulded shuttle. Sweeping the
"squareness" lets a boxy stern become a faceted bow with no seam.

```python
def oct_ring(w, h, cx, cz):
    a, b = w * 0.5, h * 0.5
    return [( a, b - cz), ( a - cx,  b), (-(a - cx),  b), (-a,  b - cz),
            (-a, -(b - cz)), (-(a - cx), -b), ( a - cx, -b), ( a, -(b - cz))]

def loft(name, sections, mat, cuts=0):   # sections: (y, w, h, cx, cz, dz)
    bm = bmesh.new()
    rings = [[bm.verts.new((x, y, z + dz)) for (x, z) in oct_ring(w, h, cx, cz)]
             for (y, w, h, cx, cz, dz) in sections]
    for A, B in zip(rings, rings[1:]):
        for i in range(8):
            j = (i + 1) % 8
            bm.faces.new((A[i], A[j], B[j], B[i]))
    bm.faces.new(list(reversed(rings[0]))); bm.faces.new(rings[-1])
    if cuts:
        bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=cuts,
                                  use_grid_fill=True)
    ...
```

Make the profile **stepped, not smoothly tapered** — a parallel-sided midbody,
a shoulder, a blunt bow. The steps are what the eye measures length against. A
spear-point nose reads as a fighter; blunt reads as a working ship.

**2. Cut detail into the skin.** Panel bays, trenches, keel channels and hangars
are `bmesh.ops.inset_region` on selected faces, then translated inward along the
face normal. Boxes glued to a surface always look glued on.

```python
sel = [f for f in bm.faces if pick(f)]
bmesh.ops.inset_region(bm, faces=sel, thickness=1.2, depth=0.0,
                       use_even_offset=True, use_boundary=True)
for f in sel:
    bmesh.ops.translate(bm, verts=list(f.verts), vec=f.normal.normalized() * -0.7)
    f.material_index = i_struct        # a different material in the recess
```

**3. Detail hierarchy, including restraint.** Three tiers: primary masses,
medium panel bays, fine greebles at roughly **1/60 of the hull length**.
Greeble via `inset_individual` + nudge proud or sunk, so it is integrated
geometry. Critically: **leave clean plate**. A first pass that greebled every
face read as noise; zoning it and leaving the dorsal alone is what made it read
as detail. Detail only registers against something undetailed.

Flat-shade the hull. Plate, not plastic.

## Texturing (procedural — no image textures)

Two nodes do most of the work of making paint look built:

- **Per-plate tonal variation.** `TexVoronoi` on object coords (scale ~0.16),
  `RGBToBW`, remap to 0.9–1.1, multiply into base colour. Real plate is welded
  from batches that never quite match, and that mismatch is most of the read.
- **Edge wear.** `NewGeometry → Pointiness` remapped over ~0.49–0.56, mixed
  toward bare metal and driving Metallic up. Free on every convex corner, and
  exactly where paint goes in life. Cycles only.

Also useful: bleach on star-facing normals (`dot(Normal, sun_dir)`) and soot
toward the stern (object-space Y), which is what turns a coloured solid into a
used object.

## Lighting the void

One hard key (`SUN`, `angle ≈ 0.9°`), a large weak area light for
nebula/planetshine fill tinted toward the key's complement, and a cold rim so
nothing dissolves into the background. Shadows are never black.

**Put the camera on the key side.** A hero angle shot from the shadow side is
carried entirely by fill and reads washed out — this cost two wasted renders.

Stars: `Voronoi`, not thresholded noise. Noise cannot separate density from
size — raise the frequency to shrink the points and you get thousands; widen
the band to brighten them and you get falling snow. With Voronoi, **cell scale
sets how many, distance threshold sets how big**, and the per-cell random value
throws most away and varies brightness:

- cells over the sphere ≈ `4π·scale²`, and a frame sees under 1% of it, so
  `scale=30` puts about *fifteen* cells in shot. Use `scale ≈ 110`.
- angular radius = `threshold / scale`; move the two together.

## Rendering and the camera

Derive the camera from the scene bounding box, never by hand — hand-placed
cameras end up inside the ship:

```python
pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
ctr = (lo + hi) / 2; rad = max((p - ctr).length for p in pts)
cam.location = ctr + direction * (rad / math.tan(cam.data.angle / 2) * 1.05)
cam.rotation_euler = (ctr - cam.location).to_track_quat("-Z", "Y").to_euler()
```

Compositor for the lens: `Glare` Fog Glow (halation) → `Glare` Streaks
(anamorphic) → `Lensdist` dispersion (CA). Use AgX; do not touch
`renderer.toneMapping` equivalents.

Draft at 64 samples / 1280×720 (~2 s), final at 96–400 / 1920×1080 (~4–8 s on
an M-series GPU). Iteration is cheap — render constantly and *look*.

## Traps that cost real time

- **A camera inside geometry costs 80× the render time.** 166 s versus 2 s for
  the same scene, from near-field bounces. A sudden slow frame means check the
  camera before you touch sample counts.
- **Backdrop geometry must be camera-visible only.** A 2600-unit emissive
  atmosphere shell became an area light every shading point importance-sampled:
  **145 s → 4.3 s** by setting `visible_diffuse/glossy/transmission/
  volume_scatter/shadow = False`. Always do this for planets and skyboxes.
- **`o.scale = size` then a Bevel modifier makes pillows.** Bevel works in local
  space, so a 0.4 m chamfer on a unit cube is a 40% round-over that then gets
  stretched. `bpy.ops.object.transform_apply(scale=True)` first.
- **`matrix_parent_inverse = parent.matrix_world.inverted()` cancels the
  parent.** That is the "keep transform" idiom. If you want a child positioned
  in the parent's space and inheriting its rotation, leave the parent inverse at
  identity. Symptom: rotating the parent does nothing.
- **A rotation about the wrong axis silently does nothing visible.** A panel
  whose normal is +X does not change facing when rotated about X. Measure the
  world normal against the view vector rather than reasoning about it.
- **Map Range with `To Min > To Max` and clamp on collapses to zero.** It
  clamps to an inverted interval. Invert with a `SUBTRACT` node instead.
- **A Mix node in RGBA mode may silently drop a branch.** It carries several
  sockets named "Factor"; setting by name can hit an unused one. For combining
  world contributions use two `Background` nodes into an `Add Shader` — that is
  what it actually is.
- **The image preview downsamples.** 4-px stars average away to nothing in a
  1920×1080 preview. Crop 1:1 and count bright pixels numerically before
  concluding something did not render.

## Blender 5.x API changes (4.x code fails on all of these)

- `Scene.node_tree` is gone → `Scene.compositing_node_group`, and
  `CompositorNodeComposite` no longer exists; the group's output *is* the
  result.
- **The compositing group must contain a `CompositorNodeRLayers`.** Feed it from
  a Group Input and nothing depends on the render, so Blender skips rendering
  entirely and writes a **transparent black frame in 0.1 s**. A suspiciously
  fast render is this bug.
- `Action.fcurves` is gone (slotted actions). Set interpolation via
  `context.preferences.edit.keyframe_new_interpolation_type` *before* inserting
  keys.
- Glare/Lensdist settings moved from properties onto **sockets**, and the enums
  take display names: `"Fog Glow"`, `"Streaks"`, `"High"` — not `FOG_GLOW`.
- Legacy addons still install to
  `~/Library/Application Support/Blender/<ver>/scripts/addons/`.

## Exporting to this game

The game builds hulls **procedurally** (`src/gfx/greeble.js`, `src/ship/hull.js`)
and ships no build-time assets — there is no `GLTFLoader` in the tree. So:

- The idiomatic path is porting the loft/recess method into the greeble kit, not
  loading a mesh.
- If you do export: `bpy.ops.export_scene.gltf(export_format='GLB',
  use_selection=True, export_apply=True, export_yup=True)` into `public/models/`.
  Procedural node materials do **not** survive — export flat base colours and let
  the game's `dress()` do bleach/soot/plate.
- Model in metres; the game is 1 unit = 1 km, so scale by 0.001 on a fresh root
  (and never `setScalar` on anything the greeble kit built).
- **Join by material before exporting.** One Blender object becomes one glTF
  node becomes one draw call — a loose export of this ship was 78 of them for
  11 materials. `bpy.ops.object.join()` per material group first, so the mesh
  arrives as ~11 draws. `survey.mjs` reports draw calls; check it after adding
  anything.
- `KHR_materials_emissive_strength` does survive the round trip, so nav lights,
  window panes and Choir emissives keep their authored intensity.

---

ProSpacer™ and its visual identity are trademarks of Profexor. Copyright © 2026 Profexor. The software is licensed under the [MIT License](../../../LICENSE); trademark rights are not granted by the software license.
