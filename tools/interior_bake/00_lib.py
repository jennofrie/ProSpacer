import bpy, bmesh, math, os, random
from mathutils import Vector, Matrix
import numpy as np

OUT = os.environ.get("BAKE_OUT", "public/models")
os.makedirs(OUT, exist_ok=True)

def wipe():
    for c in (bpy.data.objects, bpy.data.meshes, bpy.data.materials,
              bpy.data.images, bpy.data.node_groups, bpy.data.lights,
              bpy.data.cameras, bpy.data.collections):
        for x in list(c):
            try: c.remove(x, do_unlink=True)
            except Exception: pass

def newmesh(name, verts, faces, col=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    (col or bpy.context.scene.collection).objects.link(ob)
    return ob

def bm_to_obj(bm, name, col=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free(); me.update()
    ob = bpy.data.objects.new(name, me)
    (col or bpy.context.scene.collection).objects.link(ob)
    return ob

def box_bm(bm, x0, y0, z0, x1, y1, z1):
    """Axis-aligned box appended into bm; returns its faces."""
    vs = [bm.verts.new(v) for v in
          [(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),
           (x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]]
    F = [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    return [bm.faces.new([vs[i] for i in f]) for f in F]

def cyl_bm(bm, cx, cy, z0, z1, r, seg=12, taper=1.0):
    ring0 = [bm.verts.new((cx+math.cos(2*math.pi*i/seg)*r,
                           cy+math.sin(2*math.pi*i/seg)*r, z0)) for i in range(seg)]
    ring1 = [bm.verts.new((cx+math.cos(2*math.pi*i/seg)*r*taper,
                           cy+math.sin(2*math.pi*i/seg)*r*taper, z1)) for i in range(seg)]
    fs = []
    for i in range(seg):
        j = (i+1) % seg
        fs.append(bm.faces.new((ring0[i], ring0[j], ring1[j], ring1[i])))
    fs.append(bm.faces.new(list(reversed(ring0))))
    fs.append(bm.faces.new(ring1))
    return fs

def select_only(obs, active=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs: o.select_set(True)
    bpy.context.view_layer.objects.active = active or (obs[0] if obs else None)

def apply_bevel(ob, width=0.004, segments=2, angle=math.radians(35)):
    select_only([ob], ob)
    m = ob.modifiers.new("bev", 'BEVEL')
    m.width = width; m.segments = segments; m.limit_method = 'ANGLE'
    m.angle_limit = angle; m.harden_normals = False
    bpy.ops.object.modifier_apply(modifier=m.name)

def weld_bevel(ob, width=0.0025, segments=2, angle=math.radians(31), dist=2e-5):
    """Weld the face soup into a manifold, then chamfer every hard edge.

       Build emits every face with its own fresh vertices, which is what makes
       it cheap to write and is also why nothing in this kit had a bevel: a
       Bevel modifier needs shared edges and there were none, so the modifier
       ran and changed nothing. Welding first at 20 microns joins each box to
       itself (and any neighbour that was authored to exactly the same
       coordinate, which is what you want -- two plates butted at a shared
       corner should chamfer as one part) without pulling anything together
       that was not already coincident.

       The chamfer is the single largest thing separating a modelled part from
       a primitive. A 90-degree edge returns no highlight from any light in the
       room, so it reads as the boundary between two flat fills; 2.5 mm of
       chamfer picks up a specular line from every lamp and is what the eye
       actually uses to judge that something was machined. It is also cheap --
       triangles, not draw calls, and the interior has triangles to spare."""
    me = ob.data
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)
    bm.to_mesh(me); bm.free(); me.update()
    apply_bevel(ob, width=width, segments=segments, angle=angle)
    return ob

def img_new(name, size, srgb=True, is_float=False):
    im = bpy.data.images.new(name, size, size, alpha=False, float_buffer=is_float)
    im.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    return im

def img_np(im):
    a = np.empty(len(im.pixels), dtype=np.float32)
    im.pixels.foreach_get(a)
    w, h = im.size
    return a.reshape(h, w, 4)

def np_img(arr, name, srgb=False):
    h, w, _ = arr.shape
    im = bpy.data.images.get(name)
    if im: bpy.data.images.remove(im)
    im = bpy.data.images.new(name, w, h, alpha=False, float_buffer=False)
    im.colorspace_settings.name = 'sRGB' if srgb else 'Non-Color'
    im.pixels.foreach_set(np.ascontiguousarray(arr, dtype=np.float32).ravel())
    im.update()
    return im

def save_webp(im, path, quality=85):
    sc = bpy.context.scene
    st = sc.render.image_settings
    old = (st.file_format, st.quality, st.color_mode, st.color_depth)
    st.file_format = 'WEBP'; st.quality = quality
    st.color_mode = 'RGB'; st.color_depth = '8'
    im.save_render(path) if im.is_float and False else im.save(filepath=path)
    st.file_format, st.quality, st.color_mode, st.color_depth = old
    return os.path.getsize(path)

# ---------------------------------------------------------------- periodic noise
def pnoise(res, freq, seed=0, octaves=4, tile=1.0):
    """Periodic value-noise fbm on a res*res grid, period = res (so it tiles)."""
    rng = np.random.default_rng(seed)
    out = np.zeros((res, res), np.float32)
    amp, tot = 1.0, 0.0
    f = int(freq)
    for o in range(octaves):
        g = rng.random((f, f)).astype(np.float32)
        # bilinear upsample with wrap
        yy = np.arange(res, dtype=np.float32) * f / res
        xx = yy
        y0 = np.floor(yy).astype(int) % f; y1 = (y0+1) % f; fy = (yy - np.floor(yy))[:, None]
        x0 = np.floor(xx).astype(int) % f; x1 = (x0+1) % f; fx = (xx - np.floor(xx))[None, :]
        fy = fy*fy*(3-2*fy); fx = fx*fx*(3-2*fx)
        a = g[np.ix_(y0, x0)]; b = g[np.ix_(y0, x1)]
        c = g[np.ix_(y1, x0)]; d = g[np.ix_(y1, x1)]
        out += amp * ((a*(1-fx)+b*fx)*(1-fy) + (c*(1-fx)+d*fx)*fy)
        tot += amp; amp *= 0.5; f *= 2
    return out / tot
