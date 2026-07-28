# =============================================================================
#  Modular interior kit.
#
#  Modelled directly in the game's coordinate frame -- X right, Y up, Z aft --
#  and exported with export_yup=False, so the numbers in Interior.js and the
#  numbers here are the same numbers. Blender's viewport is on its side; the
#  bake does not care and neither does the exporter.
# =============================================================================

MAT_NAMES = ['KIT_HULL', 'KIT_DARK', 'KIT_ACCENT', 'KIT_DECK', 'KIT_RAIL',
             'KIT_SEAT', 'KIT_RUBBER', 'KIT_SHELL']
MI = {n: i for i, n in enumerate(MAT_NAMES)}

def kit_materials():
    out = []
    for n in MAT_NAMES:
        m = bpy.data.materials.get(n) or bpy.data.materials.new(n)
        m.use_nodes = True
        out.append(m)
    return out

def seamed_profile(hw, h, r, seg=7, seams=()):
    """The hull section, with real plate seams cut into the straight runs.

       The bay skin was four corner arcs joined by four *single* quads: the
       whole port wall of a habitat bay, 1.45 m of it, was one flat polygon
       from the coving to the ceiling cove. Every plate boundary, louvre and
       panel edge on it was painted into the tile map, which is exactly the
       reviewer's complaint -- with no relief there is no edge to take a
       highlight on one side and darken on the other, and the wall reads as
       wallpaper however good the map is.

       `seams` is a list of fractions along each straight run. Each one becomes
       four vertices -- shoulder, floor, floor, shoulder -- and the caller
       pushes the two floor vertices outward, so what runs the length of every
       bay is a 30 mm groove with drafted walls between real plates. It costs
       six vertices per run and nothing per draw call, and it is the single
       cheapest way to turn a painted wall into a plated one.

       Returns (points, extra_offset_per_point)."""
    arcs = []
    for (cx, cy, a0, a1) in ((hw-r, r, -math.pi/2, 0.0),
                             (hw-r, h-r, 0.0, math.pi/2),
                             (-hw+r, h-r, math.pi/2, math.pi),
                             (-hw+r, r, math.pi, math.pi*1.5)):
        arcs.append([(cx + math.cos(a0 + (a1-a0)*(i/seg))*r,
                      cy + math.sin(a0 + (a1-a0)*(i/seg))*r)
                     for i in range(seg + 1)])
    p, extra = [], []
    for k in range(4):
        p.extend(arcs[k]); extra.extend([0.0] * len(arcs[k]))
        a, b = arcs[k][-1], arcs[(k+1) % 4][0]
        for t in seams:
            for (dt, e) in ((-0.0100, 0.0), (-0.0048, 0.011),
                            (0.0048, 0.011), (0.0100, 0.0)):
                u = t + dt
                p.append((a[0] + (b[0]-a[0])*u, a[1] + (b[1]-a[1])*u))
                extra.append(e)
    return p, extra


def rounded_profile(hw, h, r, seg=7):
    return seamed_profile(hw, h, r, seg)[0]

def profile_normals(p):
    n = len(p)
    out = []
    for i in range(n):
        a = p[(i-1) % n]; b = p[(i+1) % n]
        dx, dy = b[0]-a[0], b[1]-a[1]
        l = math.hypot(dx, dy) or 1.0
        out.append((dy/l, -dx/l))
    return out

class Build:
    """A bmesh with material indices, in game coordinates."""
    def __init__(self):
        self.bm = bmesh.new()
    def face(self, pts, mat):
        vs = [self.bm.verts.new(p) for p in pts]
        try:
            f = self.bm.faces.new(vs)
            f.material_index = mat
            return f
        except ValueError:
            return None
    def quad(self, a, b, c, d, mat):
        return self.face([a, b, c, d], mat)
    def box(self, x0, y0, z0, x1, y1, z1, mat, skip=()):
        X = sorted((x0, x1)); Y = sorted((y0, y1)); Z = sorted((z0, z1))
        x0, x1 = X; y0, y1 = Y; z0, z1 = Z
        f = {
          'zn': [(x0,y0,z0),(x0,y1,z0),(x1,y1,z0),(x1,y0,z0)],
          'zp': [(x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)],
          'yn': [(x0,y0,z0),(x1,y0,z0),(x1,y0,z1),(x0,y0,z1)],
          'yp': [(x0,y1,z0),(x0,y1,z1),(x1,y1,z1),(x1,y1,z0)],
          'xn': [(x0,y0,z0),(x0,y0,z1),(x0,y1,z1),(x0,y1,z0)],
          'xp': [(x1,y0,z0),(x1,y1,z0),(x1,y1,z1),(x1,y0,z1)],
        }
        for k, v in f.items():
            if k not in skip: self.face(v, mat)
    def tube(self, prof, nrm, zs, offs, mat, i0=0, i1=None, matfn=None,
             extra=None):
        """Loft a profile along Z with a per-station radial offset. Positive
           offset pushes the skin outward, i.e. away from the room, which is
           what makes a recessed bay.

           `extra` is a per-*point* offset added on top, which is what cuts the
           longitudinal plate seams: the section carries them, so they run the
           whole length of the ship and through every bay joint."""
        i1 = len(prof) if i1 is None else i1
        ex = extra or [0.0] * len(prof)
        rings = []
        for (z, o) in zip(zs, offs):
            rings.append([(prof[i][0] + nrm[i][0]*(o + ex[i]),
                           prof[i][1] + nrm[i][1]*(o + ex[i]), z)
                          for i in range(len(prof))])
        for k in range(len(rings)-1):
            A, B = rings[k], rings[k+1]
            for i in range(i0, i1-1):
                j = i+1
                m = matfn(i, k) if matfn else mat
                # Wound to face *inward*. The occlusion bake samples the
                # hemisphere along the normal, so a skin wound outward bakes as
                # a surface facing open space -- unoccluded everywhere, which
                # is the exact opposite of what this whole exercise is for.
                self.quad(A[j], A[i], B[i], B[j], m)
    def obj(self, name):
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me); self.bm.free(); me.update()
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        for m in bpy.data.materials:
            if m.name in MI: pass
        for n in MAT_NAMES: ob.data.materials.append(bpy.data.materials[n])
        return ob

def cyl_z(B, cx, cy, z0, z1, r, mat, seg=12):
    for i in range(seg):
        a0 = 2*math.pi*i/seg; a1 = 2*math.pi*(i+1)/seg
        p0 = (cx+math.cos(a0)*r, cy+math.sin(a0)*r)
        p1 = (cx+math.cos(a1)*r, cy+math.sin(a1)*r)
        B.quad((p0[0],p0[1],z0),(p1[0],p1[1],z0),(p1[0],p1[1],z1),(p0[0],p0[1],z1), mat)

def cyl_y(B, cx, cz, y0, y1, r, mat, seg=10, taper=0.74):
    """A capped boss on a horizontal surface — a deck fastener head. Tapered,
       because a countersunk head is a cone and a straight cylinder with a flat
       lid is a peg."""
    ring0 = [(cx+math.cos(2*math.pi*i/seg)*r, y0, cz+math.sin(2*math.pi*i/seg)*r)
             for i in range(seg)]
    ring1 = [(cx+math.cos(2*math.pi*i/seg)*r*taper, y1,
              cz+math.sin(2*math.pi*i/seg)*r*taper) for i in range(seg)]
    for i in range(seg):
        j = (i+1) % seg
        B.quad(ring0[i], ring0[j], ring1[j], ring1[i], mat)
    B.face(ring1, mat)


def cyl_x(B, cy, cz, x0, x1, r, mat, seg=10):
    for i in range(seg):
        a0 = 2*math.pi*i/seg; a1 = 2*math.pi*(i+1)/seg
        p0 = (cy+math.cos(a0)*r, cz+math.sin(a0)*r)
        p1 = (cy+math.cos(a1)*r, cz+math.sin(a1)*r)
        B.quad((x0,p0[0],p0[1]),(x0,p1[0],p1[1]),(x1,p1[0],p1[1]),(x1,p0[0],p0[1]), mat)

# ------------------------------------------------------ relief on a flat wall
#
#  Everything below exists because "the detail is painted, not modelled" was
#  the reviewer's second finding and the walls of the walkable interior were
#  the worst case of it. A louvre drawn into an albedo map is the same value
#  from every angle; a louvre made of six tilted slats goes light on the top
#  face and dark underneath as the player walks past it, and that change is the
#  entire difference between a surface and a picture of one.

def slab(B, back, front, mat):
    """A closed slab between two matching quads, wound from its own centre.

       Winding on a swept or tilted face is the failure that produces *nothing*
       rather than something wrong -- an inside-out face is culled in the game
       and bakes as unoccluded. Deriving it from a point known to be inside the
       solid removes the whole class of mistake."""
    c = tuple(sum(p[j] for p in list(back) + list(front)) / 8.0 for j in range(3))
    face_out(B, back, c, mat)
    face_out(B, front, c, mat)
    for i in range(4):
        j = (i + 1) % 4
        face_out(B, [back[i], back[j], front[j], front[i]], c, mat)


def louvre(B, sx, xw, y0, y1, z0, z1, n, mat, mat_frame, depth=0.030):
    """A ventilation grille on a wall whose outward normal is +sx in x: a
       raised bezel with n tilted slats standing in it.

       The slats rake down and inboard, which is how a real louvre sheds --
       and, more to the point here, it is what puts a lit face and a shaded
       face on the same fitting under one lamp."""
    xi = sx * (xw - depth)                     # inboard face of the bezel
    for (a, b) in ((z0 - 0.022, z0), (z1, z1 + 0.022)):
        B.box(sx * xw, y0 - 0.022, a, xi, y1 + 0.022, b, mat_frame)
    for (a, b) in ((y0 - 0.022, y0), (y1, y1 + 0.022)):
        B.box(sx * xw, a, z0, xi, b, z1, mat_frame)
    pitch = (y1 - y0) / n
    for k in range(n):
        ya = y0 + k * pitch
        yb = ya + pitch * 0.86
        xa, xb = sx * (xw - 0.004), sx * (xw - depth * 0.82)
        back = [(xa, ya, z0), (xa, ya, z1), (xb, yb, z1), (xb, yb, z0)]
        front = [(xa, ya - 0.007, z0), (xa, ya - 0.007, z1),
                 (xb, yb - 0.007, z1), (xb, yb - 0.007, z0)]
        slab(B, back, front, mat)


def hatch(B, sx, xw, yc, zc, w, hgt, mat, mat_trim, proud=0.016):
    """A bolted access panel: a plate standing proud of the skin inside a
       recessed margin, with a fastener boss at each corner and a lifting
       handle. Every one of these in the cabin used to be a rectangle in the
       tile map."""
    x0, x1 = sx * xw, sx * (xw - proud)
    B.box(x0, yc - hgt / 2, zc - w / 2, x1, yc + hgt / 2, zc + w / 2, mat)
    # the margin: a thin lip round the plate, so the join is a groove
    B.box(x0, yc - hgt / 2 - 0.014, zc - w / 2 - 0.014,
          sx * (xw - 0.005), yc + hgt / 2 + 0.014, zc + w / 2 + 0.014, mat_trim)
    for (dy, dz) in ((-1, -1), (-1, 1), (1, -1), (1, 1)):
        cyl_x(B, yc + dy * (hgt / 2 - 0.032), zc + dz * (w / 2 - 0.032),
              x0, sx * (xw - proud - 0.008), 0.011, mat_trim, 8)
    # recessed pull, and the hinge knuckles down one edge
    B.box(x1, yc - 0.030, zc - 0.050, sx * (xw - proud + 0.010),
          yc + 0.030, zc + 0.050, mat_trim)
    for k in range(2):
        cyl_x(B, yc - hgt / 2 + 0.026, zc + (-1 if k else 1) * (w / 2 - 0.048),
              x0, sx * (xw - proud - 0.014), 0.014, mat_trim, 8)


# ------------------------------------------------------------------ tube bay
def tube_bay(name, hw, h, r, L, deckHW, deckY=0.08, rail=True, seg=7,
             coveX=None, conduit=True):
    """One repeating slice of hull: deck, coving, walls, ceiling, frames and
       the services that run the length. Built as a complete slice rather than
       as separate wall/floor/ceiling parts so that the junctions between them
       -- which is where the reviewer said nothing ever darkened -- are real
       geometry with real baked occlusion."""
    B = Build()
    #  Three seams up each wall and across the ceiling. Not evenly spaced: a
    #  regular division is read as a grid and a grid is read as tiling, which
    #  is the thing being fixed. These are where the plate widths of a rolled
    #  section would actually fall -- narrow at the coving, wide up the wall.
    prof, pextra = seamed_profile(hw, h, r, seg, (0.22, 0.50, 0.79))
    nrm  = profile_normals(prof)
    hz = L/2
    # frames at both ends, a shallow bay inboard of them, a deeper one between
    zs   = [-hz, -hz+0.052, -hz+0.062, -hz+0.24, -hz+0.252,
             hz-0.252, hz-0.24, hz-0.062, hz-0.052, hz]
    offs = [0.0,  0.0,      0.032,     0.032,    0.062,
            0.062, 0.032,   0.032,     0.0,      0.0]
    # the bottom of the profile is under the deck plate; start the skin at the
    # first point that clears it
    i0 = 0
    while i0 < len(prof)-1 and prof[i0][1] < deckY - 0.02: i0 += 1
    i1 = len(prof)
    while i1 > 1 and prof[i1-1][1] < deckY - 0.02: i1 -= 1
    B.tube(prof, nrm, zs, offs, MI['KIT_HULL'], i0-1, i1+1, extra=pextra)

    # ---- the tier of detail that used to be painted.
    #      One louvre and one bolted access panel per bay, on opposite walls at
    #      different heights, standing in the deep part of the bay recess. The
    #      wall is at hw + 0.062 there, so a fitting on it is genuinely sunk
    #      into the plating rather than glued to a flat sheet.
    WX = hw + 0.062
    louvre(B, 1, WX, 1.52, 1.86, -L*0.20, L*0.20, 6,
           MI['KIT_DARK'], MI['KIT_HULL'])
    hatch(B, -1, WX, 1.62, 0.0, L*0.46, 0.44, MI['KIT_HULL'], MI['KIT_DARK'])
    #  and a smaller pair low down, where a walking eye passes closest
    hatch(B, 1, WX, 0.62, -L*0.24, L*0.34, 0.30, MI['KIT_HULL'], MI['KIT_DARK'])
    louvre(B, -1, WX, 0.42, 0.60, -L*0.16, L*0.16, 4,
           MI['KIT_DARK'], MI['KIT_HULL'], depth=0.022)

    # ---- deck plate, with a chamfered edge and a coving fillet into the wall
    dz0, dz1 = -hz, hz
    #      The plate itself stops 12 mm short of the walking surface and the
    #      surface is laid on it as real plates with real gaps, rather than
    #      being one slab with the seams drawn on. Six plates a bay, a 26 mm
    #      groove between them, and a countersunk fastener at every corner --
    #      which is what the player is standing on and looking straight down at
    #      for the whole walk to the helm.
    B.box(-deckHW, 0.0, dz0, deckHW, deckY-0.012, dz1, MI['KIT_DECK'], skip=('yn',))
    XS = [-deckHW, -deckHW*0.34, deckHW*0.34, deckHW]
    ZS = [dz0, 0.0, dz1]
    for a in range(3):
        for b in range(2):
            gx, gz = 0.013, 0.013
            x0, x1 = XS[a] + (gx if a else 0.004), XS[a+1] - (gx if a < 2 else 0.004)
            z0p, z1p = ZS[b] + (gz if b else 0.004), ZS[b+1] - (gz if b else 0.004)
            B.box(x0, deckY-0.012, z0p, x1, deckY, z1p, MI['KIT_DECK'], skip=('yn',))
            for (sa, sb) in ((0, 0), (0, 1), (1, 0), (1, 1)):
                cx = (x0 + 0.038) if sa == 0 else (x1 - 0.038)
                cz = (z0p + 0.038) if sb == 0 else (z1p - 0.038)
                cyl_y(B, cx, cz, deckY-0.002, deckY+0.005, 0.015,
                      MI['KIT_DARK'], 8)
    #      a raised nosing across the bay joint, where two plates butt
    for z in (dz0, dz1):
        B.box(-deckHW+0.02, deckY-0.012, z-0.020, deckHW-0.02, deckY+0.005,
              z+0.020, MI['KIT_DARK'], skip=('yn',))
    for sx in (-1, 1):
        x = sx*deckHW
        # cove: deck edge up to the wall skin, a 45 deg fillet
        xw = sx*(hw - 0.004)
        # wound so the visible face is the one pointing into the room on both sides
        c = [(x, deckY, dz0), (x, deckY, dz1), (xw, deckY+0.075, dz1), (xw, deckY+0.075, dz0)]
        if sx < 0: c.reverse()
        B.quad(c[0], c[1], c[2], c[3], MI['KIT_DARK'])
        # skirting board over the cove
        B.box(sx*(hw-0.055), deckY+0.070, dz0, xw, deckY+0.135, dz1, MI['KIT_DARK'])
    # a recessed service channel down the centreline of the deck
    B.box(-0.17, deckY-0.001, dz0, 0.17, deckY+0.010, dz1, MI['KIT_DARK'])
    for k in range(2):
        z = dz0 + L*(0.28 + 0.44*k)
        # sunk 4 mm into the plate: a strip whose underside is exactly coplanar
        # with the deck it sits on is a z-fight, not a joint
        B.box(-deckHW+0.05, deckY-0.004, z-0.022, deckHW-0.05, deckY+0.008, z+0.022, MI['KIT_DARK'])

    # ---- rubbing strake at hand height, and the brackets that carry it.
    #      Painted alloy, not oxide orange: a strake runs the whole length of
    #      both walls, and at accent colour that is thirty metres of the one
    #      saturated hue in the palette in a single frame.
    #
    #      Port and starboard run it at different heights, on different
    #      brackets, and only one side carries the accent stripe. This bay is
    #      placed ten times down the ship and is most of the wall area in any
    #      frame outside the cockpit; built from one symmetric loop it was the
    #      largest single contributor to the interior measuring 63-68% of its
    #      central pixels within six levels of their own mirror image. A ship
    #      is symmetric in its *structure* -- frames, deck, section -- and
    #      almost never in what is bolted to it.
    for sx in (-1, 1):
        xw = sx*(hw - 0.010)
        y0 = 0.96 if sx < 0 else 1.09
        B.box(sx*(hw-0.062), y0, dz0, xw, y0+0.085, dz1, MI['KIT_DARK'])
        if sx < 0:
            B.box(sx*(hw-0.068), y0+0.042, dz0, xw, y0+0.062, dz1, MI['KIT_ACCENT'])
        B.box(sx*(hw-0.030), y0-0.055, dz0, xw, y0+0.005, dz1, MI['KIT_DARK'])
        for k in range(3 if sx < 0 else 2):
            z = dz0 + (L*(0.22 + 0.56*k) if sx < 0 else L*(0.34 + 0.40*k))
            if z > dz1: continue
            B.box(sx*(hw-0.085), y0-0.060, z-0.030, xw, y0+0.100, z+0.030, MI['KIT_DARK'])

    # ---- ceiling: a light trough between two proud coves
    cx = coveX if coveX is not None else hw*0.62
    for sx in (-1, 1):
        x = sx*cx
        B.box(x-0.115, h-0.145, dz0, x+0.115, h-0.055, dz1, MI['KIT_DARK'])
        B.box(x-0.075, h-0.155, dz0, x+0.075, h-0.135, dz1, MI['KIT_DARK'])
    # ceiling ribs across the trough
    for k in range(3):
        z = dz0 + L*(0.18 + 0.32*k)
        B.box(-cx+0.06, h-0.115, z-0.016, cx-0.06, h-0.055, z+0.016, MI['KIT_DARK'])

    # ---- services in the upper corners. Port carries a pipe bundle; starboard
    #      carries a cable tray, at a different height, on different brackets.
    #      Two systems doing two jobs, which is what is actually up there.
    if conduit:
        for k in range(3):
            rr = 0.024 + k*0.008
            cyl_z(B, -(hw - 0.145 - k*0.058), h - 0.215 - k*0.050, dz0, dz1, rr,
                  MI['KIT_DARK'], 10)
        zc = dz0 + L*0.5
        B.box(-(hw-0.245), h-0.30, zc-0.026, -(hw-0.085), h-0.155, zc+0.026, MI['KIT_DARK'])
        B.box(-(hw-0.215), h-0.335, zc-0.020, -(hw-0.130), h-0.300, zc+0.020, MI['KIT_ACCENT'])
        # starboard: an open cable tray on stand-off brackets, with the loom in
        # it. Kept narrow and tucked into the corner: the first cut was 0.27 m
        # of pale horizontal plate hanging under the cove light, which from
        # inside the corridor is a lit shelf across the top of the frame.
        ty = h - 0.285
        B.box(hw-0.205, ty, dz0, hw-0.030, ty+0.014, dz1, MI['KIT_DARK'])
        B.box(hw-0.213, ty, dz0, hw-0.197, ty+0.058, dz1, MI['KIT_DARK'])
        for k in range(3):
            cyl_z(B, hw - 0.085 - k*0.048, ty + 0.032, dz0, dz1, 0.018,
                  MI['KIT_DARK'] if k != 1 else MI['KIT_ACCENT'], 8)
        for k in range(2):
            z = dz0 + L*(0.30 + 0.44*k)
            B.box(hw-0.050, ty-0.018, z-0.022, hw-0.010, ty+0.076, z+0.022, MI['KIT_DARK'])
            B.box(hw-0.205, ty+0.052, z-0.014, hw-0.040, ty+0.070, z+0.014, MI['KIT_RUBBER'])
    # ---- grab rail. Port only: a corridor with a handrail on both walls is a
    #      hospital, and the reflection was costing more than the second rail
    #      was worth. Starboard gets recessed hand-holds instead.
    if rail:
        cyl_z(B, -(hw-0.105), 1.12, dz0, dz1, 0.028, MI['KIT_RAIL'], 10)
        for k in range(2):
            z = dz0 + L*(0.22 + 0.56*k)
            B.box(-(hw-0.055), 1.09, z-0.028, -(hw-0.085), 1.15, z+0.028, MI['KIT_DARK'])
        for k in range(2):
            z = dz0 + L*(0.28 + 0.44*k)
            B.box(hw-0.062, 1.28, z-0.075, hw-0.012, 1.40, z+0.075, MI['KIT_DARK'])
            B.box(hw-0.052, 1.305, z-0.058, hw-0.022, 1.375, z+0.058, MI['KIT_RAIL'])
    return B.obj(name)
