HW, H, R    = 2.05, 2.55, 0.55
CHW, CH, CR = 1.15, 2.25, 0.40
DECK_Y      = 0.08
SP = os.environ.get("BAKE_TMP", "/tmp")

def dup(ob, x=0.0, y=0.0, z=0.0, ry=0.0, name=None):
    n = ob.copy(); n.data = ob.data          # linked copy: an occluder only
    n.location = (x, y, z); n.rotation_euler = (0, ry, 0)
    if name: n.name = name
    bpy.context.scene.collection.objects.link(n)
    return n

def build_assembly():
    kit_materials()
    masters = {}
    occ = []
    masters['corr_bay'] = tube_bay('corr_bay', CHW, CH, CR, 1.00, CHW-0.12, DECK_Y,
                                   rail=True, coveX=CHW*0.62, conduit=True)
    masters['hab_bay']  = tube_bay('hab_bay',  HW,  H,  R,  1.10, HW-0.30, DECK_Y,
                                   rail=False, coveX=1.28, conduit=True)
    masters['bulkhead'] = bulkhead('bulkhead', HW, H, R, CHW, CH, CR, deckY=DECK_Y)
    masters['locker']   = locker('locker')
    masters['locker_b'] = locker('locker_b', variant=1)
    masters['locker_c'] = locker('locker_c', variant=2)
    masters['locker_d'] = locker('locker_d', variant=3)
    masters['crate_a']  = crate('crate_a', 0.52, 1)
    masters['crate_b']  = crate('crate_b', 0.40, 2)
    masters['wallbox']  = wallbox('wallbox')
    masters['pipe_run'] = pipe_run('pipe_run', 2.14)
    masters['cable_drape'] = cable_drape('cable_drape', 2.06)
    masters['toolboard']   = toolboard('toolboard')
    masters['stack']       = stack('stack')
    masters['coverall']    = coverall('coverall')
    # ---- personal effects. One each, placed once, never mirrored.
    masters['resonance'] = resonance_wall('resonance')
    # ---- the two habitat stations the player stands in front of
    masters['archive'] = archive_terminal('archive')
    masters['port']    = observation_port('port')
    masters['pinboard'] = pinboard('pinboard')
    masters['helmet']   = helmet('helmet')
    masters['slates']   = slates('slates')
    # ---- loose stowage: the two pieces that are somebody's rather than the
    #      ship's, and the review's loudest finding.
    masters['stowbay']  = stowbay('stowbay')
    masters['netcargo'] = netcargo('netcargo')
    # ---- the cockpit. Unique, not repeated, so each piece is modelled in
    #      absolute coordinates and exported with its transform zeroed.
    masters['cp_tub'] = cockpit_tub()
    masters['cp_coaming'] = cockpit_coaming()
    masters['cp_pedestal'] = cockpit_pedestal()
    masters['cp_seat'] = pilot_seat()
    masters['cp_controls'] = flight_controls()
    masters['cp_overhead'] = overhead_panel()
    masters['cp_canopy'] = canopy_frame()
    masters['cp_stow'] = cockpit_stowage()

    # ---- chamfer every hard edge in the cockpit.
    #      Build emits face soup, so a Bevel modifier on its own does nothing:
    #      there are no shared edges for it to bevel. weld_bevel welds at 20
    #      microns first, which joins each part to itself and to anything
    #      authored to exactly the same coordinate, and only then chamfers.
    #
    #      This is the single largest thing separating a modelled part from a
    #      primitive, and its absence is why the whole cockpit read as a pile
    #      of boxes: a 90-degree edge returns no highlight from any lamp in the
    #      room, so it is the boundary between two flat fills and nothing else.
    #      It costs triangles and no draw calls, and the interior has triangles
    #      to spare -- 68.8k against the 569k the procedural version drew.
    #
    #      It used to run on the eight cp_* pieces and nothing else, excused as
    #      "never within two metres of the camera" -- which is false for a
    #      corridor the player walks down: a shoulder passes within 40 cm of the
    #      rubbing strake and the wallbox is a hand's width from the face at the
    #      archive station. Measured chamfer coverage was 100% of hard edges in
    #      the cockpit and 0% by construction everywhere else, and putting a
    #      corridor shot beside a cockpit shot showed it: every cockpit edge
    #      carried a highlight line and not one corridor edge did.
    #
    #      The bays are instanced ten times, but an instance is a draw call
    #      against a shared mesh -- the chamfer is paid for once in memory and
    #      in triangles, which is the resource this interior has spare (178k
    #      against the 569k the procedural version cost). Props get a slightly
    #      finer chamfer because they are smaller parts; a 2.5 mm round-over on
    #      a 40 mm cable clip eats the clip.
    for k, w in [(k, 0.0025) for k in ('cp_tub', 'cp_coaming', 'cp_pedestal',
                                       'cp_seat', 'cp_controls', 'cp_overhead',
                                       'cp_canopy', 'cp_stow')] + [
            ('corr_bay', 0.0030), ('hab_bay', 0.0030), ('bulkhead', 0.0030),
            ('locker', 0.0022), ('locker_b', 0.0022),
            ('locker_c', 0.0022), ('locker_d', 0.0022),
            # Finer on the loose stowage: a book board is 6 mm and a net cord
            # is 5 mm across, and a 2.2 mm round-over eats both.
            ('stowbay', 0.0012), ('netcargo', 0.0010),
            ('crate_a', 0.0022), ('crate_b', 0.0022),
            ('wallbox', 0.0018), ('pipe_run', 0.0016),
            ('toolboard', 0.0016), ('stack', 0.0018),
            ('pinboard', 0.0012), ('helmet', 0.0016), ('slates', 0.0014),
            ('resonance', 0.0022),
            # Finer on these two. The archive's keycap legends are 2.2 mm bars
            # and the port's clamp dogs are 7 mm heads; a 2.2 mm round-over
            # eats both. Bevel clamps overlap, so the big plates on the same
            # part still chamfer cleanly at 1.4 mm.
            ('archive', 0.0014), ('port', 0.0018)]:
        weld_bevel(masters[k], width=w, segments=2, angle=math.radians(31))

    # ---- lay the ship out so the occlusion each piece bakes is the occlusion
    #      it will actually sit in
    CORR_Z = [-2.90, -1.90, -0.90, 0.10]
    HAB_Z  = [1.15, 2.25, 3.35, 4.45, 5.55, 6.65]
    masters['corr_bay'].location = (0, 0, CORR_Z[1])
    masters['hab_bay'].location  = (0, 0, HAB_Z[2])
    masters['bulkhead'].location = (0, 0, 0.60)
    for z in CORR_Z:
        if abs(z - CORR_Z[1]) > 1e-6: occ.append(dup(masters['corr_bay'], z=z))
    for z in HAB_Z:
        if abs(z - HAB_Z[2]) > 1e-6: occ.append(dup(masters['hab_bay'], z=z))
    occ.append(dup(masters['hab_bay'], z=-3.95))
    occ.append(dup(masters['bulkhead'], z=-3.40))
    # props, where Interior.js puts them
    # Four positions, four different lockers. A, D, B, C down the port wall:
    # the plain one, the tall single-door one, the one standing open and the
    # netted and dented one. No master is placed twice, which is the whole
    # point -- the review read the run as "same outline, same louvre group,
    # same handle, same rivet pattern, four times".
    masters['locker'].location = (-HW+0.17, 0, 3.30); masters['locker'].rotation_euler=(0, math.pi/2, 0)
    masters['locker_d'].location = (-HW+0.17, 0, 4.16)
    masters['locker_d'].rotation_euler = (0, math.pi/2, 0)
    # the one with a door open, and it is the one the helmet sits above
    masters['locker_b'].location = (-HW+0.17, 0, 5.02)
    masters['locker_b'].rotation_euler = (0, math.pi/2, 0)
    masters['locker_c'].location = (-HW+0.17, 0, 5.88)
    masters['locker_c'].rotation_euler = (0, math.pi/2, 0)
    # loose stowage: the open shelf on the starboard wall at chest height, and
    # the netted freight in the aft starboard corner. -pi/2 on the starboard
    # wall: both are modelled facing +Z, like the lockers.
    masters['stowbay'].location = (HW-0.03, 1.02, 1.62)
    masters['stowbay'].rotation_euler = (0, -math.pi/2, 0)
    masters['netcargo'].location = (1.44, DECK_Y, 6.02)
    masters['netcargo'].rotation_euler = (0, -0.34, 0)
    masters['crate_a'].location = (1.50, DECK_Y, 1.40); masters['crate_a'].rotation_euler=(0, 0.5, 0)
    masters['crate_b'].location = (1.35, DECK_Y, 1.95); masters['crate_b'].rotation_euler=(0, -0.7, 0)
    occ.append(dup(masters['crate_b'], x=1.55, y=DECK_Y+0.36, z=1.40, ry=1.2))
    masters['wallbox'].location = (HW-0.03, 1.42, 2.30); masters['wallbox'].rotation_euler=(0, math.pi/2, 0)
    occ.append(dup(masters['wallbox'], x=-CHW+0.03, y=1.46, z=-2.30, ry=-math.pi/2))
    occ.append(dup(masters['wallbox'], x=HW-0.03, y=1.38, z=5.30, ry=math.pi/2))
    masters['pipe_run'].location = (0, CH-0.16, -2.35); masters['pipe_run'].rotation_euler=(0, 0, 0)
    for z in (-1.35, -0.45):
        occ.append(dup(masters['pipe_run'], y=CH-0.16, z=z))
    # corridor dressing. Placed at the same transforms Interior.js uses, so the
    # contact shadow baked under each one is the shadow it actually stands in.
    masters['cable_drape'].location = (0, CH-0.20, -1.86)
    masters['toolboard'].location = (CHW-0.035, 0.86, -2.62)
    masters['toolboard'].rotation_euler = (0, math.pi/2, 0)
    masters['stack'].location = (-CHW+0.30, DECK_Y, -0.30)
    masters['stack'].rotation_euler = (0, 0.42, 0)
    # -pi/2, not +pi/2: the suit is modelled facing -Z and this one hangs on
    # the *port* wall, so it has to turn the other way or it faces into it.
    masters['coverall'].location = (-CHW+0.075, 0.55, -3.02)
    masters['coverall'].rotation_euler = (0, -math.pi/2, 0)
    occ.append(dup(masters['crate_b'], x=CHW-0.28, y=DECK_Y, z=-3.05, ry=-0.35))
    # personal effects, at the transforms Interior.js uses
    masters['pinboard'].location = (HW-0.035, 1.62, 5.62)
    masters['pinboard'].rotation_euler = (0, -math.pi/2, 0)
    masters['helmet'].location = (-HW+0.20, 1.585, 5.02)
    masters['helmet'].rotation_euler = (0, 0.62, 0)
    masters['slates'].location = (HW-0.115, 1.20, 3.02)
    masters['slates'].rotation_euler = (0, -math.pi/2, 0)
    # the resonance wall is authored in absolute coordinates, like the cockpit
    masters['resonance'].location = (0, 0, 0)
    # the two stations, at the transforms Interior.js places them at -- so the
    # contact occlusion each one bakes is the occlusion it stands in
    masters['archive'].location = (-HW + 0.30, 0, 0.95)
    masters['archive'].rotation_euler = (0, math.pi / 2, 0)
    masters['port'].location = (HW - 0.02, 1.35, 4.30)
    masters['port'].rotation_euler = (0, -math.pi / 2, 0)

    # ---- occluders that are not part of the kit but shape its occlusion:
    #      the cockpit tub forward of the bulkhead and the aft end cap
    B = Build()
    # Forward of the bulkhead only the tub occludes: above the waist the hull
    # is canopy glass, and baking it as a solid roof buries the whole cockpit
    # in an occlusion it does not have.
    P = rounded_profile(HW, H, R, 7)
    for i in range(len(P)-1):
        B.quad((P[i][0],P[i][1],7.20), (0,H*0.5,7.20), (0,H*0.5,7.20), (P[i+1][0],P[i+1][1],7.20),
               MI['KIT_HULL'])
    B.box(-1.70, 0, 7.21, 1.70, H, 7.30, MI['KIT_HULL'])
    occ.append(B.obj('occ_shell'))
    return masters, occ

def unwrap_and_pack(masters, res=2048):
    bpy.ops.object.select_all(action='DESELECT')
    for ob in masters.values():
        select_only([ob], ob)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=1.40, island_margin=0.004,
                                 correct_aspect=True, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode='OBJECT')
    obs = list(masters.values())
    select_only(obs, obs[0])
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(margin=0.006, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')

def bake_kit_ao(masters, occ, res=2048, dist=1.5, samples=128):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'GPU'
    sc.cycles.samples = samples; sc.cycles.use_denoising = True
    bk = sc.render.bake
    bk.use_selected_to_active = False
    bk.margin = 8; bk.margin_type = 'ADJACENT_FACES'; bk.use_clear = True
    im = bpy.data.images.new('kit_ao', res, res, alpha=False, float_buffer=False)
    im.colorspace_settings.name = 'Non-Color'
    for name in MAT_NAMES:
        m = bpy.data.materials[name]
        m.use_nodes = True
        nt = m.node_tree; nt.nodes.clear()
        ao = nt.nodes.new('ShaderNodeAmbientOcclusion')
        ao.samples = 16; ao.only_local = False; ao.inside = False
        ao.inputs['Distance'].default_value = dist
        em = nt.nodes.new('ShaderNodeEmission')
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(ao.outputs['AO'], em.inputs['Color'])
        nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
        tx = nt.nodes.new('ShaderNodeTexImage'); tx.image = im
        nt.nodes.active = tx
    obs = list(masters.values())
    select_only(obs, obs[0])
    bpy.ops.object.bake(type='EMIT')
    return im
