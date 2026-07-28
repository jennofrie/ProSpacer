# =============================================================================
#  Grey-clay turntable.
#
#  The reason this file exists: textures, emissives and a good lighting rig
#  hide box-stacking completely. The cockpit passed every in-game screenshot
#  for weeks while being, in fact, a pile of axis-aligned cuboids -- the baked
#  plate texture put a highlight on every face and the eye read "detail" where
#  there was only "many boxes". Flat grey under one hard key does not do that.
#  A silhouette is a silhouette and a 90-degree edge with no chamfer on it is
#  visibly a 90-degree edge with no chamfer on it.
#
#  So: nothing goes into the kit until it has been looked at in clay. Render
#  before baking, because baking a bad model only gives you a well-lit bad one.
# =============================================================================

def clay_material():
    m = bpy.data.materials.get('CLAY') or bpy.data.materials.new('CLAY')
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    b.inputs['Base Color'].default_value = (0.32, 0.315, 0.30, 1.0)
    b.inputs['Roughness'].default_value = 0.52
    b.inputs['Metallic'].default_value = 0.0
    # A hint of specular is what makes a chamfer show. With a pure lambert the
    # whole point of the exercise -- is there a highlight running along that
    # edge or not -- cannot be answered.
    o = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(b.outputs['BSDF'], o.inputs['Surface'])
    return m


def clay_light():
    """One hard key, a big soft fill on the key's opposite side, and a cold rim.
       Same rule as the game: nothing is lit from the camera, and shadows are
       never black -- a black shadow hides exactly the silhouette detail this
       render is for."""
    #  The bounce is not decoration. Half the surfaces worth judging on this
    #  ship face *down* -- an overhead console, the underside of a coaming, the
    #  soffit of a pedestal -- and under a key from above and a rim from behind
    #  every one of them renders as an unreadable black field. It is weak and
    #  it is directional, so it lifts those faces without filling in the
    #  shadow that a silhouette is read from.
    for n, kind, loc, rot, energy, extra in (
            ('key', 'SUN', (0, 6, 0), (-0.95, 0.0, -0.62), 4.2, {'angle': 0.07}),
            ('rim', 'SUN', (0, 3, 0), (1.15, 0.0, 2.55), 1.9, {'angle': 0.25}),
            ('bounce', 'SUN', (0, -4, 0), (2.36, 0.0, 0.85), 1.5, {'angle': 0.45})):
        d = bpy.data.lights.new(n, kind)
        d.energy = energy
        for k, v in extra.items():
            setattr(d, k, v)
        ob = bpy.data.objects.new(n, d)
        ob.location = loc
        ob.rotation_euler = rot
        bpy.context.scene.collection.objects.link(ob)
    w = bpy.context.scene.world or bpy.data.worlds.new('W')
    bpy.context.scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.055, 0.062, 0.072, 1.0)
        bg.inputs[1].default_value = 1.0


def aim(cam, loc, target, up=(0.0, 1.0, 0.0)):
    """Point a camera, with the *game's* up axis as the image's up axis.

       to_track_quat('-Z', 'Y') aligns the camera's screen-up to Blender's
       global +Z, and this kit is modelled in the game's axes inside Blender's
       coordinate slots -- so Blender's +Z is the game's *aft*. Using the
       convenience call renders every piece lying on its side, which cost one
       confused reading of a stick that appeared to be pointing sideways. The
       basis is built by hand instead."""
    f = (Vector(target) - Vector(loc)).normalized()
    u = Vector(up)
    if abs(f.dot(u)) > 0.999:
        u = Vector((0.0, 0.0, 1.0))
    r = f.cross(u).normalized()
    u = r.cross(f).normalized()
    cam.location = loc
    cam.matrix_world = Matrix(((r.x, u.x, -f.x, loc.x),
                               (r.y, u.y, -f.y, loc.y),
                               (r.z, u.z, -f.z, loc.z),
                               (0.0, 0.0, 0.0, 1.0)))


def clay_shots(obs, out_prefix, views, size=1000, samples=40, pad=1.10,
               focus=None):
    """Render `obs` from each (azimuth, elevation) in `views`, in clay.

       Views are given in degrees about the object's own bounding sphere, so
       the framing is identical between runs and two renders can be compared
       directly. `focus` is (x, y, z, radius) and overrides the bounding
       sphere, which is how one control is framed out of a piece that also
       carries the other two."""
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'GPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.render.resolution_x = sc.render.resolution_y = size
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'AgX'
    sc.render.image_settings.file_format = 'PNG'

    clay = clay_material()
    for ob in bpy.data.objects:
        if ob.type != 'MESH':
            continue
        ob.hide_render = ob not in obs
        if ob in obs:
            ob.data.materials.clear()
            ob.data.materials.append(clay)

    if focus:
        ctr = Vector(focus[:3])
        rad = focus[3]
    else:
        pts = [ob.matrix_world @ Vector(c) for ob in obs for c in ob.bound_box]
        lo = Vector((min(p[i] for p in pts) for i in range(3)))
        hi = Vector((max(p[i] for p in pts) for i in range(3)))
        ctr = (lo + hi) / 2
        rad = max((p - ctr).length for p in pts)

    cam_d = bpy.data.cameras.new('clay_cam')
    cam_d.lens = 70.0
    cam = bpy.data.objects.new('clay_cam', cam_d)
    sc.collection.objects.link(cam)
    sc.camera = cam
    clay_light()

    out = []
    for (name, az, el) in views:
        a, e = math.radians(az), math.radians(el)
        # -Z is the ship's nose, so azimuth 0 looks at the piece from the front
        d = Vector((math.cos(e) * math.sin(a), math.sin(e),
                    -math.cos(e) * math.cos(a)))
        aim(cam, ctr + d * (rad / math.tan(cam_d.angle / 2) * pad), ctr)
        p = '%s_%s.png' % (out_prefix, name)
        sc.render.filepath = p
        bpy.ops.render.render(write_still=True)
        out.append(p)
    return out
