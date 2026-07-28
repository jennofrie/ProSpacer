"""A lofted hull, not a pile of cubes.

Everything structural here is a swept cross-section: a rounded-rectangle
profile whose width, height and squareness vary along the ship's length, then
bridged into one continuous surface. Detail is inset *into* that surface rather
than stacked on top of it, so the light describes one object.
"""
import bpy, bmesh, math, random
from mathutils import Vector, Matrix

random.seed(23)
S = bpy.context.scene

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
for d in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras):
    for b in list(d):
        if b.users == 0:
            d.remove(b)

def lin(h):
    out = []
    for sh in (16, 8, 0):
        c = ((h >> sh) & 255) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)

BONE   = lin(0x8e8d86); OXIDE = lin(0x8a6a4c); SLATE = lin(0x5f6a70)
RUST   = lin(0x6d5443); STRUCT = lin(0x1f2226); METAL = lin(0x6d665c)
ACCENT = lin(0x8c4418); PANEL = lin(0xa8a9a4); CHOIR = lin(0xbfe07a)
COLD   = lin(0xcfe4ff); SOOT  = lin(0x14120f)

SUN_DIR = Vector((-0.70, 0.06, 0.56)).normalized()

def _set(b, names, v):
    for n in names:
        if n in b.inputs:
            b.inputs[n].default_value = v
            return

def weathered(name, base, rough, metal, bleach=0.55, soot=0.8):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; bsdf = nt.nodes["Principled BSDF"]
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    dot = nt.nodes.new("ShaderNodeVectorMath"); dot.operation = "DOT_PRODUCT"
    dot.inputs[1].default_value = SUN_DIR
    nt.links.new(geo.outputs["Normal"], dot.inputs[0])
    bl = nt.nodes.new("ShaderNodeMapRange")
    bl.inputs["From Min"].default_value = -0.1; bl.inputs["From Max"].default_value = 1.0
    bl.inputs["To Min"].default_value = 0.0;    bl.inputs["To Max"].default_value = bleach
    nt.links.new(dot.outputs["Value"], bl.inputs["Value"])
    tc = nt.nodes.new("ShaderNodeTexCoord"); sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    so = nt.nodes.new("ShaderNodeMapRange")
    so.inputs["From Min"].default_value = 5.0; so.inputs["From Max"].default_value = -58.0
    so.inputs["To Min"].default_value = 0.0;   so.inputs["To Max"].default_value = soot
    nt.links.new(sep.outputs["Y"], so.inputs["Value"])
    m1 = nt.nodes.new("ShaderNodeMix"); m1.data_type = "RGBA"
    m1.inputs[6].default_value = (*base, 1)
    m1.inputs[7].default_value = (*[min(1, c * 1.5 + 0.10) for c in base], 1)
    nt.links.new(bl.outputs["Result"], m1.inputs["Factor"])
    m2 = nt.nodes.new("ShaderNodeMix"); m2.data_type = "RGBA"
    m2.inputs[7].default_value = (*SOOT, 1)
    nt.links.new(m1.outputs[2], m2.inputs[6])
    nt.links.new(so.outputs["Result"], m2.inputs["Factor"])
    nt.links.new(m2.outputs[2], bsdf.inputs["Base Color"])
    # Fine roughness break so big painted planes are not dead flat.
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = 14.0
    nz.inputs["Detail"].default_value = 6.0
    rr = nt.nodes.new("ShaderNodeMapRange")
    rr.inputs["To Min"].default_value = rough - 0.06
    rr.inputs["To Max"].default_value = min(0.98, rough + 0.07)
    nt.links.new(nz.outputs["Fac"], rr.inputs["Value"])
    nt.links.new(rr.outputs["Result"], bsdf.inputs["Roughness"])
    _set(bsdf, ["Metallic"], metal)
    _set(bsdf, ["Specular IOR Level", "Specular"], 0.32)
    return m

def flat(name, base, rough, metal, emis=None, estr=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    _set(b, ["Base Color"], (*base, 1)); _set(b, ["Roughness"], rough)
    _set(b, ["Metallic"], metal); _set(b, ["Specular IOR Level", "Specular"], 0.3)
    if emis:
        _set(b, ["Emission Color", "Emission"], (*emis, 1))
        _set(b, ["Emission Strength"], estr)
    return m

M_PAINT  = weathered("paint.bone", BONE, 0.70, 0.04)
M_OXIDE  = weathered("paint.oxide", OXIDE, 0.72, 0.04, bleach=0.45)
M_SLATE  = weathered("paint.slate", SLATE, 0.66, 0.06)
M_STRUCT = weathered("structure", STRUCT, 0.46, 0.55, bleach=0.20, soot=0.85)
M_METAL  = flat("metal", METAL, 0.34, 0.92)
M_ACCENT = weathered("accent.oxide", ACCENT, 0.66, 0.18, bleach=0.90, soot=0.40)
M_PANEL  = flat("panel.ceramic", PANEL, 0.94, 0.0)
M_WIN    = flat("light.window", (0.02, 0.03, 0.05), 0.25, 0.0, COLD, 14.0)
M_NAV    = flat("light.nav", (0.02, 0.03, 0.05), 0.3, 0.0, COLD, 120.0)
M_DRIVE  = flat("light.drive", (0.02, 0.03, 0.04), 0.4, 0.0, COLD, 9.0)
M_CHOIR  = flat("choir.shard", (0.05, 0.06, 0.03), 0.35, 0.0, CHOIR, 14.0)

# ---------------------------------------------------------------- loft machinery
N = 28   # points around each ring

M_BAY = flat("bay.interior", (0.03, 0.035, 0.04), 0.6, 0.0, COLD, 9.0)

# ---------------------------------------------------------------- loft machinery
# Octagonal sections, not squircles. Flat planes meeting at hard 45 degree
# chamfers is the whole Homeworld/Foss read: a thing built from rolled plate,
# not moulded. Chamfer widths ride independently of the section size so the
# hull can go from a deep boxy stern to a blunt faceted bow.
def oct_ring(w, h, cx, cz):
    a, b = w * 0.5, h * 0.5
    return [( a,      b - cz), ( a - cx,  b     ), (-(a - cx),  b     ),
            (-a,      b - cz), (-a,     -(b - cz)), (-(a - cx), -b    ),
            ( a - cx, -b     ), ( a,     -(b - cz))]

NP = 8

def loft(name, sections, mat, cap_a=True, cap_b=True, cuts=0):
    """sections: (y, w, h, cx, cz, dz)."""
    bm = bmesh.new()
    rings = []
    for (y, w, h, cx, cz, dz) in sections:
        rings.append([bm.verts.new((x, y, z + dz)) for (x, z) in oct_ring(w, h, cx, cz)])
    for a, b in zip(rings, rings[1:]):
        for i in range(NP):
            j = (i + 1) % NP
            bm.faces.new((a[i], a[j], b[j], b[i]))
    if cap_a:
        bm.faces.new(list(reversed(rings[0])))
    if cap_b:
        bm.faces.new(rings[-1])
    if cuts:
        bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=cuts,
                                  use_grid_fill=True)
    bm.normal_update()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me)
    S.collection.objects.link(o)
    o.data.materials.append(mat)
    return o                      # flat shaded on purpose: plate, not plastic

def edit(o, fn):
    bm = bmesh.new(); bm.from_mesh(o.data)
    bm.faces.ensure_lookup_table(); bm.verts.ensure_lookup_table()
    fn(bm)
    bm.normal_update(); bm.to_mesh(o.data); bm.free()
    o.data.update()

def recess(o, pick, thickness=0.9, depth=-0.35, mat_idx=None):
    """Panel bays cut into the skin, not boxes stuck onto it."""
    def go(bm):
        sel = [f for f in bm.faces if pick(f)]
        if not sel:
            return
        bmesh.ops.inset_region(bm, faces=sel, thickness=thickness, depth=0.0,
                               use_even_offset=True, use_boundary=True)
        for f in sel:
            bmesh.ops.translate(bm, verts=list(f.verts),
                                vec=f.normal.normalized() * depth)
            if mat_idx is not None:
                f.material_index = mat_idx
    edit(o, go)

def greeble(o, pick, count=90, lo=0.2, hi=0.7, depth=0.3):
    """Fine tier only — roughly 1/60 of the hull. Greebles at the same scale as
    the primary masses read as clutter, not detail."""
    def go(bm):
        cand = [f for f in bm.faces if pick(f)]
        random.shuffle(cand)
        for f in cand[:count]:
            bmesh.ops.inset_individual(bm, faces=[f], thickness=random.uniform(lo, hi),
                                       depth=0.0, use_even_offset=True)
            d = random.choice((depth, -depth, depth * 0.45, -depth * 0.7))
            bmesh.ops.translate(bm, verts=list(f.verts),
                                vec=f.normal.normalized() * d)
    edit(o, go)

def add_mat(o, m):
    o.data.materials.append(m)
    return len(o.data.materials) - 1

def slab(name, size, loc, rot=(0, 0, 0), mat=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name; o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat:
        o.data.materials.append(mat)
    return o

def bevel(o, w=0.25, seg=2):
    m = o.modifiers.new("bev", "BEVEL")
    m.width = w; m.segments = seg
    m.limit_method = "ANGLE"; m.angle_limit = math.radians(40)
    return o

# ------------------------------------------------------------------- the hull
# Stepped, not tapered: a deep freighter stern, a long parallel-sided midbody
# that carries the load, a shoulder, and a blunt faceted bow. The steps are
# what give the eye something to measure length against.
HULL = [
    (-60, 20.0, 16.0, 3.0, 3.0, 0.0),
    (-56, 23.0, 18.0, 4.0, 4.0, 0.0),
    (-44, 24.0, 18.5, 4.5, 4.0, 0.0),
    (-30, 24.0, 18.5, 4.5, 4.0, 0.0),
    (-29, 22.0, 17.0, 4.0, 3.5, 0.2),
    (-14, 22.0, 17.0, 4.0, 3.5, 0.4),
    ( -2, 21.0, 16.0, 4.0, 3.5, 0.6),
    ( 16, 20.0, 15.0, 4.0, 3.5, 0.9),
    ( 17, 17.5, 13.5, 3.5, 3.0, 1.0),
    ( 32, 16.5, 12.5, 3.5, 3.0, 1.3),
    ( 44, 14.0, 11.0, 3.2, 2.8, 1.6),
    ( 45, 11.5,  9.5, 2.6, 2.4, 1.7),
    ( 56, 10.0,  8.5, 2.4, 2.2, 1.9),
    ( 62,  8.0,  7.0, 2.0, 1.8, 2.0),
    ( 64,  6.4,  5.8, 1.6, 1.5, 2.0),   # blunt bow, not a spear point
]
hull = loft("hull", HULL, M_PAINT, cuts=2)
i_slate  = add_mat(hull, M_SLATE)
i_accent = add_mat(hull, M_ACCENT)
i_struct = add_mat(hull, M_STRUCT)
i_bay    = add_mat(hull, M_BAY)

def side(f, y0, y1, sx, nz=0.55):
    c = f.calc_center_median()
    return y0 < c.y < y1 and f.normal.x * sx > 0.7 and abs(f.normal.z) < nz

# Flank bays — the medium tier.
for (y0, y1, sx, mi) in ((-40, -22, -1, i_struct), (-16, 4, 1, i_accent),
                         (-16, 4, -1, i_accent), (20, 38, -1, i_struct)):
    recess(hull, lambda f, a=y0, b=y1, s=sx: side(f, a, b, s),
           thickness=1.2, depth=-0.7, mat_idx=mi)

# A hangar, cut deep and lit from inside. It gives the hull one bright pocket
# and tells you how big the ship is without a caption.
recess(hull, lambda f: side(f, 20, 36, 1), thickness=1.0, depth=-3.4, mat_idx=i_bay)

# Dorsal trench down the spine.
recess(hull, lambda f: (-44 < f.calc_center_median().y < 30 and f.normal.z > 0.8
                        and abs(f.calc_center_median().x) < 5.0),
       thickness=0.9, depth=-1.1, mat_idx=i_struct)

# Ventral keel channel.
recess(hull, lambda f: (-40 < f.calc_center_median().y < 20 and f.normal.z < -0.8
                        and abs(f.calc_center_median().x) < 5.5),
       thickness=1.0, depth=-0.8, mat_idx=i_struct)

greeble(hull, lambda f: (f.calc_center_median().y < 24 and f.calc_area() > 1.6
                         and not (f.normal.z > 0.55
                                  and abs(f.calc_center_median().x) < 9)),
        count=120, lo=0.15, hi=0.5, depth=0.18)

# --------------------------------------------------------- bridge / dorsal mass
BRIDGE = [
    (30, 12.0,  5.0, 2.4, 1.6,  8.6),
    (38, 12.6,  6.4, 2.6, 1.8,  9.0),
    (48, 11.0,  6.0, 2.4, 1.8,  9.0),
    (56,  8.4,  4.6, 2.0, 1.4,  8.6),
]
bridge = loft("bridge", BRIDGE, M_PAINT, cuts=1)
add_mat(bridge, M_STRUCT)
greeble(bridge, lambda f: f.calc_area() > 1.2, count=40, lo=0.12, hi=0.4, depth=0.16)

# Aft sensor mast block — breaks the dorsal line.
mast = loft("mast", [(-34, 7.0, 4.0, 1.4, 1.0, 10.0),
                     (-26, 7.6, 5.0, 1.6, 1.2, 11.0),
                     (-20, 5.4, 3.6, 1.2, 1.0, 10.6)], M_SLATE, cuts=1)

# ---------------------------------------------------------------- engine block
eng = loft("eng", [(-60, 22.0, 17.0, 4.0, 3.5, 0.0),
                   (-68, 24.0, 18.0, 4.5, 4.0, 0.0),
                   (-74, 21.0, 16.0, 4.0, 3.5, 0.0)], M_STRUCT, cuts=2)
greeble(eng, lambda f: f.calc_area() > 2.0, count=44, lo=0.18, hi=0.5, depth=0.18)

# Nozzles: octagonal flares that open as they go aft.
for dx, dz in ((-6.5, -3.5), (6.5, -3.5), (0.0, 4.2)):
    n = loft(f"noz.{dx}.{dz}",
             [(-73, 5.0, 5.0, 1.4, 1.4, 0.0), (-78, 6.4, 6.4, 1.8, 1.8, 0.0),
              (-83, 8.4, 8.4, 2.4, 2.4, 0.0), (-85, 9.2, 9.2, 2.6, 2.6, 0.0)],
             M_METAL, cap_a=True, cap_b=False, cuts=1)
    n.location = (dx, 0, dz)
    g = loft(f"noz.glow.{dx}.{dz}",
             [(-84.2, 7.6, 7.6, 2.2, 2.2, 0.0), (-84.8, 8.0, 8.0, 2.3, 2.3, 0.0)],
             M_DRIVE, cuts=0)
    g.location = (dx, 0, dz)

# ------------------------------------------------------------ radiator panels
# Flat plates on visible pylons, held off the hull and raked a few degrees.
# Not wings — nothing here is trying to fly.
for sgn in (1, -1):
    for k, (yc, ln, ht) in enumerate(((-38, 26, 17), (-8, 22, 15))):
        pyl = slab(f"pylon.{sgn}.{k}", (7.0, 2.2, 2.2), (sgn * 13.5, yc, -1.0), mat=M_METAL)
        bevel(pyl, 0.2)
        p = slab(f"rad.{sgn}.{k}", (0.5, ln, ht),
                 (sgn * 24.0, yc, -6.5), rot=(0, math.radians(sgn * 16), 0), mat=M_PANEL)
        ip = add_mat(p, M_STRUCT)
        recess(p, lambda f: abs(f.normal.x) > 0.85 and f.calc_area() > 3.0,
               thickness=0.55, depth=-0.12, mat_idx=ip)
        # rib channels across the face
        for r in range(4):
            slab(f"rad.rib.{sgn}.{k}.{r}", (0.75, ln * 0.98, 0.5),
                 (sgn * 24.0, yc, -6.5 - ht * 0.35 + r * ht * 0.23),
                 rot=(0, math.radians(sgn * 16), 0), mat=M_METAL)

band = loft("band", [(4.0, 21.4, 16.4, 4.0, 3.5, 0.75), (9.0, 20.9, 15.9, 4.0, 3.5, 0.83)],
            M_ACCENT, cap_a=False, cap_b=False)
band2 = loft("band.aft", [(-47.0, 24.3, 18.8, 4.5, 4.0, 0.0),
                          (-43.0, 24.3, 18.8, 4.5, 4.0, 0.0)],
             M_ACCENT, cap_a=False, cap_b=False)

# --------------------------------------------------------------- lit apertures
slab("win.bridge", (7.0, 0.5, 1.5), (0, 55.4, 9.9), mat=M_WIN)
for i in range(8):
    slab(f"win.p.{i}", (0.3, 1.3, 0.75), (6.2, 32 + i * 2.8, 10.2), mat=M_WIN)
    slab(f"win.s.{i}", (0.3, 1.3, 0.75), (-6.2, 32 + i * 2.8, 10.2), mat=M_WIN)
for i in range(11):
    slab(f"win.h.{i}", (0.3, 1.0, 0.55), (-10.2, -34 + i * 3.6, 3.0), mat=M_WIN)

def navlight(name, loc, r=0.32):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=10, ring_count=6)
    o = bpy.context.active_object; o.name = name
    o.data.materials.append(M_NAV)
    return o

for i in range(6):
    navlight(f"nav.d.{i}", (0, -46 + i * 21, 9.6 + (i > 3) * 1.4))
navlight("nav.bow", (0, 64.9, 3.6), 0.13)
for sgn in (1, -1):
    navlight(f"nav.rad.{sgn}", (sgn * 24.0, -49.5, -6.5), 0.30)

# ------------------------------------------- the cargo: one Choir artefact
# Sunk into a dorsal bay so it reads as carried, not bolted on.
bay = loft("choir.bay", [(-52, 11.0, 5.0, 2.0, 1.4, 7.0),
                         (-40, 11.6, 5.6, 2.2, 1.6, 7.2)], M_STRUCT, cuts=1)
i_cb = add_mat(bay, M_METAL)
recess(bay, lambda f: f.normal.z > 0.8, thickness=1.0, depth=-1.6, mat_idx=i_cb)
for sgn in (1, -1):
    slab(f"cradle.{sgn}", (0.7, 0.7, 4.4), (sgn * 3.6, -46, 10.6), mat=M_METAL)
slab("cradle.ring", (8.4, 0.9, 0.8), (0, -46, 12.6), mat=M_METAL)
bpy.ops.mesh.primitive_ico_sphere_add(radius=2.0, subdivisions=1, location=(0, -46, 9.8))
shard = bpy.context.active_object
shard.name = "choir.shard"
shard.rotation_euler = (0.4, 0.9, 0.2)
shard.scale = (0.85, 0.85, 1.3)
shard.data.materials.append(M_CHOIR)

# ------------------------------------------------- the witness: a 10 m tender
tug = bpy.data.objects.new("tug.root", None)
S.collection.objects.link(tug)
tb = loft("tug.hull", [(-5.0, 2.4, 2.2, 0.6, 0.5, 0.0),
                       (-2.0, 3.4, 3.0, 0.8, 0.7, 0.0),
                       ( 2.0, 3.4, 3.0, 0.8, 0.7, 0.2),
                       ( 4.2, 2.6, 2.4, 0.7, 0.6, 0.3),
                       ( 5.0, 1.4, 1.4, 0.4, 0.4, 0.3)], M_PAINT, cuts=1)
tb.parent = tug
for nm, sz, lc, mt in (("tug.cab", (2.4, 2.2, 1.3), (0, 2.2, 1.9), M_SLATE),
                       ("tug.win", (1.7, 0.3, 0.6), (0, 3.3, 1.9), M_WIN),
                       ("tug.band", (3.7, 1.0, 3.4), (0, -1.4, 0.2), M_ACCENT)):
    p = slab(nm, sz, lc, mat=mt); p.parent = tug
for sgn in (1, -1):
    p = slab(f"tug.pod.{sgn}", (0.9, 3.4, 0.9), (sgn * 2.2, -1.2, -1.0), mat=M_METAL)
    p.parent = tug
p = slab("tug.glow", (1.5, 0.25, 1.5), (0, -5.2, 0), mat=M_DRIVE); p.parent = tug
p = navlight("tug.nav", (0, 1.2, 2.8), 0.18); p.parent = tug
tug.location = (34.0, 96.0, 36.0)
tug.rotation_euler = (Vector((0, -6, 2)) - tug.location).to_track_quat("Y", "Z").to_euler()

# ------------------------------------------------------------------- lighting
sun = bpy.data.lights.new("key", "SUN")
sun.energy = 10.0; sun.color = (1.0, 0.955, 0.90); sun.angle = math.radians(0.9)
so = bpy.data.objects.new("key", sun); S.collection.objects.link(so)
so.rotation_euler = Vector((0, 0, -1)).rotation_difference(-SUN_DIR).to_euler()

fill = bpy.data.lights.new("fill.nebula", "AREA")
fill.energy = 34000; fill.size = 200; fill.color = (0.30, 0.55, 0.72)
fo = bpy.data.objects.new("fill.nebula", fill); S.collection.objects.link(fo)
fo.location = (170, 40, -110)
fo.rotation_euler = (Vector((0, -6, 0)) - fo.location).to_track_quat("-Z", "Y").to_euler()

rim = bpy.data.lights.new("rim", "SUN")
rim.energy = 4.6; rim.color = (0.62, 0.78, 1.0); rim.angle = math.radians(3)
ro = bpy.data.objects.new("rim", rim); S.collection.objects.link(ro)
ro.rotation_euler = Vector((0, 0, -1)).rotation_difference(
    -Vector((0.75, -0.55, -0.25)).normalized()).to_euler()

w = S.world or bpy.data.worlds.new("void")
S.world = w; w.use_nodes = True
wnt = w.node_tree; bg = wnt.nodes["Background"]
tc = wnt.nodes.new("ShaderNodeTexCoord"); mp = wnt.nodes.new("ShaderNodeMapping")
gr = wnt.nodes.new("ShaderNodeTexGradient"); gr.gradient_type = "EASING"
mp.inputs["Rotation"].default_value = (0, math.radians(-62), 0)
wnt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
wnt.links.new(mp.outputs["Vector"], gr.inputs["Vector"])
rmp = wnt.nodes.new("ShaderNodeValToRGB")
rmp.color_ramp.elements[0].position = 0.15
rmp.color_ramp.elements[0].color = (*lin(0x04070a), 1)
rmp.color_ramp.elements[1].position = 0.95
rmp.color_ramp.elements[1].color = (*lin(0x3f8ea3), 1)
wnt.links.new(gr.outputs["Fac"], rmp.inputs["Fac"])
wnt.links.new(rmp.outputs["Color"], bg.inputs[0])
bg.inputs[1].default_value = 2.2

# --------------------------------------------------------------------- camera
bpy.context.view_layer.update()
pts = []
for o in bpy.data.objects:
    if o.type == "MESH" and not o.name.startswith("tug"):
        for c in o.bound_box:
            pts.append(o.matrix_world @ Vector(c))
lo = Vector((min(p[i] for p in pts) for i in range(3)))
hi = Vector((max(p[i] for p in pts) for i in range(3)))
ctr = (lo + hi) / 2
rad = max((p - ctr).length for p in pts)

cam = bpy.data.cameras.new("cam")
cam.lens = 85.0; cam.shift_x = 0.06; cam.shift_y = 0.02; cam.clip_end = 20000
co = bpy.data.objects.new("cam", cam); S.collection.objects.link(co)
az, el = math.radians(34), math.radians(17)
d = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
co.location = ctr + d * (rad / math.tan(cam.angle / 2) * 1.06)
co.rotation_euler = (ctr - co.location).to_track_quat("-Z", "Y").to_euler()
S.camera = co

DRAFT = bool(globals().get("DRAFT", True))
S.render.resolution_x = 1280 if DRAFT else 1920
S.render.resolution_y = 720 if DRAFT else 1080
S.render.engine = "CYCLES"; S.cycles.device = "GPU"
S.cycles.samples = 64 if DRAFT else 400
S.cycles.use_denoising = True
S.cycles.max_bounces = 4 if DRAFT else 8
S.view_settings.view_transform = "AgX"
S.view_settings.exposure = 0.35
try:
    S.view_settings.look = "AgX - Medium High Contrast"
except Exception:
    pass

tri = 0
for o in bpy.data.objects:
    if o.type == "MESH":
        o.data.calc_loop_triangles()
        tri += len(o.data.loop_triangles)
print({"objects": len(bpy.data.objects), "tris": tri,
       "extent_m": round((hi - lo).length, 1)})
