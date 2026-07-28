"""Cinematic layer: texture, environment, camera move, lens.

Runs after hull2.py. Everything here is procedural — no image textures — so it
survives being re-run and matches how the game itself builds surfaces.
"""
import bpy, math
from mathutils import Vector

S = bpy.context.scene
FPS = 24
DUR = 10                       # seconds
NFRAMES = FPS * DUR
S.render.fps = FPS
S.frame_start = 1
S.frame_end = NFRAMES

def lin(h):
    out = []
    for sh in (16, 8, 0):
        c = ((h >> sh) & 255) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)

METAL = lin(0x6d665c)

def emis(name, strength):
    m = bpy.data.materials.get(name)
    if m:
        b = m.node_tree.nodes.get("Principled BSDF")
        if b:
            b.inputs["Emission Strength"].default_value = strength

# ---------------------------------------------------------------- texturing
def upgrade(m, wear=0.5, plate=0.11, pt_lo=0.49, pt_hi=0.56):
    """Two things separate a painted hull from a coloured solid:

    - **Per-plate tonal variation.** Real plate is welded up from batches that
      never quite match, and that mismatch is most of what reads as 'built'.
      A Voronoi cell per plate, modulating brightness by a few percent.
    - **Wear on the convex edges.** Cycles' pointiness gives every outside
      corner for free, which is exactly where paint goes and bare metal shows.
    """
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if not bsdf:
        return
    bc = bsdf.inputs["Base Color"]
    src = bc.links[0].from_socket if bc.links else None

    tc = nt.nodes.new("ShaderNodeTexCoord")
    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.inputs["Scale"].default_value = 0.16
    vor.inputs["Randomness"].default_value = 1.0
    nt.links.new(tc.outputs["Object"], vor.inputs["Vector"])
    bw = nt.nodes.new("ShaderNodeRGBToBW")
    nt.links.new(vor.outputs["Color"], bw.inputs[0])
    pv = nt.nodes.new("ShaderNodeMapRange")
    pv.inputs["To Min"].default_value = 1.0 - plate
    pv.inputs["To Max"].default_value = 1.0 + plate
    nt.links.new(bw.outputs[0], pv.inputs["Value"])

    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"; mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1.0
    if src:
        nt.links.new(src, mul.inputs[6])
    else:
        mul.inputs[6].default_value = bc.default_value
    fac2col = nt.nodes.new("ShaderNodeCombineColor")
    for i in range(3):
        nt.links.new(pv.outputs["Result"], fac2col.inputs[i])
    nt.links.new(fac2col.outputs[0], mul.inputs[7])

    geo = nt.nodes.new("ShaderNodeNewGeometry")
    pr = nt.nodes.new("ShaderNodeMapRange")
    pr.inputs["From Min"].default_value = pt_lo
    pr.inputs["From Max"].default_value = pt_hi
    pr.inputs["To Min"].default_value = 0.0
    pr.inputs["To Max"].default_value = wear
    pr.clamp = True
    nt.links.new(geo.outputs["Pointiness"], pr.inputs["Value"])

    wm = nt.nodes.new("ShaderNodeMix")
    wm.data_type = "RGBA"
    wm.inputs[7].default_value = (*[c * 1.15 for c in METAL], 1)
    nt.links.new(mul.outputs[2], wm.inputs[6])
    nt.links.new(pr.outputs["Result"], wm.inputs["Factor"])
    nt.links.new(wm.outputs[2], bc)

    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = pt_lo
    mr.inputs["From Max"].default_value = pt_hi
    mr.inputs["To Min"].default_value = bsdf.inputs["Metallic"].default_value
    mr.inputs["To Max"].default_value = 0.8
    mr.clamp = True
    nt.links.new(geo.outputs["Pointiness"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], bsdf.inputs["Metallic"])

for nm in ("paint.bone", "paint.oxide", "paint.slate", "structure",
           "accent.oxide", "panel.ceramic"):
    m = bpy.data.materials.get(nm)
    if m:
        upgrade(m, wear=0.55 if "paint" in nm else 0.35)

emis("light.drive", 2.6)     # was blowing three flat white octagons
emis("light.nav", 55.0)
emis("bay.interior", 4.0)

# ------------------------------------------------------------------ a planet
# Scale needs a witness, and the shadow side needs a source. A world in frame
# supplies both: it is the thing the teal fill is bouncing off.
bpy.ops.mesh.primitive_uv_sphere_add(radius=2600, location=(-3400, 1400, -2600),
                                     segments=96, ring_count=48)
planet = bpy.context.active_object
planet.name = "planet"
for p in planet.data.polygons:
    p.use_smooth = True
pm = bpy.data.materials.new("planet.surface"); pm.use_nodes = True
pnt = pm.node_tree; pb = pnt.nodes["Principled BSDF"]
ptc = pnt.nodes.new("ShaderNodeTexCoord")
pn = pnt.nodes.new("ShaderNodeTexNoise")
pn.inputs["Scale"].default_value = 2.6
pn.inputs["Detail"].default_value = 12.0
pn.inputs["Roughness"].default_value = 0.62
pnt.links.new(ptc.outputs["Object"], pn.inputs["Vector"])
pr_ = pnt.nodes.new("ShaderNodeValToRGB")
pr_.color_ramp.elements[0].position = 0.38
pr_.color_ramp.elements[0].color = (*lin(0x18333f), 1)   # ocean, teal-dark
pr_.color_ramp.elements[1].position = 0.62
pr_.color_ramp.elements[1].color = (*lin(0x8a7a63), 1)
pnt.links.new(pn.outputs["Fac"], pr_.inputs["Fac"])
pnt.links.new(pr_.outputs["Color"], pb.inputs["Base Color"])
pb.inputs["Roughness"].default_value = 0.85
planet.data.materials.append(pm)

# Atmosphere: a shell that only shows where it is edge-on, which is all an
# atmosphere ever really is from outside.
bpy.ops.mesh.primitive_uv_sphere_add(radius=2680, location=planet.location,
                                     segments=96, ring_count=48)
atmo = bpy.context.active_object
atmo.name = "planet.atmo"
for p in atmo.data.polygons:
    p.use_smooth = True
am = bpy.data.materials.new("planet.atmo"); am.use_nodes = True
ant = am.node_tree
for n in list(ant.nodes):
    if n.type != "OUTPUT_MATERIAL":
        ant.nodes.remove(n)
out = ant.nodes["Material Output"]
tr = ant.nodes.new("ShaderNodeBsdfTransparent")
em = ant.nodes.new("ShaderNodeEmission")
em.inputs["Color"].default_value = (*lin(0x5fa8d8), 1)
em.inputs["Strength"].default_value = 1.5
mixs = ant.nodes.new("ShaderNodeMixShader")
fres = ant.nodes.new("ShaderNodeFresnel")
fres.inputs["IOR"].default_value = 1.12
ant.links.new(fres.outputs["Fac"], mixs.inputs[0])
ant.links.new(tr.outputs[0], mixs.inputs[1])
ant.links.new(em.outputs[0], mixs.inputs[2])
ant.links.new(mixs.outputs[0], out.inputs["Surface"])
if hasattr(am, "blend_method"):
    am.blend_method = "BLEND"
atmo.data.materials.append(am)

# Backdrop only. Letting a 2600-unit emissive sphere contribute to diffuse and
# glossy makes it an area light that every shading point samples — it cost 145 s
# a frame versus 4 s.
for _o in (planet, atmo):
    _o.visible_diffuse = False
    _o.visible_glossy = False
    _o.visible_transmission = False
    _o.visible_volume_scatter = False
    _o.visible_shadow = False

# ------------------------------------------------------- stars and nebula
w = S.world
wnt = w.node_tree
for n in list(wnt.nodes):
    if n.type != "OUTPUT_WORLD":
        wnt.nodes.remove(n)
wout = wnt.nodes["World Output"]
bgn = wnt.nodes.new("ShaderNodeBackground")
wtc = wnt.nodes.new("ShaderNodeTexCoord")

neb = wnt.nodes.new("ShaderNodeTexNoise")
neb.inputs["Scale"].default_value = 3.2
neb.inputs["Detail"].default_value = 10.0
neb.inputs["Roughness"].default_value = 0.62
wnt.links.new(wtc.outputs["Generated"], neb.inputs["Vector"])
nramp = wnt.nodes.new("ShaderNodeValToRGB")
nramp.color_ramp.elements[0].position = 0.44
nramp.color_ramp.elements[0].color = (*lin(0x010306), 1)
nramp.color_ramp.elements[1].position = 0.95
nramp.color_ramp.elements[1].color = (*lin(0x1a4a58), 1)
wnt.links.new(neb.outputs["Fac"], nramp.inputs["Fac"])

# Stars. A thresholded noise cannot separate *density* from *size* — raise the
# frequency to shrink the points and you get thousands of them; widen the band
# to brighten them and you get snow. Voronoi separates the two: cell scale sets
# how many, the distance threshold sets how big, and the per-cell random value
# throws most of them away and varies the brightness of the rest.
star = wnt.nodes.new("ShaderNodeTexVoronoi")
star.feature = "F1"
star.inputs["Scale"].default_value = 110.0
star.inputs["Randomness"].default_value = 1.0
wnt.links.new(wtc.outputs["Generated"], star.inputs["Vector"])

disc = wnt.nodes.new("ShaderNodeMapRange")       # size
disc.inputs["From Min"].default_value = 0.0
disc.inputs["From Max"].default_value = 0.045
disc.inputs["To Min"].default_value = 0.0
disc.inputs["To Max"].default_value = 1.0
disc.clamp = True
wnt.links.new(star.outputs["Distance"], disc.inputs["Value"])
# Map Range with To Min > To Max and clamp on collapses to zero — it clamps to
# an inverted interval. Invert with a subtract, never by flipping the range.
discinv = wnt.nodes.new("ShaderNodeMath")
discinv.operation = "SUBTRACT"
discinv.inputs[0].default_value = 1.0
wnt.links.new(disc.outputs["Result"], discinv.inputs[1])

cellbw = wnt.nodes.new("ShaderNodeRGBToBW")
wnt.links.new(star.outputs["Color"], cellbw.inputs[0])
keep = wnt.nodes.new("ShaderNodeMapRange")       # density: drop ~85% of cells
keep.inputs["From Min"].default_value = 0.50
keep.inputs["From Max"].default_value = 0.66
keep.inputs["To Min"].default_value = 0.0
keep.inputs["To Max"].default_value = 1.0
keep.clamp = True
wnt.links.new(cellbw.outputs[0], keep.inputs["Value"])

mag = wnt.nodes.new("ShaderNodeMapRange")        # a few bright, most faint
mag.inputs["From Min"].default_value = 0.62
mag.inputs["From Max"].default_value = 1.0
mag.inputs["To Min"].default_value = 1.0
mag.inputs["To Max"].default_value = 26.0
mag.clamp = True
wnt.links.new(cellbw.outputs[0], mag.inputs["Value"])

m1 = wnt.nodes.new("ShaderNodeMath"); m1.operation = "MULTIPLY"
wnt.links.new(discinv.outputs[0], m1.inputs[0])
wnt.links.new(keep.outputs["Result"], m1.inputs[1])
m2 = wnt.nodes.new("ShaderNodeMath"); m2.operation = "MULTIPLY"
wnt.links.new(m1.outputs[0], m2.inputs[0])
wnt.links.new(mag.outputs["Result"], m2.inputs[1])

sbright = wnt.nodes.new("ShaderNodeCombineColor")
for _i, _c in enumerate((1.0, 1.0, 1.06)):
    sc = wnt.nodes.new("ShaderNodeMath"); sc.operation = "MULTIPLY"
    sc.inputs[1].default_value = _c
    wnt.links.new(m2.outputs[0], sc.inputs[0])
    wnt.links.new(sc.outputs[0], sbright.inputs[_i])

# Combine nebula and stars as two Background shaders through an Add Shader.
# A Mix node in RGBA mode refused to pass the star branch no matter what its
# Factor reported, and two backgrounds is what this actually is anyway: two
# emitters, each with its own strength.
wnt.links.new(nramp.outputs["Color"], bgn.inputs["Color"])
bgn.inputs["Strength"].default_value = 0.42

bgs = wnt.nodes.new("ShaderNodeBackground")
wnt.links.new(sbright.outputs[0], bgs.inputs["Color"])
bgs.inputs["Strength"].default_value = 1.0

addsh = wnt.nodes.new("ShaderNodeAddShader")
wnt.links.new(bgn.outputs[0], addsh.inputs[0])
wnt.links.new(bgs.outputs[0], addsh.inputs[1])
wnt.links.new(addsh.outputs[0], wout.inputs["Surface"])

# -------------------------------------------------------------- camera move
cam = S.camera
for o in bpy.data.objects:
    if o.animation_data:
        o.animation_data_clear()

pts = []
for o in bpy.data.objects:
    if o.type == "MESH" and not o.name.startswith(("tug", "planet")):
        for c in o.bound_box:
            pts.append(o.matrix_world @ Vector(c))
lo = Vector((min(p[i] for p in pts) for i in range(3)))
hi = Vector((max(p[i] for p in pts) for i in range(3)))
ctr = (lo + hi) / 2
rad = max((p - ctr).length for p in pts)

rig = bpy.data.objects.new("cam.rig", None)
S.collection.objects.link(rig)
rig.location = ctr
cam.parent = rig
cam.data.lens = 92.0
cam.data.shift_x = 0.05
cam.data.shift_y = 0.02
cam.data.clip_end = 40000
dist = rad / math.tan(cam.data.angle / 2) * 1.02
el = math.radians(15)
cam.location = (0, -dist * math.cos(el), dist * math.sin(el))
cam.rotation_euler = (math.radians(90) - el, 0, 0)

# A slow arc, constant rate. The move should feel like a camera on a boom, not
# like an ease-in-ease-out animation preset.
# Blender 5.x actions are slotted, so action.fcurves is gone; set the
# interpolation the keys are *created* with instead.
kprefs = bpy.context.preferences.edit
_old_interp = kprefs.keyframe_new_interpolation_type
kprefs.keyframe_new_interpolation_type = "LINEAR"
rig.rotation_euler = (0, 0, math.radians(126))
rig.keyframe_insert("rotation_euler", frame=1)
rig.rotation_euler = (0, 0, math.radians(171))
rig.keyframe_insert("rotation_euler", frame=NFRAMES)

# Slight dolly in, so the frame tightens as it travels.
kprefs.keyframe_new_interpolation_type = "BEZIER"
cam.keyframe_insert("location", frame=1)
cam.location = (0, -dist * 0.86 * math.cos(el), dist * 0.86 * math.sin(el))
cam.keyframe_insert("location", frame=NFRAMES)
kprefs.keyframe_new_interpolation_type = "LINEAR"

# The tender drifts across the bow over the shot — the only thing in frame
# whose motion you can actually read.
tug = bpy.data.objects.get("tug.root")
if tug:
    tug.location = (52.0, 120.0, 30.0)
    tug.keyframe_insert("location", frame=1)
    tug.location = (18.0, 74.0, 44.0)
    tug.keyframe_insert("location", frame=NFRAMES)
kprefs.keyframe_new_interpolation_type = _old_interp

cam.data.dof.use_dof = True
cam.data.dof.focus_distance = dist * 0.95
cam.data.dof.aperture_fstop = 2.2

# ------------------------------------------------------------------ the lens
# Halation, anamorphic streak and a little dispersion off-axis — the camera is
# a physical object, so the frame should carry its fingerprints.
# Blender 5.x replaced Scene.node_tree with a compositing *node group*, and
# CompositorNodeComposite no longer exists — the group's output is the result.
for _g in [g for g in bpy.data.node_groups if g.name.startswith("lens")]:
    bpy.data.node_groups.remove(_g)
ng = bpy.data.node_groups.new("lens", "CompositorNodeTree")
ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
go = ng.nodes.new("NodeGroupOutput")
# The group MUST source from a Render Layers node. Feeding it from a Group
# Input leaves nothing depending on the render, so Blender skips rendering
# altogether and writes a transparent black frame in 0.1 s.
rl = ng.nodes.new("CompositorNodeRLayers")
chain = rl.outputs["Image"]

def setin(node, name, val):
    """5.x moved every glare/lensdist setting from a property onto a socket,
    including the type enum itself."""
    if name in node.inputs:
        try:
            node.inputs[name].default_value = val
            return True
        except Exception as e:
            print("  socket", name, "rejected", val, e)
    return False

def add_glare(kind, **kw):
    global chain
    g = ng.nodes.new("CompositorNodeGlare")
    setin(g, "Type", kind)
    for k, v in kw.items():
        setin(g, k, v)
    ng.links.new(chain, g.inputs["Image"])
    chain = g.outputs[0]

# Halation: warm spill out of the highlights.
add_glare("Fog Glow", Quality="High", Threshold=0.85, Size=8, Strength=0.38)
# Anamorphic streak: two horizontal bars off anything that clips.
add_glare("Streaks", Quality="High", Threshold=0.92, Streaks=2,
          **{"Streaks Angle": 0.0}, Fade=0.92, Strength=0.5)

ldn = ng.nodes.new("CompositorNodeLensdist")
setin(ldn, "Dispersion", 0.006)     # CA that grows off-axis
setin(ldn, "Fit", True)
ng.links.new(chain, ldn.inputs["Image"])
chain = ldn.outputs["Image"]
ng.links.new(chain, go.inputs["Image"])
S.use_nodes = True
S.compositing_node_group = ng

# ----------------------------------------------------------------- rendering
S.render.engine = "CYCLES"
S.cycles.device = "GPU"
S.cycles.samples = 128
S.cycles.use_denoising = True
S.cycles.max_bounces = 4
S.cycles.transparent_max_bounces = 2
S.render.use_motion_blur = True
S.render.motion_blur_shutter = 0.45
S.render.resolution_x = 1920
S.render.resolution_y = 1080
S.render.image_settings.file_format = "PNG"
S.view_settings.view_transform = "AgX"
S.view_settings.exposure = 0.35
try:
    S.view_settings.look = "AgX - Medium High Contrast"
except Exception:
    pass

print({"frames": NFRAMES, "fps": FPS, "cam_dist": round(dist, 1),
       "planet_r": 2600})
