# ------------------------------------------------------------------- bake rig
def flat_plane(tile, name="lo"):
    bm = bmesh.new()
    v = [bm.verts.new(p) for p in [(0,0,0),(tile,0,0),(tile,tile,0),(0,tile,0)]]
    f = bm.faces.new(v)
    uv = bm.loops.layers.uv.new("UVMap")
    for i, l in enumerate(f.loops):
        l[uv].uv = [(0,0),(1,0),(1,1),(0,1)][i]
    ob = bm_to_obj(bm, name)
    return ob

def ao_emit_material(dist, name="bakeAO"):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    ao = nt.nodes.new('ShaderNodeAmbientOcclusion')
    ao.samples = 24; ao.only_local = True
    ao.inputs['Distance'].default_value = dist
    em = nt.nodes.new('ShaderNodeEmission')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(ao.outputs['AO'], em.inputs['Color'])
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return m

def height_emit_material(name="bakeH"):
    """Emission = world Z of the shading point. A height field baked by ray
       tracing, which resolves overhangs the way a normal bake from a flat cage
       cannot: vertical walls have no cross-section for a downward ray, so a
       tangent-space normal bake off a plane records nothing at all for them."""
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    em  = nt.nodes.new('ShaderNodeEmission')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(geo.outputs['Position'], sep.inputs['Vector'])
    nt.links.new(sep.outputs['Z'], em.inputs['Color'])
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return m

def plain_material(name="plain"):
    m = bpy.data.materials.new(name); m.use_nodes = True
    return m

def bake_maps(hi, tile, res, ao_dist, tag, extrusion=0.05, ray=0.10, samples=64):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'GPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    bk = sc.render.bake
    bk.use_selected_to_active = True
    bk.cage_extrusion = extrusion
    bk.max_ray_distance = ray
    bk.margin = 0
    bk.use_clear = True
    bk.normal_space = 'TANGENT'
    bk.normal_r, bk.normal_g, bk.normal_b = 'POS_X', 'POS_Y', 'POS_Z'

    lo = flat_plane(tile, "lo_" + tag)
    lomat = plain_material("lomat_" + tag)
    lo.data.materials.append(lomat)
    nt = lomat.node_tree
    texnode = nt.nodes.new('ShaderNodeTexImage')
    nt.nodes.active = texnode

    results = {}

    def do(bake_type, imgname, is_float, hi_mat=None):
        im = bpy.data.images.new(imgname, res, res, alpha=False, float_buffer=is_float)
        im.colorspace_settings.name = 'Non-Color'
        texnode.image = im
        if hi_mat is not None:
            hi.data.materials.clear(); hi.data.materials.append(hi_mat)
        select_only([hi, lo], lo)
        bpy.ops.object.bake(type=bake_type)
        results[imgname] = img_np(im)
        return im

    do('EMIT', 'bk_h_' + tag, True, height_emit_material('hM_' + tag))
    do('EMIT', 'bk_ao_' + tag, True, ao_emit_material(ao_dist, "aoM_" + tag))
    return results, lo
