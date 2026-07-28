# =============================================================================
#  The cockpit.
#
#  The most-looked-at space in the game: the player spawns behind it and flies
#  from it. Everything here is laid out against one datum -- the seated eye at
#  (0, 1.34, -5.26) -- because in a cockpit every surface is either something
#  you look *at* or something you have to see *past*, and the difference is a
#  few degrees.
#
#  Sight lines that the geometry below is built to respect:
#
#    · the coaming crown sits at y 1.13 at z -6.2, which is 12 degrees below
#      the eye horizon. Anything higher starts eating canopy.
#    · the screen bays are raked -0.60 rad and sit 14 to 31 degrees below the
#      horizon, close enough to read at a glance.
#    · the side consoles are allowed to rise higher than the centre, because
#      off-axis the canopy is already tapering away.
#
#  Modelled in absolute cockpit coordinates and exported with the object
#  transform zeroed, so the game places each piece at the origin.
# =============================================================================

# Hull stations forward of the corridor bulkhead: z, half width, height,
# corner radius, waist (where hull becomes glass).
#
# The waist is where hull stops and glass starts, and it was carrying 12 cm of
# solid tub across the two forward stations for no reason: the lower corners of
# the windscreen were plate. Dropped, the aperture opens downward exactly where
# the eye looks when the ship is manoeuvring.
NOSE = [
    (-3.40, 2.05, 2.55, 0.55, 1.34),
    (-5.25, 1.97, 2.44, 0.57, 1.20),
    (-6.45, 1.78, 2.10, 0.60, 1.02),
    (-7.60, 1.24, 1.62, 0.52, 0.88),
]
EYE = (0.0, 1.34, -5.26)


def nose_at(z):
    """Linear interpolation of the hull section at any z in the cockpit."""
    if z >= NOSE[0][0]:
        return NOSE[0][1:]
    if z <= NOSE[-1][0]:
        return NOSE[-1][1:]
    for a, b in zip(NOSE, NOSE[1:]):
        if b[0] <= z <= a[0]:
            t = (a[0] - z) / (a[0] - b[0])
            return tuple(a[1 + i] + (b[1 + i] - a[1 + i]) * t for i in range(4))
    return NOSE[0][1:]


def tub_profile(hw, h, r, waist, seg=7):
    """Lower half of the section: one waist corner, round the floor, back up."""
    p = [(hw, waist)]
    for i in range(seg + 1):
        a = -(math.pi / 2) * (i / seg)
        p.append((hw - r + math.cos(a) * r, r + math.sin(a) * r))
    for i in range(seg + 1):
        a = -math.pi / 2 - (math.pi / 2) * (i / seg)
        p.append((-hw + r + math.cos(a) * r, r + math.sin(a) * r))
    p.append((-hw, waist))
    return p


def roof_profile(hw, h, r, waist, seg=7):
    p = [(hw, waist)]
    for i in range(seg + 1):
        a = (math.pi / 2) * (i / seg)
        p.append((hw - r + math.cos(a) * r, h - r + math.sin(a) * r))
    for i in range(seg + 1):
        a = math.pi / 2 + (math.pi / 2) * (i / seg)
        p.append((-hw + r + math.cos(a) * r, h - r + math.sin(a) * r))
    p.append((-hw, waist))
    return p


def rotXY(rx, ry):
    """three's Euler order is XYZ, which composes as Rx.Ry when rz is zero."""
    a, b = math.cos(rx), math.sin(rx)
    c, d = math.cos(ry), math.sin(ry)
    return ((c, 0.0, d), (b * d, a, -b * c), (-a * d, b, a * c))


def local_to_world(M, origin, p):
    return (origin[0] + M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2],
            origin[1] + M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2],
            origin[2] + M[2][0] * p[0] + M[2][1] * p[1] + M[2][2] * p[2])


def panel_box(B, origin, M, u0, v0, u1, v1, n0, n1, mat):
    """An axis-aligned box in some panel's local frame, placed into world."""
    pts = [(u, v, n) for n in (n0, n1) for (u, v) in
           ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]
    w = [local_to_world(M, origin, p) for p in pts]
    F = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
         (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    for f in F:
        B.face([w[i] for i in f], mat)


def screen_bay(B, w, h, x, y, z, rx, ry, ou0, ov0, ou1, ov1,
               gap=0.012, back=0.042, face=0.024, lip=0.013):
    """A machined home for one of the live canvases.

       The screens are drawn by Cockpit.js and carry real game state, so they
       are not touched -- what they were missing is a recess to sit in. The
       first attempt built the fascia as a slab *behind* the canvas and hung a
       hood over it, and the hood promptly cut across the top third of every
       display: a panel raked back 0.6 rad has its top edge 20 cm forward of
       its centre, and anything built to a z that looks clear from the side is
       not clear at all.

       So the fascia is built in the panel's own frame with a genuine opening
       cut in it -- four rectangles around the hole -- and the canvas sits
       24 mm behind its front face, walled on all four sides and backed. A lit
       panel in a recess reads as an instrument; the same panel on a flat slab
       reads as a sticker."""
    M = rotXY(rx, ry)
    o = (x, y, z)
    ow, oh = w * 0.5 + gap, h * 0.5 + gap
    DK, RAIL = MI['KIT_DARK'], MI['KIT_RAIL']
    HULL = MI['KIT_HULL']
    # fascia, as four rectangles around the opening
    for (a, b, c, d) in ((ou0, ov0, ou1, -oh), (ou0, oh, ou1, ov1),
                         (ou0, -oh, -ow, oh), (ow, -oh, ou1, oh)):
        if c > a and d > b:
            panel_box(B, o, M, a, b, c, d, face - 0.026, face, DK)
    # walls of the opening, and the back plate the canvas floats in front of
    panel_box(B, o, M, -ow, -oh, -ow + 0.010, oh, -back, face, DK)
    panel_box(B, o, M, ow - 0.010, -oh, ow, oh, -back, face, DK)
    panel_box(B, o, M, -ow, -oh, ow, -oh + 0.010, -back, face, DK)
    panel_box(B, o, M, -ow, oh - 0.010, ow, oh, -back, face, DK)
    panel_box(B, o, M, -ow, -oh, ow, oh, -back, -back + 0.012, DK)
    # bezel standing proud of the fascia
    for (a, b, c, d) in ((-ow - 0.020, -oh - 0.020, ow + 0.020, -oh + 0.004),
                         (-ow - 0.020, oh - 0.004, ow + 0.020, oh + 0.020),
                         (-ow - 0.020, -oh - 0.020, -ow + 0.004, oh + 0.020),
                         (ow - 0.004, -oh - 0.020, ow + 0.020, oh + 0.020)):
        panel_box(B, o, M, a, b, c, d, face, face + lip, DK)
    for su in (-1, 1):
        for sv in (-1, 1):
            panel_box(B, o, M, su * (ow + 0.008) - 0.008, sv * (oh + 0.008) - 0.008,
                      su * (ow + 0.008) + 0.008, sv * (oh + 0.008) + 0.008,
                      face + lip, face + lip + 0.006, RAIL)
    return M, o


def switch_block(B, o, M, u, v, cols, rows, pitch=0.052, mat=None):
    """A bank of physical switches sunk into a fascia."""
    DK, RAIL, AC = MI['KIT_DARK'], MI['KIT_RAIL'], MI['KIT_ACCENT']
    hw = cols * pitch * 0.5
    hh = rows * pitch * 0.5
    panel_box(B, o, M, u - hw - 0.010, v - hh - 0.010, u + hw + 0.010, v + hh + 0.010,
              0.024, 0.032, DK)
    for c in range(cols):
        for r in range(rows):
            cu = u - hw + pitch * (c + 0.5)
            cv = v - hh + pitch * (r + 0.5)
            panel_box(B, o, M, cu - pitch * 0.34, cv - pitch * 0.34,
                      cu + pitch * 0.34, cv + pitch * 0.34, 0.032, 0.040,
                      mat or (AC if (c + r) % 5 == 0 else DK))
            panel_box(B, o, M, cu - pitch * 0.16, cv - pitch * 0.10,
                      cu + pitch * 0.16, cv + pitch * 0.26, 0.040, 0.050, RAIL)


# ------------------------------------------------------- lofted, curved parts
#
#  Everything above this line is boxes, which is right for a console: a cockpit
#  is made of plate. Two things in it are not, and both are within 0.6 m of the
#  lens -- the sidestick grip and the throttle knobs are the only objects in the
#  ship a hand actually closes around, and a hand grip built out of stacked
#  boxes reads as a radiator. (It did: eight 11 mm segments produced a visible
#  step at every joint and the whole assembly measured as a stack of plates.)
#  So those get a real swept section.

def _newell(pts):
    nx = ny = nz = 0.0
    n = len(pts)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        nx += (a[1] - b[1]) * (a[2] + b[2])
        ny += (a[2] - b[2]) * (a[0] + b[0])
        nz += (a[0] - b[0]) * (a[1] + b[1])
    return nx, ny, nz


def face_dir(B, pts, want, mat):
    """One face, wound so its normal points along `want`.

       face_out() is the right tool when there is a point known to be inside
       the solid. There is not, for a thin shell that curves through more than
       its own thickness: the section's centroid then falls in the air on the
       concave side and every face on that side comes out inverted. When the
       surface's facing is known by construction, say it."""
    nx, ny, nz = _newell(pts)
    d = nx * want[0] + ny * want[1] + nz * want[2]
    B.face(list(pts) if d >= 0 else list(pts)[::-1], mat)


def face_out(B, pts, ref, mat):
    """One face, wound so its normal points away from `ref`.

       Winding is the failure in this file that produces *nothing* rather than
       something wrong: an inside-out face is backface-culled in the game and
       bakes as unoccluded in the AO pass, so it returns as a bright hole. For
       boxes B.box settles it; for a swept surface the cross product has to be
       reasoned about by hand, which has already cost this file three pieces.
       Deriving the winding from a point known to be inside the solid removes
       the whole class of mistake."""
    nx, ny, nz = _newell(pts)
    n = len(pts)
    d = ((sum(p[0] for p in pts) / n - ref[0]) * nx
         + (sum(p[1] for p in pts) / n - ref[1]) * ny
         + (sum(p[2] for p in pts) / n - ref[2]) * nz)
    B.face(list(pts) if d >= 0 else list(pts)[::-1], mat)


def sect(cx, y, cz, w, d, k=2.6, seg=12, shape=None):
    """One station of a swept form: a superellipse in the XZ plane at height y.

       k = 2 is an ellipse and k large is a rectangle. A hand grip is near 2.6
       -- rounded, but with flats where the fingers wrap and the heel of the
       palm sits.

       `shape(angle) -> multiplier` is what turns a swept tube into a moulded
       part: it modulates the radius *around* the section, so a finger scallop
       is a dent in the form rather than a pad glued to the outside of it, and
       a knurl is a real ripple in the silhouette."""
    p = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        ca, sa = math.cos(a), math.sin(a)
        m = shape(a) if shape else 1.0
        p.append((cx + math.copysign(abs(ca) ** (2.0 / k), ca) * w * m, y,
                  cz + math.copysign(abs(sa) ** (2.0 / k), sa) * d * m))
    return p


def loft(B, rings, mat, cap0=True, cap1=True, skip=None):
    """Skin a stack of equal-length rings, every face wound outward.

       `skip(a, b) -> bool` drops the strip between two section points. A swept
       section is a *closed* tube, so a console body built this way arrives
       with a lid on it -- which is how the pedestal's radar well came back
       filled in with a solid plate across the top and the tactical hologram
       vanished behind it. The old box call said skip=('yp',) for exactly this
       reason and the sweep has to say the same thing."""
    tot = sum(len(r) for r in rings)
    ref = (sum(p[0] for r in rings for p in r) / tot,
           sum(p[1] for r in rings for p in r) / tot,
           sum(p[2] for r in rings for p in r) / tot)
    n = len(rings[0])
    for A, C in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            if skip and skip(A[i], A[j]):
                continue
            face_out(B, [A[i], A[j], C[j], C[i]], ref, mat)
    if cap0:
        face_out(B, rings[0], ref, mat)
    if cap1:
        face_out(B, rings[-1], ref, mat)


def sect_xy(cx, cy, z, w, h, k=2.6, seg=12, shape=None):
    """The same superellipse taken in the XY plane, for forms swept fore-aft:
       beams, armrests, consoles, fairings."""
    p = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        ca, sa = math.cos(a), math.sin(a)
        m = shape(a) if shape else 1.0
        p.append((cx + math.copysign(abs(ca) ** (2.0 / k), ca) * w * m,
                  cy + math.copysign(abs(sa) ** (2.0 / k), sa) * h * m, z))
    return p


def beam(B, stations, mat, seg=14, k=3.2, cap0=True, cap1=True, shape=None,
         skip=None):
    """Sweep a section along Z. `stations` are (z, cx, cy, w, h)."""
    loft(B, [sect_xy(cx, cy, z, w, h, k, seg, shape) for (z, cx, cy, w, h) in stations],
         mat, cap0=cap0, cap1=cap1, skip=skip)


def revolve(B, cx, cz, profile, mat, seg=16, shape=None, cap0=True, cap1=True):
    """Lathe a (radius, height) profile about a vertical axis at (cx, cz).

       This is the single most useful operation missing from this file. A knob,
       a boot, a collar, a dial bezel, a pivot housing and a fastener head are
       all one lathe each, and every one of them was a stack of boxes."""
    rings = [sect(cx, y, cz, r, r, 2.0, seg, shape) for (r, y) in profile]
    loft(B, rings, mat, cap0=cap0 and profile[0][0] > 1e-6,
         cap1=cap1 and profile[-1][0] > 1e-6)


def knurl(teeth, depth=0.055, phase=0.0):
    """A radius modulation for `sect`/`revolve`: a milled grip pattern.

       A rotary knob with a smooth cylinder for a body is a peg. The knurl is
       what says it is meant to be turned, and it costs nothing but segments."""
    return lambda a: 1.0 + depth * math.cos(teeth * (a + phase))


def scallops(n, depth, centre, width, phase=0.0):
    """Finger grooves cut into one side of a grip.

       `centre` is the angle the grooves are centred on and `width` how far
       round they reach, so the far side of the grip stays a clean palm swell.
       This is the difference between a grip and a rod: the form is dented by
       the hand, it does not have pads stuck on it."""
    def f(a):
        d = math.atan2(math.sin(a - centre), math.cos(a - centre))
        if abs(d) > width:
            return 1.0
        fall = 0.5 + 0.5 * math.cos(math.pi * d / width)
        return 1.0 - depth * fall * (0.5 + 0.5 * math.cos(n * math.pi * d / width))
    return f


def tube_section(B, stations, mat, seg=12, k=2.6, cap0=True, cap1=True):
    """Sweep a moving, resizing, reshaping section. `stations` are
       (y, cx, cz, w, d, shape)."""
    rings = [sect(cx, y, cz, w, d, k, seg, sh) for (y, cx, cz, w, d, sh) in stations]
    loft(B, rings, mat, cap0=cap0, cap1=cap1)


def rod(B, a, b, r0, r1, mat, seg=10, k=2.0, shape=None):
    """A tapered round rod between two points. Only ever near-vertical here, so
       the section is taken in XZ and the tilt comes from the centre moving."""
    rings = []
    for t in (0.0, 1.0):
        c = [a[i] + (b[i] - a[i]) * t for i in range(3)]
        r = r0 + (r1 - r0) * t
        rings.append(sect(c[0], c[1], c[2], r, r, k, seg, shape))
    loft(B, rings, mat)


def sweep_path(B, pts, radii, mat, seg=8, up=None):
    """Sweep a circular section along a polyline. Guards, grab handles, cable
       runs and bent tube -- anything whose axis is not a straight line.

       `up` must be given as the *plane normal* for any path that turns through
       more than a right angle. Choosing it per-station from the tangent flips
       it the moment the tangent passes vertical, and the section then rotates
       90 degrees between two rings: a trigger guard built that way came back
       looking like crumpled foil. With the normal supplied the frame is exact
       and constant, which is what a planar arc actually has."""
    n = len(pts)
    rings = []
    for i, p in enumerate(pts):
        a = pts[max(i - 1, 0)]
        b = pts[min(i + 1, n - 1)]
        t = [b[j] - a[j] for j in range(3)]
        L = math.sqrt(sum(v * v for v in t)) or 1.0
        t = [v / L for v in t]
        if up is not None:
            uv = up
        else:
            uv = (0.0, 1.0, 0.0) if abs(t[1]) < 0.92 else (1.0, 0.0, 0.0)
        u = (t[1] * uv[2] - t[2] * uv[1], t[2] * uv[0] - t[0] * uv[2],
             t[0] * uv[1] - t[1] * uv[0])
        L = math.sqrt(sum(v * v for v in u)) or 1.0
        u = [v / L for v in u]
        v = (t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2],
             t[0] * u[1] - t[1] * u[0])
        r = radii[i] if isinstance(radii, (list, tuple)) else radii
        rings.append([(p[0] + u[0] * math.cos(2 * math.pi * k / seg) * r
                       + v[0] * math.sin(2 * math.pi * k / seg) * r,
                       p[1] + u[1] * math.cos(2 * math.pi * k / seg) * r
                       + v[1] * math.sin(2 * math.pi * k / seg) * r,
                       p[2] + u[2] * math.cos(2 * math.pi * k / seg) * r
                       + v[2] * math.sin(2 * math.pi * k / seg) * r)
                      for k in range(seg)])
    loft(B, rings, mat)


def plate_slab(B, poly, y0, y1, mat, rolled=0.0):
    """A closed 2D polygon in XZ given thickness, with an optional rolled edge.

       The point is the *outline*: a plate whose plan view is a rectangle is a
       box however thin it is, and a plate whose plan view is a shaped outline
       reads as something that was cut for a purpose. `rolled` breaks the
       vertical wall into a chamfer-wall-chamfer so the edge catches light
       without waiting for the bevel modifier."""
    cz = (sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly))
    ref = (cz[0], (y0 + y1) * 0.5, cz[1])
    if rolled <= 0.0:
        levels = [(y0, 0.0), (y1, 0.0)]
    else:
        levels = [(y0, -rolled), (y0 + rolled, 0.0),
                  (y1 - rolled, 0.0), (y1, -rolled)]
    rings = []
    for (y, ins) in levels:
        r = []
        for (x, z) in poly:
            dx, dz = x - cz[0], z - cz[1]
            L = math.hypot(dx, dz) or 1.0
            r.append((x + dx / L * ins, y, z + dz / L * ins))
        rings.append(r)
    n = len(poly)
    for A, C in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            face_out(B, [A[i], A[j], C[j], C[i]], ref, mat)
    face_out(B, rings[0], ref, mat)
    face_out(B, rings[-1], ref, mat)


# ============================================================================
#  Lathes on any axis, sections that change along a run, and real switchgear.
#
#  Four pieces in this file stayed boxes long after the controls stopped being
#  boxes, and it was not for want of trying -- it was for want of these. The
#  vocabulary above can only turn a form about +Y (`revolve`) and can only
#  sweep a *constant* section (`beam`, `tube_section`). So:
#
#    · a bezel on a raked overhead face, a fastener on a canopy pillar and a
#      vent in the coaming's aft face had no way to be round, and became boxes;
#    · a coaming, an A-pillar, a knee bolster and a tub wall are all one closed
#      section that changes shape along its run, and every one of them was a
#      ribbon of quads with no section at all.
#
#  `lathe` and `sweep_profile` are those two operations. Everything below them
#  is built out of the two, and the switchgear factories exist because a switch
#  is the unit of detail on this ship: 96 extruded rectangles on the overhead
#  read as a coffered ceiling tile, and the same 96 positions filled with four
#  *families* of real hardware read as a panel somebody certified.
# ============================================================================

def arc2(cx, cy, r, a0, a1, n, rx=1.0, ry=1.0):
    """An arc as (x, y) pairs. Angles from +x, counter-clockwise toward +y."""
    if n < 2:
        return [(cx + math.cos(a0) * r * rx, cy + math.sin(a0) * r * ry)]
    return [(cx + math.cos(a0 + (a1 - a0) * i / (n - 1)) * r * rx,
             cy + math.sin(a0 + (a1 - a0) * i / (n - 1)) * r * ry)
            for i in range(n)]


def rrect(w, h, r, n=4):
    """A rounded rectangle, corners resolved as arcs.

       The difference between a pad and a box, and it is the whole difference:
       a rectangle with four infinitely sharp corners is the one silhouette the
       eye reads as untouched primitive however well it is lit."""
    r = min(r, w * 0.49, h * 0.49)
    p = []
    for (cx, cy, a0) in ((w - r, h - r, 0.0), (-(w - r), h - r, math.pi / 2),
                         (-(w - r), -(h - r), math.pi), (w - r, -(h - r), 1.5 * math.pi)):
        p += arc2(cx, cy, r, a0, a0 + math.pi / 2, n)
    return p


def _frame(axis, ref=None):
    """Orthonormal (u, v, w) with w along `axis`, u biased toward `ref`."""
    L = math.sqrt(sum(c * c for c in axis)) or 1.0
    w = [c / L for c in axis]
    r = list(ref) if ref else ((0.0, 1.0, 0.0) if abs(w[1]) < 0.92 else (1.0, 0.0, 0.0))
    d = sum(r[i] * w[i] for i in range(3))
    u = [r[i] - w[i] * d for i in range(3)]
    L = math.sqrt(sum(c * c for c in u))
    if L < 1e-9:
        r = (1.0, 0.0, 0.0) if abs(w[0]) < 0.92 else (0.0, 0.0, 1.0)
        d = sum(r[i] * w[i] for i in range(3))
        u = [r[i] - w[i] * d for i in range(3)]
        L = math.sqrt(sum(c * c for c in u))
    u = [c / L for c in u]
    v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]]
    return u, v, w


def loft2(B, rings, mat, cap0=True, cap1=True, skip=None):
    """loft(), but each face is wound against its *local* ring centroid.

       loft() references the centroid of the whole stack, which is right for a
       straight tube and wrong for anything that curves through more than a few
       degrees: on a coaming that turns 40 degrees in plan the global centroid
       leaves the solid entirely and half the skin comes back inside-out --
       which is the failure that renders as nothing at all, because an
       inside-out face is backface-culled in the game and bakes as unoccluded."""
    cen = [(sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r),
            sum(p[2] for p in r) / len(r)) for r in rings]
    n = len(rings[0])
    for k in range(len(rings) - 1):
        A, C = rings[k], rings[k + 1]
        ref = tuple((cen[k][j] + cen[k + 1][j]) * 0.5 for j in range(3))
        for i in range(n):
            j = (i + 1) % n
            if skip and skip(A[i], A[j]):
                continue
            face_out(B, [A[i], A[j], C[j], C[i]], ref, mat)
    if cap0:
        cap_fan(B, rings[0], mat, cen[1] if len(rings) > 1 else cen[0])
    if cap1:
        cap_fan(B, rings[-1], mat, cen[-2] if len(rings) > 1 else cen[-1])


def cap_fan(B, ring, mat, ref):
    """Close a section with a triangle fan from its own centroid.

       B.face() on a concave n-gon leaves the triangulation to Blender, and for
       a section with an undercut in it -- which every section worth having in
       this file has -- that can come back as overlapping triangles. A fan is
       correct for any star-shaped profile."""
    n = len(ring)
    c = (sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n,
         sum(p[2] for p in ring) / n)
    for i in range(n):
        face_out(B, [c, ring[i], ring[(i + 1) % n]], ref, mat)


def lathe(B, origin, axis, profile, mat, seg=16, shape=None, ref=None,
          cap0=True, cap1=True):
    """Revolve a (radius, distance-along-axis) profile about an arbitrary axis.

       `revolve` only turns about +Y. Every knob, bezel, fastener, breaker,
       gauge and vent on a surface that is not horizontal therefore had no way
       to be round, and the overhead panel, the canopy and the tactical bezel
       are all made of what happened instead."""
    u, v, w = _frame(axis, ref)
    rings = []
    for (r, t) in profile:
        ring = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            rr = r * (shape(a) if shape else 1.0)
            ca, sa = math.cos(a) * rr, math.sin(a) * rr
            ring.append((origin[0] + u[0] * ca + v[0] * sa + w[0] * t,
                         origin[1] + u[1] * ca + v[1] * sa + w[1] * t,
                         origin[2] + u[2] * ca + v[2] * sa + w[2] * t))
        rings.append(ring)
    loft2(B, rings, mat, cap0=cap0 and profile[0][0] > 1e-6,
          cap1=cap1 and profile[-1][0] > 1e-6)


def sweep_profile(B, path, sections, mat, up=(0.0, 1.0, 0.0),
                  cap0=True, cap1=True):
    """Sweep a *closed section that changes shape* along a polyline.

       The section is taken in the plane of `up` and the path normal, so for a
       run that goes left-right the section's first coordinate is fore-aft and
       its second is height; for a hoop in the XY plane, pass up = +Z and the
       first coordinate becomes radial. `up` is fixed rather than derived from
       the tangent, for the same reason sweep_path takes an explicit plane
       normal: a frame chosen per station flips the moment the tangent passes
       the up vector and the section rotates 90 degrees between two rings. It
       may be given per station instead, which is what a member following a
       curved hull needs -- a canopy rail climbing 60 degrees round a shoulder
       wants its section square to the *skin* at every point, and one fixed up
       has it lying flat at one end and on edge at the other.

       This is the operation the four box-derived pieces were missing. A form
       whose section is the same at both ends is an extrusion, and an extrusion
       of anything reads as trim; a form whose section grows a flange at the
       root, loses it mid-span and closes to a blade at the tip reads as a part
       that carries a load."""
    n = len(path)
    rings = []
    per = isinstance(up[0], (list, tuple))
    for i, p in enumerate(path):
        a = path[max(i - 1, 0)]
        b = path[min(i + 1, n - 1)]
        t = [b[j] - a[j] for j in range(3)]
        L = math.sqrt(sum(c * c for c in t)) or 1.0
        t = [c / L for c in t]
        m = list(up[i]) if per else list(up)
        s = [m[1] * t[2] - m[2] * t[1], m[2] * t[0] - m[0] * t[2],
             m[0] * t[1] - m[1] * t[0]]
        L = math.sqrt(sum(c * c for c in s)) or 1.0
        s = [c / L for c in s]
        rings.append([(p[0] + s[0] * ca + m[0] * cb,
                       p[1] + s[1] * ca + m[1] * cb,
                       p[2] + s[2] * ca + m[2] * cb)
                      for (ca, cb) in sections[i]])
    loft2(B, rings, mat, cap0=cap0, cap1=cap1)
    return rings


def pad(B, ctr, axis, w, h, d, mat, r=0.006, taper=0.88, up=None, seg=4):
    """A raised pad with rounded corners and a drafted wall, on any face.

       Placards, name plates, data plates and mounting bosses are all one of
       these. Every one of them in this file was an extruded rectangle, which
       is the single most common way a modelled surface reverts to a primitive:
       the form is right, the outline is a rectangle, and the rectangle is what
       the eye reads."""
    u, v, wv = _frame(axis, up)
    rings = []
    for (t, s) in ((0.0, 1.0), (d * 0.34, 0.985), (d, taper)):
        rings.append([tuple(ctr[j] + u[j] * a * s + v[j] * b * s + wv[j] * t
                            for j in range(3))
                      for (a, b) in rrect(w, h, r, seg)])
    loft2(B, rings, mat, cap0=True, cap1=True)


def recess(B, ctr, axis, w, h, d, mat, r=0.010, draft=0.90, up=None, seg=4):
    """The inverse: a bay sunk into a face, with drafted walls and a floor.

       A recess with vertical walls and a flat floor is a rectangle inside a
       rectangle. Drafting the walls gives the bay a lit inner face on one side
       and a dark one on the other, which is what makes it read as depth rather
       than as a darker rectangle painted on."""
    u, v, wv = _frame(axis, up)
    rings = []
    for (t, s) in ((0.0, 1.0), (-d * 0.18, 0.985), (-d, draft), (-d, draft * 0.02)):
        rings.append([tuple(ctr[j] + u[j] * a * s + v[j] * b * s + wv[j] * t
                            for j in range(3))
                      for (a, b) in rrect(w, h, r, seg)])
    loft2(B, rings, mat, cap0=False, cap1=False)


# ------------------------------------------------------------- switch hardware
#
#  Four families, because real panels have four families and a panel with one
#  family is a grid. Every one of these is a lathe or a sweep; none of them is
#  a box. They take an axis, so they sit on a raked overhead, a canted console
#  cheek or a vertical bulkhead without changing.

def toggle(B, ctr, axis, mat_body, mat_bat, mat_ring, up=None, s=1.0,
           lean=0.0, bat=0.030):
    """A bat-handle toggle: hex bezel, locking ring, and a lathed bat.

       `lean` throws the bat off the switch axis, which is the entire read --
       a rank of toggles all at the same angle is a texture, a rank in which
       three are up and the rest down is a machine in a state."""
    u, v, w = _frame(axis, up)
    lathe(B, ctr, axis, [(0.0, -0.002 * s), (0.0125 * s, -0.002 * s),
                         (0.0132 * s, 0.0035 * s), (0.0118 * s, 0.0062 * s)],
          mat_body, 6, ref=up)
    lathe(B, ctr, axis, [(0.0088 * s, 0.0055 * s), (0.0096 * s, 0.0082 * s),
                         (0.0080 * s, 0.0102 * s)], mat_ring, 22,
          knurl(10, 0.055), ref=up)
    tip = [ctr[j] + w[j] * math.cos(lean) * bat * s
           + u[j] * math.sin(lean) * bat * s for j in range(3)]
    axb = [tip[j] - ctr[j] for j in range(3)]
    lathe(B, [ctr[j] + axb[j] * 0.20 for j in range(3)], axb,
          [(0.0044 * s, 0.0), (0.0030 * s, 0.60 * bat * s),
           (0.0052 * s, 0.74 * bat * s), (0.0056 * s, 0.80 * bat * s),
           (0.0022 * s, 0.84 * bat * s)], mat_bat, 10, ref=up)


def guard_cage(B, ctr, axis, w, h, mat, up=None, s=1.0):
    """A wire cage over a switch: two swept bows and a cross tie.

       A guard drawn as two boxes is the single feature that makes a panel look
       printed. It is three swept tubes and it costs nothing."""
    u, v, wv = _frame(axis, up)
    def P(a, b, c):
        return tuple(ctr[j] + u[j] * a + v[j] * b + wv[j] * c for j in range(3))
    nrm = tuple(v)
    for sb in (-1, 1):
        sweep_path(B, [P(-w, sb * h, 0.0), P(-w * 0.80, sb * h, h * 1.25),
                       P(0.0, sb * h * 0.94, h * 1.62), P(w * 0.80, sb * h, h * 1.25),
                       P(w, sb * h, 0.0)],
                   0.0026 * s, mat, 6, up=nrm)
    sweep_path(B, [P(-w * 0.34, -h, h * 1.42), P(-w * 0.34, h, h * 1.42)],
               0.0024 * s, mat, 5, up=tuple(wv))
    sweep_path(B, [P(w * 0.34, -h, h * 1.42), P(w * 0.34, h, h * 1.42)],
               0.0024 * s, mat, 5, up=tuple(wv))


def flip_cover(B, ctr, axis, w, h, mat, mat_pin, up=None, ang=0.55):
    """A hinged flip-cover standing open at `ang`, on a real hinge barrel.

       Standing open is the point. Flat shut it is a pad; open it throws a hard
       diagonal against the panel and casts the only moving shadow up there."""
    u, v, wv = _frame(axis, up)
    def P(a, b, c):
        return tuple(ctr[j] + u[j] * a + v[j] * b + wv[j] * c for j in range(3))
    lathe(B, P(0.0, -h, 0.004), tuple(u), [(0.0, -w * 0.9), (0.0034, -w * 0.9),
                                           (0.0034, w * 0.9), (0.0, w * 0.9)],
          mat_pin, 10, ref=tuple(wv))
    ca, sa = math.cos(ang), math.sin(ang)
    rings = []
    for (dn, sc) in ((0.0, 1.0), (0.0026, 0.94)):
        r = []
        for (a, b) in rrect(w, h, min(w, h) * 0.34, 4):
            bb = (b + h) * sc                      # 0 at the hinge
            r.append(P(a * sc, -h + bb * ca, 0.004 + bb * sa + dn))
        rings.append(r)
    loft2(B, rings, mat, cap0=True, cap1=True)


def rotary(B, ctr, axis, mat_body, mat_knob, mat_mark, up=None, s=1.0, ang=0.0):
    """A knurled rotary with a moulded pointer skirt and a detent arc."""
    u, v, w = _frame(axis, up)
    lathe(B, ctr, axis, [(0.0, -0.001 * s), (0.026 * s, -0.001 * s),
                         (0.027 * s, 0.004 * s), (0.024 * s, 0.007 * s)],
          mat_body, 14, ref=up)
    lathe(B, ctr, axis, [(0.0, 0.006 * s), (0.017 * s, 0.006 * s),
                         (0.019 * s, 0.010 * s), (0.0185 * s, 0.024 * s),
                         (0.015 * s, 0.029 * s), (0.008 * s, 0.031 * s)],
          mat_knob, 28, knurl(14, 0.055), ref=up)
    # the pointer: a lug on the skirt, not a painted line
    p = [ctr[j] + u[j] * math.cos(ang) * 0.019 * s
         + v[j] * math.sin(ang) * 0.019 * s + w[j] * 0.012 * s for j in range(3)]
    lathe(B, p, axis, [(0.0055 * s, -0.006 * s), (0.0055 * s, 0.010 * s),
                       (0.0030 * s, 0.014 * s)], mat_mark, 8, ref=up)
    for k in range(5):                              # detent arc, in relief
        a = -1.15 + k * 0.575
        q = [ctr[j] + u[j] * math.cos(a) * 0.0325 * s + v[j] * math.sin(a) * 0.0325 * s
             + w[j] * 0.0005 * s for j in range(3)]
        lathe(B, q, axis, [(0.0026 * s, 0.0), (0.0026 * s, 0.0028 * s),
                           (0.0014 * s, 0.0040 * s)], mat_mark, 6, ref=up)


def breaker(B, ctr, axis, mat_body, mat_rock, mat_band, up=None, s=1.0,
            tripped=False):
    """A circuit breaker: a sunk can, a rocker, and a white trip band.

       Real depth means the can is *in* the panel and the rocker stands out of
       it at an angle. Flush, at one height, in a grid, it is a tile."""
    u, v, w = _frame(axis, up)
    lathe(B, ctr, axis, [(0.0132 * s, -0.020 * s), (0.0132 * s, -0.002 * s),
                         (0.0148 * s, 0.001 * s), (0.0148 * s, 0.005 * s),
                         (0.0122 * s, 0.008 * s)], mat_body, 10, ref=up,
          cap0=False)
    ca = math.cos(0.34 if tripped else -0.26)
    sa = math.sin(0.34 if tripped else -0.26)
    rings = []
    for (t, sc) in ((0.0, 1.0), (0.0165 * s, 0.80)):
        r = []
        for (a, b) in rrect(0.0086 * s, 0.0056 * s, 0.0022 * s, 3):
            r.append(tuple(ctr[j] + u[j] * a + v[j] * (b * ca - t * sa)
                           + w[j] * (0.006 * s + b * sa + t * ca) for j in range(3)))
        rings.append(r)
    loft2(B, rings, mat_rock, cap0=True, cap1=True)
    if tripped:
        lathe(B, ctr, axis, [(0.0122 * s, 0.0078 * s), (0.0122 * s, 0.0106 * s),
                             (0.0104 * s, 0.0122 * s)], mat_band, 12, ref=up,
              cap0=False, cap1=False)


def gauge(B, ctr, axis, r, mat_bezel, mat_face, mat_needle, up=None, ang=-0.7):
    """A round instrument: a lathed bezel with a rolled lip, a sunk dial, tick
       marks in relief and a needle standing off the face."""
    u, v, w = _frame(axis, up)
    lathe(B, ctr, axis, [(r * 0.74, -0.012), (r, -0.010), (r * 1.06, -0.004),
                         (r * 1.05, 0.008), (r * 0.96, 0.014), (r * 0.90, 0.011)],
          mat_bezel, 18, ref=up, cap0=False, cap1=False)
    lathe(B, ctr, axis, [(0.0, -0.011), (r * 0.92, -0.011), (r * 0.92, -0.008)],
          mat_face, 18, ref=up, cap1=False)
    for k in range(8):
        a = 2 * math.pi * k / 8
        q = [ctr[j] + u[j] * math.cos(a) * r * 0.80 + v[j] * math.sin(a) * r * 0.80
             + w[j] * -0.0095 for j in range(3)]
        lathe(B, q, axis, [(r * (0.075 if k % 3 == 0 else 0.045), 0.0),
                           (r * (0.060 if k % 3 == 0 else 0.035), 0.0026)],
              mat_needle, 5, ref=up)
    nt = [ctr[j] + u[j] * math.cos(ang) * r * 0.70 + v[j] * math.sin(ang) * r * 0.70
          for j in range(3)]
    sweep_path(B, [tuple(ctr[j] + w[j] * -0.0075 for j in range(3)),
                   tuple(nt[j] + w[j] * -0.0075 for j in range(3))],
               [r * 0.10, r * 0.030], mat_needle, 6, up=tuple(w))


def hexbolt(B, ctr, axis, r, mat, up=None, h=None):
    """A hex-head fastener with a washer face. The scale-three detail that says
       a part was assembled rather than printed."""
    h = h if h is not None else r * 0.72
    lathe(B, ctr, axis, [(0.0, -0.001), (r * 1.42, -0.001), (r * 1.42, 0.0016)],
          mat, 10, ref=up)
    lathe(B, ctr, axis, [(0.0, 0.0016), (r, 0.0016), (r, h * 0.78),
                         (r * 0.86, h)], mat, 6, ref=up)


# ------------------------------------------------------------------- the tub
def cockpit_tub(name='cp_tub', deckY=0.08):
    """The enclosure: hull skin, floor pan, coving, kick panels, ribs and the
       side console bodies.

       What was here was a smooth shell, one perfectly flat plane for a floor,
       and two open sheets of quads for the consoles -- from the front you
       could see they were paper. Everything below is a closed lofted section
       whose shape changes with the hull's taper:

         · the pan turns up into a 105 mm coving fillet where it meets the
           wall, instead of the single flat chamfer quad that was there. A
           cove is the one detail that says a floor was *installed* rather
           than drawn, and it is also where every real ship puts its drains.
         · kick panels stand off the wall with recessed bays in them.
         · the floor carries a raised centre tread strip, seat rails, an
           inspection hatch with a flush latch and a toe board.
         · the consoles are solid bodies with a rolled inboard edge and a
           coved skirt down to the deck."""
    B = Build()
    ZS = [-3.40, -3.70, -4.10, -4.55, -5.00, -5.45, -5.90, -6.35, -6.80, -7.20, -7.58]
    HULL, DK, AC, DECK, RAIL = (MI['KIT_HULL'], MI['KIT_DARK'], MI['KIT_ACCENT'],
                                MI['KIT_DECK'], MI['KIT_RAIL'])
    RUB = MI['KIT_RUBBER']

    # ---- skin below the waist, stepped in and out so it is not one smooth
    #      shell. Bays between the frames, frames proud.
    rings = []
    for z in ZS:
        hw, h, r, waist = nose_at(z)
        frame = (abs(z + 5.45) < 0.01 or abs(z + 4.10) < 0.01
                 or abs(z + 6.80) < 0.01 or abs(z + 3.40) < 0.01)
        off = 0.0 if frame else 0.040
        prof = tub_profile(hw + off, h, r, waist)
        rings.append([(px, py, z) for (px, py) in prof])
    for k in range(len(rings) - 1):
        A, Bp = rings[k], rings[k + 1]
        for i in range(len(A) - 1):
            B.quad(A[i + 1], A[i], Bp[i], Bp[i + 1], HULL)

    # ---- the floor pan. One closed section swept the length of the tub, and
    #      it is where the coving lives.
    def tub_x(z, y):
        """Half-width of the hull at height y. The pan and everything bolted to
           it has to follow *this*, not the section's maximum half-width: at
           deck level the corner radius has already drawn the wall in by 0.28 m
           and a kick panel placed at hw stands outside the ship."""
        hw, h, r, waist = nose_at(z)
        if y >= r:
            return hw
        t = (y - r) / r
        return hw - r + math.sqrt(max(0.0, 1.0 - t * t)) * r

    KT = deckY + 0.30
    CR = 0.100
    # The pan's walking run sits 12 mm *below* the deck datum and the plates
    # laid on it make the datum back up. See the plate block below for why.
    SUB = deckY - 0.012
    PZ = [-3.44 + (-7.54 + 3.44) * i / 20 for i in range(21)]
    ppath, psect = [], []
    for z in PZ:
        Xt = tub_x(z, KT + 0.032) - 0.012
        Xk = tub_x(z, KT) - 0.012
        Xw = tub_x(z, deckY + CR) - 0.012
        # a true quarter-round, tangent to the floor and tangent to the wall
        cove = []
        for i in range(5):
            ang = -math.pi * 0.5 * (i / 4.0)
            cove.append((Xw - CR + math.cos(ang) * CR, SUB + CR + math.sin(ang) * CR))
        half = ([(Xt, KT + 0.036), (Xt - 0.030, KT + 0.036), (Xk - 0.028, KT),
                 (Xk - 0.006, KT - 0.018)] + cove)
        inner = ([(-a, b) for (a, b) in half]
                 + [(-0.46, SUB), (-0.43, deckY + 0.016), (0.43, deckY + 0.016),
                    (0.46, SUB)]
                 + [(a, b) for (a, b) in half[::-1]])
        outer = [(Xt + 0.014, KT + 0.036), (Xt + 0.014, deckY - 0.030),
                 (-(Xt + 0.014), deckY - 0.030), (-(Xt + 0.014), KT + 0.036)]
        ppath.append((0.0, 0.0, z))
        psect.append([(-a, b) for (a, b) in inner + outer])
    sweep_profile(B, ppath, psect, DECK)

    # ---- the walking surface, as real plates.
    #
    #      The cockpit deck was the last surface in the ship whose plating was
    #      painted. Every kit bay lays its floor as six plates with a 26 mm
    #      groove between them and a countersunk fastener at each corner; the
    #      cockpit had one lofted sheet with the plate joins, the tread and the
    #      rivets all in the tile map, so the floor visibly changed character at
    #      the bulkhead -- relief one side of the threshold and a picture of
    #      relief on the other. It is also the surface the player looks straight
    #      down at for the whole walk to the helm.
    #
    #      Two courses each side of the centre strip, six bands fore-and-aft on
    #      the frame pitch, and every plate tapers with the section: the floor
    #      closes from 1.80 m half-width at the bulkhead to 1.00 m at the nose
    #      ring, so a rectangular plate would hang over the cove at the front
    #      and leave a gap at the back.
    ZB = [-3.46, -4.10, -4.80, -5.45, -6.20, -6.86]
    GAP = 0.013

    def floor_x(z):
        return tub_x(z, deckY + CR) - 0.012 - CR - 0.004

    def on_hatch(x, z):
        return 0.40 < x < 0.84 and -5.47 < z < -5.13

    for b in range(len(ZB) - 1):
        z0, z1 = ZB[b], ZB[b + 1]
        for sx in (-1, 1):
            # inboard edge is the centre strip, outboard edge is the cove
            e0, e1 = floor_x(z0), floor_x(z1)
            cols = [(0.462, 0.462 + (e0 - 0.462) * 0.52, 0.462,
                     0.462 + (e1 - 0.462) * 0.52),
                    (0.462 + (e0 - 0.462) * 0.52, e0,
                     0.462 + (e1 - 0.462) * 0.52, e1)]
            for (a0, b0, a1, b1) in cols:
                # 4 mm clear of the pan sheet: a plate whose underside is
                # exactly coplanar with what it is laid on is a z-fight
                back = [(sx * (a0 + GAP), SUB - 0.004, z0 + GAP),
                        (sx * (b0 - GAP), SUB - 0.004, z0 + GAP),
                        (sx * (b1 - GAP), SUB - 0.004, z1 - GAP),
                        (sx * (a1 + GAP), SUB - 0.004, z1 - GAP)]
                front = [(p[0], deckY, p[2]) for p in back]
                slab(B, back, front, DECK)
                for (u, v) in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
                    fz = (z0 + GAP + 0.052) if v > 0 else (z1 - GAP - 0.052)
                    t = (fz - z0) / (z1 - z0)
                    lo = a0 + (a1 - a0) * t
                    hi = b0 + (b1 - b0) * t
                    fx = sx * ((lo + 0.052) if u > 0 else (hi - 0.052))
                    if on_hatch(fx, fz):
                        continue          # the inspection hatch lives here
                    cyl_y(B, fx, fz, deckY - 0.002, deckY + 0.005, 0.015, DK, 8)
        # a raised nosing across each frame, where two courses butt
        w0 = floor_x(ZB[b])
        B.box(-w0 + 0.02, SUB, ZB[b] - 0.020, w0 - 0.02, deckY + 0.005,
              ZB[b] + 0.020, DK, skip=('yn',))
    wN = floor_x(ZB[-1])
    B.box(-wN + 0.02, SUB, ZB[-1] - 0.020, wN - 0.02, deckY + 0.005,
          ZB[-1] + 0.020, DK, skip=('yn',))
    # two cross strips sunk into the plate, on a different pitch from the bays
    for z in (-4.44, -5.86):
        w = floor_x(z)
        B.box(-w + 0.06, deckY - 0.004, z - 0.022, w - 0.06, deckY + 0.008,
              z + 0.022, DK, skip=('yn',))

    # ---- what stands on the pan. A flat plane 4 m long is the largest single
    #      surface in the ship and it had nothing on it at all.
    for sx in (-1, 1):                                    # seat rails
        rp = [(sx * 0.235, deckY + 0.016, z) for z in (-4.72, -5.02, -5.32, -5.58)]
        sweep_profile(B, rp, [[(-0.026, 0.0), (-0.026, 0.012), (-0.014, 0.020),
                               (-0.010, 0.040), (0.010, 0.040), (0.014, 0.020),
                               (0.026, 0.012), (0.026, 0.0)]] * 4, RAIL,
                      up=(0.0, 1.0, 0.0))
        for z in (-4.78, -5.10, -5.42):
            hexbolt(B, (sx * 0.235, deckY + 0.041, z), (0.0, 1.0, 0.0), 0.0060,
                    DK, up=(0.0, 0.0, 1.0))
    # inspection hatch, off the centreline, with a flush latch
    recess(B, (0.62, deckY + 0.001, -5.30), (0.0, 1.0, 0.0), 0.185, 0.135, 0.012,
           DK, r=0.024, up=(1.0, 0.0, 0.0), seg=3)
    revolve(B, 0.62, -5.30, [(0.0, deckY - 0.008), (0.030, deckY - 0.008),
                             (0.032, deckY - 0.002), (0.026, deckY + 0.002)],
            RAIL, 16)
    for (hx, hz) in ((0.46, -5.16), (0.78, -5.16), (0.46, -5.44), (0.78, -5.44)):
        hexbolt(B, (hx, deckY + 0.002, hz), (0.0, 1.0, 0.0), 0.0058, RAIL,
                up=(1.0, 0.0, 0.0))
    # toe board at the forward end, and the rudder-pedal footwell ramp
    tb = [(0.0, deckY, -6.90), (0.0, deckY, -7.34)]
    sweep_profile(B, [(0.0, deckY, -6.86), (0.0, deckY + 0.055, -7.16),
                      (0.0, deckY + 0.062, -7.44)],
                  [[(-0.62, 0.0), (-0.60, 0.030), (0.60, 0.030), (0.62, 0.0)],
                   [(-0.55, 0.0), (-0.53, 0.026), (0.53, 0.026), (0.55, 0.0)],
                   [(-0.48, 0.0), (-0.46, 0.020), (0.46, 0.020), (0.48, 0.0)]],
                  RUB, up=(0.0, 1.0, 0.0))
    for k in range(9):                                    # anti-slip ribs on it
        zz = -6.92 - k * 0.062
        t = (zz + 6.92) / -0.50
        sweep_profile(B, [(-0.56 + 0.06 * t, deckY + 0.026 + 0.024 * t, zz),
                          (0.0, deckY + 0.030 + 0.024 * t, zz),
                          (0.56 - 0.06 * t, deckY + 0.026 + 0.024 * t, zz)],
                      [[(-0.011, 0.006), (0.0, 0.010), (0.011, 0.006),
                        (0.011, -0.004), (-0.011, -0.004)]] * 3, RAIL,
                      up=(0.0, 1.0, 0.0))
    # drains in the cove, port side only
    for z in (-4.36, -5.24, -6.12):
        W = tub_x(z, deckY + CR) - 0.112
        lathe(B, (-(W + 0.030), deckY + 0.030, z), (0.62, 0.78, 0.0),
              [(0.030, -0.004), (0.032, 0.002), (0.026, 0.006)], DK, 14,
              ref=(0.0, 0.0, 1.0), cap0=False)

    # ---- kick panels: recessed bays in the face, with real depth
    for sx in (-1, 1):
        for k in range(5 if sx > 0 else 4):
            z = -3.94 - k * 0.72 - (0.14 if sx < 0 else 0.0)
            X = tub_x(z, deckY + 0.185) - 0.014
            recess(B, (sx * X, deckY + 0.185, z), (-sx * 1.0, 0.0, 0.0),
                   0.086, 0.190, 0.030, DK, r=0.018, up=(0.0, 0.0, 1.0), seg=3)
            if k % 3 == 1:
                for j in range(3):
                    lathe(B, (sx * (X - 0.024), deckY + 0.130 + j * 0.055, z),
                          (-sx * 1.0, 0.0, 0.0),
                          [(0.010, 0.0), (0.011, 0.005), (0.008, 0.009)], RAIL,
                          10, ref=(0.0, 1.0, 0.0))

    # ---- structural ribs up the tub sides, at the hull frames. Lofted, with a
    #      shoe at the waist and a lightening scallop in the web.
    for z in (-4.10, -5.45, -6.80):
        hw, h, r, waist = nose_at(z)
        for sx in (-1, 1):
            st = []
            for (y, w, d, k) in ((deckY + 0.12, 0.030, 0.048, 3.2),
                                 (deckY + 0.30, 0.024, 0.040, 2.8),
                                 ((deckY + waist) * 0.5, 0.020, 0.034, 2.6),
                                 (waist - 0.16, 0.024, 0.040, 2.8),
                                 (waist - 0.03, 0.036, 0.062, 3.4),
                                 (waist + 0.02, 0.030, 0.052, 3.6)):
                st.append(sect(sx * (tub_x(z, y) - 0.046), y, z, w, d, k, 14))
            loft2(B, st, DK)
            for j in range(3):
                yy = deckY + 0.34 + j * 0.30
                if yy > waist - 0.20:
                    break
                lathe(B, (sx * (tub_x(z, yy) - 0.078), yy, z), (-sx * 1.0, 0.0, 0.0),
                      [(0.018, 0.0), (0.019, 0.006), (0.014, 0.010)], RAIL, 12,
                      ref=(0.0, 1.0, 0.0))
            hexbolt(B, (sx * (hw - 0.046), waist + 0.014, z), (0.0, 1.0, 0.0),
                    0.0066, RAIL, up=(0.0, 0.0, 1.0))

    # ---- side consoles: closed bodies growing out of the tub wall.
    #      Two quads each before -- a top face and an inboard face, open
    #      underneath, so from the front they read as folded paper.
    CZ = [-5.02 + (-6.62 + 5.02) * i / 12 for i in range(13)]
    for sx in (-1, 1):
        cpath, csect = [], []
        for z in CZ:
            X = tub_x(z, 0.86) - 0.010
            t = (z + 5.02) / -1.60
            y0 = 0.860 - 0.030 * t
            e = 1.0 - 0.06 * math.sin(math.pi * t)         # a swell amidships
            def A(dx):
                return -sx * (X - dx * e)
            csect.append([
                (A(0.030), y0 + 0.066), (A(0.110), y0 + 0.080),
                (A(0.330), y0 + 0.046), (A(0.500), y0 + 0.006),
                (A(0.566), y0 - 0.026), (A(0.578), y0 - 0.074),
                (A(0.560), y0 - 0.210), (A(0.500), y0 - 0.318),
                (A(0.300), y0 - 0.352), (A(0.040), y0 - 0.330)])
            cpath.append((0.0, 0.0, z))
        sweep_profile(B, cpath, csect, DK, up=(0.0, 1.0, 0.0))
        # knuckle strip along the inboard top edge, following the same curve
        kp, ks = [], []
        for z in CZ:
            X = tub_x(z, 0.86) - 0.010
            t = (z + 5.02) / -1.60
            y0 = 0.860 - 0.030 * t
            kp.append((-sx * (X - 0.548), y0 - 0.004, z))
            ks.append([(-0.016, 0.020), (0.006, 0.026), (0.014, 0.010),
                       (0.010, -0.014), (-0.016, -0.018)])
        sweep_profile(B, kp, ks, AC, up=(0.0, 1.0, 0.0))

        # switch banks on the console top. Port and starboard deliberately
        # do not match: a cabin whose two halves are reflections of each
        # other is the loudest "generated, not built" signal there is, and
        # it measures -- 63% of central pixels were within six levels of
        # their own mirror image.
        TOP = (0.0, 0.93, 0.36)                     # the canted top's normal
        for k in range(5 if sx > 0 else 3):
            z = -5.30 - k * 0.215 - (0.10 if sx < 0 else 0.0)
            X = tub_x(z, 0.86) - 0.010
            t = (z + 5.02) / -1.60
            y0 = 0.860 - 0.030 * t
            cx = sx * (X - 0.300)
            if k % 2 == 0:
                for j in range(3):
                    toggle(B, (cx + (j - 1) * 0.052, y0 + 0.050, z), TOP,
                           DK, RAIL, AC, up=(1.0, 0.0, 0.0), s=0.92,
                           lean=(0.40 if (j + k) % 2 else -0.44))
            else:
                rotary(B, (cx, y0 + 0.050, z), TOP, DK, RAIL, AC,
                       up=(1.0, 0.0, 0.0), s=0.80, ang=-0.9 + k * 0.7)
                pad(B, (cx + 0.070, y0 + 0.048, z), TOP, 0.030, 0.010, 0.003,
                    AC, r=0.003, up=(1.0, 0.0, 0.0))
        # The throttle used to live out here, at x 1.10-1.46 -- which is
        # 69 degrees off the seated axis, well outside a 47-degree half
        # frame. It is on the port armrest head now, where a left hand
        # reaches and a camera can see it. What is left on this console is
        # what a console is for: radios.
        if sx > 0:
            z0 = -5.86
            X = tub_x(z0, 0.86) - 0.010
            for k in range(3):                      # radio stack, in a rack
                zr = z0 + k * 0.115
                recess(B, (X - 0.300, 0.906, zr + 0.043), TOP, 0.130, 0.040,
                       0.016, DK, r=0.008, up=(1.0, 0.0, 0.0), seg=3)
                for j in range(2):
                    rotary(B, (X - 0.190 + j * 0.055, 0.912, zr + 0.043), TOP,
                           DK, RAIL, AC, up=(1.0, 0.0, 0.0), s=0.44,
                           ang=0.4 * k - j)
                pad(B, (X - 0.372, 0.910, zr + 0.043), TOP, 0.040, 0.011,
                    0.003, AC if k == 1 else RAIL, r=0.003, up=(1.0, 0.0, 0.0))
            gauge(B, (X - 0.300, 0.905, z0 - 0.100), TOP, 0.048, DK, HULL, RAIL,
                  up=(1.0, 0.0, 0.0), ang=-1.2)
        # a guarded master switch at the forward end, and a rotary selector
        zf = -6.30 if sx > 0 else -6.06
        Xf = tub_x(zf, 0.86) - 0.010
        tf = (zf + 5.02) / -1.60
        yf = 0.860 - 0.030 * tf
        cf = sx * (Xf - (0.300 if sx > 0 else 0.360))
        toggle(B, (cf, yf + 0.050, zf), TOP, AC, RAIL, DK, up=(1.0, 0.0, 0.0),
               s=1.25, lean=0.5 if sx > 0 else -0.35)
        guard_cage(B, (cf, yf + 0.052, zf), TOP, 0.030, 0.022, RAIL,
                   up=(1.0, 0.0, 0.0), s=1.2)
        rotary(B, (cf - sx * 0.100, yf + 0.048, zf + 0.070), TOP, DK, RAIL, AC,
               up=(1.0, 0.0, 0.0), s=0.9, ang=1.1 if sx > 0 else -0.6)
    return B.obj(name)


# --------------------------------------------------------- coaming + console
# Panel frames, in the order the eye reads them. These are the *same* numbers
# Interior.js gives the live canvases; changing one without the other leaves a
# screen floating outside its recess.
#
# The whole stack came down 100 mm. It is the last geometric lever on the
# framing gate: the coaming crown *is* the dash's silhouette, and at the old
# height it cut the seated frame at 52% of its height, so the bottom half of
# everything the player looks at was console. The floor on the move is the main
# display's lower edge, which has to stay inside the frame -- 100 mm puts it at
# 97% of frame height -- and the pedestal apron, which is steepened to match.
PANELS = [
    ('main',  0.86, 0.42, 0.0,   0.805, -6.30, -0.60,  0.00, -0.49, -0.40, 0.49, 0.28),
    ('left',  0.44, 0.28, -0.735, 0.775, -6.24, -0.60,  0.42, -0.40, -0.36, 0.40, 0.26),
    ('right', 0.44, 0.28, 0.735, 0.775, -6.24, -0.60, -0.42, -0.40, -0.36, 0.40, 0.26),
]


# The glare shield's crown datum, and the slot in its underside that the wash
# lamp lives in. Interior.js reproduces both -- it hangs the practical in the
# slot -- so the two have to be changed together or the lamp ends up buried in
# the casting or hanging in mid-air below it.
COAM_HW = 1.34


def coam_crown(x):
    """(y, z) of the crown line. The outboard plunge is the load-bearing part:
       held level to the tips the shield lays a hard bar across the outer
       thirds of the window at exactly eye level, which is most of why the
       forward view measured as a gunslit. It dives onto the tub waist instead,
       which is where the structure actually goes."""
    t = min(abs(x) / COAM_HW, 1.0)
    y = 1.096 - 0.052 * t * t
    z = -6.530 + 0.300 * t * t
    p = max(0.0, (abs(x) - 0.98) / 0.36)
    return (y - 0.300 * p * p, z + 0.150 * p * p)


def coam_scale(x):
    t = min(abs(x) / COAM_HW, 1.0)
    return (1.00 - 0.14 * t * t, 1.00 - 0.30 * t * t, 0.018 + 0.052 * t * t)


def _coam_sect(x, dip=0.0):
    """The shield's section, as (forward, up) about the crown datum.

       Everything the brief asks of this piece is in these 29 points and none
       of it survives being drawn as four quads. Reading round from the nose:
       a rolled lip of real radius; a hood that crowns rather than ramps; a
       26 mm roll over the top edge; an aft face that leans forward as it rises
       -- tumblehome, and it is what gives the surface the pilot's eye rests on
       a continuous highlight instead of two flat fills meeting at a corner;
       a genuine undercut at the root, which throws the shadow line that
       separates the shield from the panel; and a slot in the underside for the
       wash lamp, so the light comes out of a channel rather than off a bar
       stuck to the ceiling.

       `dip` pushes the aft face forward, which is how the demist registers are
       cut *into* the form. A vent modelled as a box on the surface is a box on
       the surface however many segments it has."""
    sa, sb, lean = coam_scale(x)
    NX, NY, NR = 0.130, -0.098, 0.030
    CX, CY, CR = -0.040, -0.026, 0.026
    P = arc2(NX, NY, NR, 0.0, math.radians(105), 5)
    P += [(0.100, -0.052), (0.056, -0.032), (0.014, -0.014)]
    P += arc2(CX, CY, CR, math.radians(28), math.radians(205), 7)
    P += [(-0.0745 + dip * 0.45, -0.0560),
          (-0.0830 + dip * 0.90, -0.0730),
          (-0.0905 + dip, -0.0800),
          (-0.0800 + dip * 0.55, -0.0930)]
    P += [(-0.020, -0.1070), (0.012, -0.1120), (0.018, -0.1300),
          (0.078, -0.1345), (0.084, -0.1180), (0.100, -0.1240)]
    P += arc2(NX, NY, NR, math.radians(255), math.radians(350), 4)
    out = []
    for (a, b) in P:
        f = (b + 0.1345) / 0.1345
        out.append(((a + lean * f) * sa, b * sb))
    return out


def coam_lamp(x):
    """Where the wash lamp sits, inside the underside slot. Mirrored in JS."""
    cy, cz = coam_crown(x)
    sa, sb, _ = coam_scale(x)
    return (cy - 0.1265 * sb, cz - 0.048 * sa)


def cockpit_coaming(name='cp_coaming'):
    """The glare shield and the instrument stack under it.

       This is the piece the whole frame hangs on. A cockpit reads as a cockpit
       because of the depth wrapped around the glass, not because of the glass.

       It was four quads per station -- a bent sheet of card with boxes half
       buried in it -- and it is a swept solid now whose section changes along
       the whole run: it is deepest and tallest on the centreline where the eye
       rests on it, sheds a third of its height by the outboard displays, and
       dives onto the tub waist past them so it stops walling off the corners
       of the window."""
    B = Build()
    HULL, DK, AC, RAIL = (MI['KIT_HULL'], MI['KIT_DARK'],
                          MI['KIT_ACCENT'], MI['KIT_RAIL'])
    RUB = MI['KIT_RUBBER']

    # ---- demist registers, cut into the aft face. Port carries three on a
    #      tight pitch, starboard two on a wide one: the shield is structure so
    #      its *form* is symmetric, but nothing merely fitted to it is.
    REG = [(-1.16, 0.082), (-0.90, 0.082), (-0.64, 0.082),
           (0.40, 0.098), (0.96, 0.098)]
    DIP = 0.030

    def dip_at(x):
        for (xc, hw) in REG:
            if abs(x - xc) <= hw:
                return DIP
        return 0.0

    XS = set()
    n = 42
    for i in range(n + 1):
        XS.add(round(-COAM_HW + 2 * COAM_HW * i / n, 5))
    for (xc, hw) in REG:
        for d in (-hw - 0.009, -hw, hw, hw + 0.009):
            XS.add(round(xc + d, 5))
    XS = sorted(XS)

    path = [(x,) + coam_crown(x) for x in XS]
    path = [(x, y, z) for (x, y, z) in path]
    sects = [_coam_sect(x, dip_at(x)) for x in XS]
    sweep_profile(B, path, sects, DK)

    # ---- the registers themselves: a lathed eyeball in each of the wide
    #      starboard bays, angled vanes in the narrow port ones. Two families
    #      of vent, both cut into a bay that has real walls.
    for (xc, hw) in REG:
        cy, cz = coam_crown(xc)
        sa, sb, lean = coam_scale(xc)
        # the bay floor sits at the dipped aft face; its outward normal points
        # aft and slightly down, which is the direction the pilot sees it from
        # world z = crown_z - a, because the section's first coordinate runs
        # forward and forward is -Z. Getting this backwards buries the whole
        # fitting 120 mm inside the casting, where it bakes but never renders.
        nrm = (0.0, -0.34, 0.94)
        fz = cz - (-0.086 + DIP) * sa
        fy = cy - 0.066 * sb
        if hw > 0.09:
            lathe(B, (xc, fy, fz), nrm,
                  [(0.050, 0.0), (0.054, 0.008), (0.052, 0.019), (0.044, 0.026)],
                  DK, 20, ref=(1.0, 0.0, 0.0), cap0=False, cap1=False)
            lathe(B, (xc, fy, fz), (0.30, -0.42, 0.86),
                  [(0.0, 0.006), (0.030, 0.010), (0.040, 0.021),
                   (0.038, 0.030), (0.026, 0.035)], RAIL, 16,
                  ref=(1.0, 0.0, 0.0))
            lathe(B, (xc, fy, fz), (0.30, -0.42, 0.86),
                  [(0.0, 0.030), (0.014, 0.032), (0.013, 0.036)], DK, 12,
                  ref=(1.0, 0.0, 0.0))
        else:
            for k in range(4):
                vy = fy + 0.030 - k * 0.020
                sweep_profile(
                    B, [(xc - hw + 0.010, vy, fz + 0.004),
                        (xc, vy + 0.001, fz + 0.006),
                        (xc + hw - 0.010, vy, fz + 0.004)],
                    [[(-0.0022, 0.011), (0.0022, 0.008),
                      (0.0022, -0.008), (-0.0022, -0.011)]] * 3, RAIL)
            for sv in (-1, 1):
                pad(B, (xc + sv * (hw - 0.004), fy, fz + 0.010), (0.0, 0.0, 1.0),
                    0.004, 0.036, 0.006, DK, r=0.0015, up=(1.0, 0.0, 0.0))

    # ---- placards on the aft face, where a register is not. A raised plate
    #      with a rolled edge, which is what the eye reads as a label; an
    #      extruded rectangle is what it reads as a decal.
    for (px, pw) in ((-0.32, 0.13), (0.10, 0.09), (0.66, 0.11), (1.20, 0.07)):
        cy, cz = coam_crown(px)
        sa, sb, _ = coam_scale(px)
        pad(B, (px, cy - 0.058 * sb, cz + 0.076 * sa), (0.0, -0.34, 0.94),
            pw, 0.013, 0.004, AC, r=0.004, up=(1.0, 0.0, 0.0))

    # ---- fasteners along the crown roll, where the shield bolts to its frame
    for k in range(9):
        px = -1.20 + k * 0.30
        cy, cz = coam_crown(px)
        sa, sb, _ = coam_scale(px)
        hexbolt(B, (px, cy - 0.012 * sb, cz + 0.056 * sa), (0.0, 0.62, 0.78),
                0.0058, RAIL, up=(1.0, 0.0, 0.0))

    # ---- the three fascias, each with a real opening cut in it
    for (_n, w, h, x, y, z, rx, ry, u0, v0, u1, v1) in PANELS:
        screen_bay(B, w, h, x, y, z, rx, ry, u0, v0, u1, v1)

    Mc = rotXY(-0.60, 0.0)
    oc = (0.0, 0.905, -6.30)
    # Switch banks live on the wings, below the outboard displays -- there is
    # no room for them beside the main one without covering its neighbours.
    #
    # The two wings carry *different* equipment, and that is the point. Left
    # and right were built from one loop, so the forward seated frame was an
    # exact mirror of itself down the centreline and measured as one: 63-68% of
    # central pixels within six levels of their reflection. Structure has to be
    # symmetric -- the pillars, the posts, the coaming -- but nothing that is
    # merely *fitted* to it does.
    PORT, STBD = PANELS[1], PANELS[2]
    Mw, ow_ = rotXY(PORT[6], PORT[7]), (PORT[3], PORT[4], PORT[5])
    NP = (-PORT[6], 0.0, 0.0)                 # placeholder, replaced below
    # the wing's outward normal, in world: the panel frame's +n axis
    def wing_n(P):
        M = rotXY(P[6], P[7])
        return (M[0][2], M[1][2], M[2][2])

    def wing_u(P):
        M = rotXY(P[6], P[7])
        return (M[0][0], M[1][0], M[2][0])

    def wing_at(P, u, v, n=0.0):
        return local_to_world(rotXY(P[6], P[7]), (P[3], P[4], P[5]), (u, v, n))

    NPORT, UPORT = wing_n(PORT), wing_u(PORT)
    switch_block(B, ow_, Mw, -0.055, -0.272, 4, 2, 0.048)
    for k in range(3):                                  # rotary column
        rotary(B, wing_at(PORT, 0.235, -0.330 + k * 0.062, 0.024), NPORT,
               DK, RAIL, AC, up=UPORT, s=0.62, ang=-0.9 + k * 0.8)
    pad(B, wing_at(PORT, -0.23, 0.217, 0.024), NPORT, 0.13, 0.017, 0.004, AC,
        r=0.004, up=UPORT)

    Mw, ow_ = rotXY(STBD[6], STBD[7]), (STBD[3], STBD[4], STBD[5])
    NSTBD, USTBD = wing_n(STBD), wing_u(STBD)
    # starboard: a keypad, one guarded rotary, and a real round gauge
    for r in range(3):
        for c in range(4):
            u = -0.222 + c * 0.056
            v = -0.324 + r * 0.050
            panel_box(B, ow_, Mw, u - 0.023, v - 0.020, u + 0.023, v + 0.020, 0.024, 0.031, DK)
            panel_box(B, ow_, Mw, u - 0.017, v - 0.014, u + 0.017, v + 0.014, 0.031, 0.040,
                      AC if (r * 4 + c) == 5 else RAIL)
    toggle(B, wing_at(STBD, 0.148, -0.288, 0.024), NSTBD, DK, RAIL, AC,
           up=USTBD, s=1.15, lean=0.5)
    guard_cage(B, wing_at(STBD, 0.148, -0.288, 0.026), NSTBD, 0.026, 0.019,
               RAIL, up=USTBD)
    gauge(B, wing_at(STBD, 0.262, -0.290, 0.026), NSTBD, 0.043, DK, HULL, RAIL,
          up=USTBD, ang=-1.1)
    pad(B, wing_at(STBD, 0.25, 0.217, 0.024), NSTBD, 0.13, 0.017, 0.004, AC,
        r=0.004, up=USTBD)
    NMAIN, UMAIN = wing_n(PANELS[0]), wing_u(PANELS[0])
    for k in range(5):
        u = -0.34 + k * 0.17
        rotary(B, wing_at(PANELS[0], u, -0.302, 0.024), NMAIN, DK, RAIL, AC,
               up=UMAIN, s=0.78, ang=-1.2 + k * 0.55)
    # Guarded master switches, on the lower fascia. They were on the
    # centreline at v 0.34, which put them 4.5 cm proud of the coaming crown:
    # two boxes floating in front of the planet, in the middle of the frame.
    for su in (-1, 1):
        toggle(B, wing_at(PANELS[0], su * 0.425, -0.312, 0.024), NMAIN,
               AC, RAIL, DK, up=UMAIN, s=1.2, lean=-0.42 if su > 0 else 0.30)
        flip_cover(B, wing_at(PANELS[0], su * 0.425, -0.340, 0.026), NMAIN,
                   0.024, 0.017, AC, RAIL, up=UMAIN,
                   ang=0.52 if su > 0 else 0.30)

    # ---- divider posts between the centre panel and the canted wings. They
    #      hide the joint between three planes that meet at an angle, and they
    #      are where a real console puts its structure.
    #
    #      Every fitting on them used to be at z -6.414..-6.396, which is
    #      forward of the post's own forward face at -6.400: the pilot sits at
    #      -5.26 and sees the *aft* face, so the whole dressing was modelled on
    #      the side facing the nose. It is on -6.318 now, and Interior.js hangs
    #      a column of status lamps in the channel left between the two rails.
    #      They are lofted columns now: a rounded aft face with a milled channel
    #      up it, a waist that swells where the two fascias pull on it, and a
    #      cast foot. A post is the one thing in a console that carries load,
    #      and a rectangular prism does not say so.
    for sx in (-1, 1):
        st = []
        for (y, w, d, k) in ((0.512, 0.030, 0.052, 3.4), (0.540, 0.026, 0.046, 3.0),
                             (0.660, 0.022, 0.042, 2.8), (0.780, 0.023, 0.043, 2.8),
                             (0.900, 0.021, 0.041, 2.8), (0.978, 0.018, 0.036, 3.0),
                             (1.000, 0.013, 0.028, 3.4)):
            st.append(sect(sx * 0.513, y, -6.359 + (0.052 - d) * 0.35, w, d, k, 14))
        loft2(B, st, DK)
        # the channel the status lamps sit in, and its two rails
        for u in (-0.0165, 0.0165):
            sweep_path(B, [(sx * (0.513 + u), 0.600, -6.312),
                           (sx * (0.513 + u), 0.800, -6.310),
                           (sx * (0.513 + u), 0.986, -6.314)],
                       [0.0042, 0.0046, 0.0038], RAIL, 8, up=(1.0, 0.0, 0.0))
        pad(B, (sx * 0.513, 0.994, -6.318), (0.0, 0.30, 0.95), 0.024, 0.011,
            0.004, AC, r=0.003, up=(1.0, 0.0, 0.0))
        for k in range(3):
            hexbolt(B, (sx * 0.513, 0.600 + k * 0.196, -6.316), (0.0, 0.0, 1.0),
                    0.0052, RAIL, up=(1.0, 0.0, 0.0))

    # ---- the lower fascia and knee bolster: what the panel actually stands on.
    #      Two quads before -- a folded plate, and the nearest large surface in
    #      the seated down-view. It is a swept section now with a rolled top
    #      edge, a recessed louvre band and a return under the knees, and the
    #      section flattens as it runs outboard so it is not an extrusion.
    KN = [-1.34 + 2.68 * i / 34 for i in range(35)]
    kpath, ksect = [], []
    for x in KN:
        t = min(abs(x) / 1.34, 1.0)
        kpath.append((x, 0.485 - 0.010 * t, -6.055 + 0.19 * t * t))
        f = 1.0 - 0.22 * t * t
        ksect.append([
            (0.020 * f, 0.006), (0.006, 0.020 * f), (-0.030 * f, 0.012 * f),
            (-0.055 * f, -0.028), (-0.052 * f, -0.062), (-0.026 * f, -0.070),
            (-0.028 * f, -0.104), (-0.020 * f, -0.150), (0.004, -0.196),
            (0.022 * f, -0.230), (0.052 * f, -0.238), (0.060 * f, -0.212),
            (0.048 * f, -0.150), (0.046 * f, -0.070), (0.052 * f, -0.024)])
    sweep_profile(B, kpath, ksect, DK)
    # cooling louvres in the recessed band, as real angled blades
    for i in range(8):
        x = -0.98 + i * 0.28
        t = min(abs(x) / 1.34, 1.0)
        zc = -6.055 + 0.19 * t * t + 0.030
        yc = 0.485 - 0.010 * t
        recess(B, (x, yc - 0.112, zc), (0.0, -0.16, 0.99), 0.082, 0.044, 0.020,
               DK, r=0.008, up=(1.0, 0.0, 0.0))
        for k in range(3):
            vy = yc - 0.134 + k * 0.022
            sweep_profile(B, [(x - 0.074, vy, zc - 0.004), (x, vy + 0.0015, zc - 0.002),
                              (x + 0.074, vy, zc - 0.004)],
                          [[(-0.0020, 0.009), (0.0020, 0.006),
                            (0.0020, -0.006), (-0.0020, -0.009)]] * 3, RAIL)

    # ---- mullion brackets: where the plunged shield ends bolt onto the tub.
    #      Two boxes before, and they stood 0.30 m proud of the crown at the
    #      exact azimuth the window is widest -- a pair of grey slabs in the
    #      outer thirds of every forward frame. The bracket is a lofted shoe
    #      now, it sits *below* the shield end, and it carries the fasteners.
    for sx in (-1, 1):
        cy, cz = coam_crown(sx * COAM_HW)
        st = []
        for (dz, w, h, dy) in ((-0.055, 0.030, 0.052, -0.020),
                               (0.010, 0.046, 0.072, -0.036),
                               (0.090, 0.052, 0.086, -0.060),
                               (0.170, 0.040, 0.070, -0.096)):
            st.append(sect_xy(sx * (COAM_HW + 0.028), cy + dy, cz + dz,
                              w, h, 3.2, 14))
        loft2(B, st, DK)
        for k in range(3):
            hexbolt(B, (sx * (COAM_HW + 0.056), cy - 0.030 - k * 0.032,
                        cz + 0.010 + k * 0.058), (sx * 1.0, 0.0, 0.0),
                    0.0068, RAIL, up=(0.0, 1.0, 0.0))
    return B.obj(name)


# ------------------------------------------------------------ centre pedestal
def cockpit_pedestal(name='cp_pedestal'):
    """Radar well and the breaker stack between the knees.

       Everything here is shaped by one sight line: the bottom edge of the main
       display sits at (0, 0.704, -6.162), and the ray from the seated eye to
       it passes y 0.818 at z -6.00 and y 0.762 at z -6.08. The first version of
       this piece put a flat top at 0.786 all the way forward to -6.18 and a
       throttle quadrant at 0.872 on top of that, and between them they cut the
       bottom third off the display. The top now stops at -6.00 and falls away
       on an apron, and the throttle has moved to the port console, which is
       where a left hand looks for it anyway."""
    B = Build()
    DK, AC, RAIL, HULL = (MI['KIT_DARK'], MI['KIT_ACCENT'],
                          MI['KIT_RAIL'], MI['KIT_HULL'])
    # ---- body.
    #      A rectangular prism, until a review of the seated down-view called
    #      the whole lower half of the frame a flat plate with boxes on it. It
    #      is a casting now: swept fore-and-aft with tumblehome, so the cheeks
    #      lean in as they rise and each one carries a continuous highlight
    #      down its length instead of meeting the top at a dead corner. The
    #      section is a superellipse at k = 5, which is a rectangle with the
    #      corners taken off -- still square-shouldered, still reads as
    #      structure, but with an edge that returns light.
    #      The half-width stays at 0.342 so the top plate at 0.36 overhangs it
    #      as a lip; wider and the cheeks start eating the armrest beams, whose
    #      inboard edge is at 0.258.
    #      Open-topped, like the box it replaces: the radar well hangs down
    #      into it from the plate above and a lid across the section buries the
    #      dish and the tactical hologram with it.
    beam(B, [(-6.020, 0.0, 0.500, 0.320, 0.250),
             (-5.960, 0.0, 0.504, 0.338, 0.256),
             (-5.760, 0.0, 0.506, 0.342, 0.258),
             (-5.560, 0.0, 0.504, 0.338, 0.256),
             (-5.430, 0.0, 0.498, 0.318, 0.246)], DK, 18, 5.0,
         skip=lambda a, b: min(a[1], b[1]) > 0.700)
    #      A cast shoulder flaring out under the top plate, port and starboard
    #      only. Without it the plate's 18 mm overhang is a thin flange with
    #      nothing beneath it and reads as sheet metal flapping off the side of
    #      the box; run right across, it fills the well again.
    for sxa in (-1, 1):
        beam(B, [(-6.014, sxa * 0.318, 0.722, 0.014, 0.026),
                 (-5.955, sxa * 0.330, 0.724, 0.024, 0.028),
                 (-5.760, sxa * 0.334, 0.724, 0.024, 0.028),
                 (-5.560, sxa * 0.330, 0.724, 0.024, 0.028),
                 (-5.436, sxa * 0.318, 0.722, 0.014, 0.026)], DK, 12, 4.2)
    #      A moulded waist rail round it at knee height, which is both a
    #      parting line and the thing that stops 0.5 m of unbroken cheek.
    beam(B, [(-6.006, 0.0, 0.452, 0.340, 0.196),
             (-5.980, 0.0, 0.452, 0.350, 0.202),
             (-5.500, 0.0, 0.452, 0.350, 0.202),
             (-5.446, 0.0, 0.452, 0.338, 0.194)], AC, 18, 5.2,
         cap0=False, cap1=False)
    # ---- top plate, with a hole cut in it for the well.
    #
    #      This was one solid box from z -6.02 to -5.42, and every ring of the
    #      radar dish below was modelled *underneath* it: the well was fully
    #      capped and what the seated view showed was 0.72 m of unbroken plate
    #      with a bezel of tick blocks standing on it. It measured (99, 151,
    #      190) against (33, 54, 77) for the plate beside it and read as a
    #      bright flat disc, which is why every attempt to darken the dish
    #      changed nothing -- the dish was never on screen.
    #
    #      So the plate is now a frame plus a radial fan running out from the
    #      bezel to the frame's inner edge. Four side strips carry the plate's
    #      thickness; the fan is flat, at one height, so its quads are planar
    #      whatever direction they run in.
    PX, PZ0, PZ1, PY0, PY1 = 0.36, -6.02, -5.42, 0.752, 0.786
    IX, IZ0, IZ1, WR = 0.350, -6.010, -5.430, 0.190
    B.box(-PX, PY0, PZ0, PX, PY1, PZ0 + 0.010, DK)
    B.box(-PX, PY0, PZ1 - 0.010, PX, PY1, PZ1, DK)
    B.box(-PX, PY0, PZ0, -IX, PY1, PZ1, DK)
    B.box(IX, PY0, PZ0, PX, PY1, PZ1, DK)

    def _bnd(a):
        """Where a ray from the well centre leaves the plate's inner opening."""
        ca, sa = math.cos(a), math.sin(a)
        t = 1e9
        if abs(ca) > 1e-6:
            t = min(t, IX / abs(ca))
        if abs(sa) > 1e-6:
            t = min(t, ((IZ1 + 5.80) if sa > 0 else (-5.80 - IZ0)) / abs(sa))
        return (ca * t, -5.80 + sa * t)
    for i in range(28):
        a0 = 2 * math.pi * i / 28
        a1 = 2 * math.pi * (i + 1) / 28
        b0, b1 = _bnd(a0), _bnd(a1)
        B.quad((math.cos(a0) * WR, PY1, -5.80 + math.sin(a0) * WR),
               (math.cos(a1) * WR, PY1, -5.80 + math.sin(a1) * WR),
               (b1[0], PY1, b1[1]), (b0[0], PY1, b0[1]), DK)
    # forward apron, falling away out of the sight line
    for k in range(4):
        t0, t1 = k / 4.0, (k + 1) / 4.0
        z0, z1 = -6.00 - t0 * 0.20, -6.00 - t1 * 0.20
        y0, y1 = 0.786 - t0 * 0.250, 0.786 - t1 * 0.250
        B.quad((-0.36, y0, z0), (0.36, y0, z0), (0.36, y1, z1), (-0.36, y1, z1), DK)
        B.quad((-0.36, y0, z0), (-0.36, y0 - 0.055, z0), (-0.36, y1 - 0.055, z1), (-0.36, y1, z1), DK)
        B.quad((0.36, y0 - 0.055, z0), (0.36, y0, z0), (0.36, y1, z1), (0.36, y1 - 0.055, z1), DK)
    # A rolled nose along the apron's leading edge, and a rib each side. The
    # apron is 0.36 m of unbroken plane facing the camera and its front edge is
    # the nearest hard line in the lower frame; left as a knife edge it reads
    # as folded card.
    sweep_path(B, [(-0.372, 0.532, -6.186), (-0.300, 0.536, -6.198),
                   (0.300, 0.536, -6.198), (0.372, 0.532, -6.186)],
               0.014, AC, 10)
    for sxa in (-1, 1):
        beam(B, [(-6.196, sxa * 0.352, 0.590, 0.014, 0.058),
                 (-6.060, sxa * 0.360, 0.700, 0.016, 0.068),
                 (-6.004, sxa * 0.360, 0.752, 0.016, 0.038)], DK, 10, 3.2)
    # Radar well: a deep matte-black dish for the hologram to stand in.
    #
    # It was a 86 mm dip finished in the same 0.10-albedo panel grey as the
    # rest of the pedestal, and it measured (85, 140, 182) against (34, 58, 84)
    # for the plate beside it -- two and a half times brighter than its own
    # surround. A shallow well made of pale paint under a cyan lamp 0.6 m away
    # returns almost everything that lands in it, so the plot was drawn on top
    # of the brightest object in the lower frame and had no contrast left. It
    # is 146 mm deep now, walled vertically, and finished in the same matte
    # rubber as the seat webbing. A projector well is black for the same
    # reason a cinema is.
    #      Winding follows one rule: emitted with r increasing, a ring faces up
    #      and inward, which is what every surface of a well wants. A vertical
    #      wall is the r0 == r1 case and follows the same rule with y
    #      increasing; the one surface that has to face *outward* -- the rim of
    #      the bezel -- is the same ring with its two heights swapped.
    RUB = MI['KIT_RUBBER']
    for i in range(40):
        a0 = 2 * math.pi * i / 40
        a1 = 2 * math.pi * (i + 1) / 40
        #      Depth is 70 mm, not the 146 the first cut used. A well deep
        #      enough to be genuinely dark is also deep enough that from a
        #      seated 35-degree look-down it shows nothing but wall: it read as
        #      a tunnel with a woven orange lining, because the only material
        #      matte enough for a projector dish is the upholstery set and its
        #      tile is a 0.26 m weave. Wall in painted alloy, floor in rubber,
        #      and shallow enough that what you see is the floor.
        for (r0, r1, y0, y1, m) in ((WR, WR, 0.798, 0.786, DK),
                                    (0.172, WR, 0.786, 0.798, DK),
                                    (0.156, 0.172, 0.772, 0.786, DK),
                                    (0.120, 0.156, 0.716, 0.772, DK),
                                    (0.0, 0.120, 0.716, 0.716, RUB)):
            p0 = (math.cos(a0) * r0, math.sin(a0) * r0)
            p1 = (math.cos(a1) * r0, math.sin(a1) * r0)
            q0 = (math.cos(a0) * r1, math.sin(a0) * r1)
            q1 = (math.cos(a1) * r1, math.sin(a1) * r1)
            B.quad((p0[0], y0, -5.80 + p0[1]), (p1[0], y0, -5.80 + p1[1]),
                   (q1[0], y1, -5.80 + q1[1]), (q0[0], y1, -5.80 + q0[1]), m)
    # ---- the projector turret and the bearing ring.
    #
    #      This was thirty-eight cubes in the dead centre of the most-looked-at
    #      frame in the game: twenty-four identical 12x12x14 mm boxes on a
    #      202 mm circle standing in for a bearing scale -- every one of them
    #      *axis-aligned* rather than turned to the circle's tangent, so a ring
    #      of tick marks read as sugar cubes spilled on a plate -- plus ten more
    #      for a projector head and four for emitter posts.
    #
    #      The scale is one machined ring now: a lathed flange with a rolled
    #      outer lip, and the ticks cut *into* it as a radius modulation, major
    #      every 30 degrees to full depth and minor every 10 to half. A tick is
    #      a groove in a bezel, not an object on it.
    #      The outer lip stays a true circle. A radius modulation applied to the
    #      whole lathe puts the ticks on the *silhouette* and the ring reads as
    #      a cog; the grooves belong on the flange face where a bearing scale
    #      actually carries them.
    revolve(B, 0.0, -5.80, [(0.196, 0.786), (0.214, 0.788), (0.220, 0.795),
                            (0.216, 0.803), (0.206, 0.8072), (0.198, 0.8045)],
            RAIL, 72, cap0=False, cap1=False)
    for i in range(36):
        a = 2 * math.pi * i / 36
        maj = (i % 3 == 0)
        recess(B, (math.sin(a) * 0.2075, 0.8072, -5.80 + math.cos(a) * 0.2075),
               (0.0, 1.0, 0.0), 0.0022, 0.0105 if maj else 0.0060,
               0.0026 if maj else 0.0014, DK, r=0.0009,
               up=(math.cos(a), 0.0, -math.sin(a)), seg=2)
    #      Numerals as relieved geometry on the flange -- four cardinal blocks,
    #      each a shallow pad standing 1.2 mm proud, which is what a stamped
    #      figure returns to a raking light.
    for i in range(4):
        a = math.pi / 2 * i
        pad(B, (math.sin(a) * 0.208, 0.8075, -5.80 + math.cos(a) * 0.208),
            (0.0, 1.0, 0.0), 0.016, 0.009, 0.0012, AC, r=0.002,
            up=(math.cos(a), 0.0, -math.sin(a)))
    #      The head: a stepped column, a knurled focus collar, and a lens boss
    #      with a chamfered aperture.
    revolve(B, 0.0, -5.80, [(0.0, 0.716), (0.052, 0.716), (0.054, 0.722),
                            (0.046, 0.727)], DK, 24)
    revolve(B, 0.0, -5.80, [(0.038, 0.726), (0.040, 0.733), (0.038, 0.740)],
            RAIL, 24, knurl(20, 0.05), cap0=False, cap1=False)
    revolve(B, 0.0, -5.80, [(0.032, 0.739), (0.034, 0.744), (0.030, 0.751),
                            (0.022, 0.754), (0.020, 0.749)], DK, 20,
            cap0=False, cap1=False)
    revolve(B, 0.0, -5.80, [(0.0, 0.7485), (0.017, 0.7495)], AC, 20)
    #      Four emitter posts, and the point of them is that they are four
    #      *different* posts: two plain cylinders at different heights, one on a
    #      folding arm, and one with a cable gland at its foot.
    EP = [(math.pi * 0.25, 'plain', 0.030), (math.pi * 0.75, 'arm', 0.0),
          (math.pi * 1.25, 'plain', 0.020), (math.pi * 1.75, 'gland', 0.0)]
    for (a, kind, extra) in EP:
        cx, cz = math.cos(a) * 0.086, -5.80 + math.sin(a) * 0.086
        if kind == 'plain':
            revolve(B, cx, cz, [(0.0, 0.716), (0.013, 0.716), (0.014, 0.722),
                                (0.012, 0.734 + extra), (0.009, 0.740 + extra),
                                (0.0, 0.742 + extra)], DK, 12)
            revolve(B, cx, cz, [(0.011, 0.727), (0.013, 0.730), (0.011, 0.733)],
                    RAIL, 12, cap0=False, cap1=False)
        elif kind == 'arm':
            revolve(B, cx, cz, [(0.0, 0.716), (0.016, 0.716), (0.015, 0.723)],
                    DK, 12)
            sweep_path(B, [(cx, 0.722, cz), (cx * 1.28, 0.734, cz * 1.0 + 0.010),
                           (cx * 1.62, 0.752, cz + 0.026),
                           (cx * 1.70, 0.766, cz + 0.048)],
                       [0.0062, 0.0055, 0.0050, 0.0044], RAIL, 8,
                       up=(0.0, 1.0, 0.0))
            lathe(B, (cx * 1.70, 0.768, cz + 0.050), (0.30, 0.86, 0.41),
                  [(0.0, 0.0), (0.010, 0.001), (0.011, 0.006), (0.007, 0.009)],
                  AC, 12, ref=(1.0, 0.0, 0.0))
        else:
            revolve(B, cx, cz, [(0.0, 0.716), (0.018, 0.716), (0.019, 0.721),
                                (0.013, 0.724), (0.012, 0.738), (0.0, 0.741)],
                    DK, 12)
            revolve(B, cx, cz, [(0.015, 0.7185), (0.017, 0.7205),
                                (0.015, 0.7225)], RAIL, 24,
                    knurl(8, 0.08), cap0=False, cap1=False)
            sweep_path(B, [(cx, 0.7175, cz), (cx * 0.72, 0.7175, cz - 0.026),
                           (cx * 0.40, 0.7185, cz - 0.048)],
                       0.0040, AC, 6, up=(0.0, 1.0, 0.0))
    # radarLabel bay, on the aft face of the well surround
    screen_bay(B, 0.30, 0.088, 0.0, 0.762, -5.62, -1.30, 0.0,
               -0.30, -0.10, 0.30, 0.10, gap=0.010, back=0.030,
               face=0.016, lip=0.008)
    # ---- breaker panels down each cheek, where a knee does not reach.
    #      Two recessed bays per side rather than eight blocks glued on: a
    #      shaped surround standing proud, a sunk back plate, and real toggles
    #      -- a lathed bat on a lathed bezel each. Port carries breakers in
    #      rows of four; starboard carries a smaller bay of rotaries and a
    #      placard, because the two cheeks are not the same equipment.
    for sx in (-1, 1):
        rows = 4 if sx < 0 else 3
        for c in range(2):
            z = -5.53 - c * 0.19
            zh = 0.078
            yc = 0.35 + rows * 0.048
            hh = rows * 0.052 + 0.014
            # surround, standing proud of the cheek with its ends drawn in
            beam(B, [(z - zh - 0.016, sx * 0.334, yc, 0.010, hh - 0.014),
                     (z - zh - 0.002, sx * 0.344, yc, 0.020, hh),
                     (z + zh + 0.002, sx * 0.344, yc, 0.020, hh),
                     (z + zh + 0.016, sx * 0.334, yc, 0.010, hh - 0.014)],
                 DK, 14, 4.0)
            # sunk back plate: the bay is a hole in the surround, not a lid
            beam(B, [(z - zh + 0.006, sx * 0.330, yc, 0.008, hh - 0.020),
                     (z + zh - 0.006, sx * 0.330, yc, 0.008, hh - 0.020)],
                 DK, 10, 5.0)
            for r in range(rows):
                y = yc - hh + 0.032 + r * 0.098
                for k in range(2):
                    zz = z - 0.038 + k * 0.076
                    cyl_x(B, y, zz, sx * 0.336, sx * 0.352, 0.019,
                          AC if (r + c + k) % 5 == 0 else DK, 10)
                    cyl_x(B, y, zz, sx * 0.352, sx * 0.368, 0.0065, RAIL, 8)
        # a cable trunk down the cheek's forward edge, clipped at intervals
        sweep_path(B, [(sx * 0.320, 0.288, -5.995), (sx * 0.332, 0.300, -5.880),
                       (sx * 0.332, 0.300, -5.560), (sx * 0.320, 0.290, -5.455)],
                   0.013, AC, 8)
        for zc in (-5.930, -5.700, -5.500):
            revolve(B, sx * 0.336, zc, [(0.019, 0.286), (0.019, 0.300),
                                        (0.015, 0.308)], DK, 8)
    # a stowage cubby in the forward face of the apron
    B.box(-0.24, 0.36, -6.185, 0.24, 0.52, -6.16, DK)
    B.box(-0.21, 0.38, -6.20, 0.21, 0.50, -6.185, DK)

    # ---- the lower console: a raked keypad standing between the knees.
    #
    #      The seated down-view was measured as one flat slab across its whole
    #      bottom half -- the pedestal top, the apron and the lower fascia, all
    #      one plane at one value with nothing on it. What that view was
    #      missing is foreground, and the only place to put foreground is the
    #      0.10 m of pedestal top between the radar well and the pilot's knees.
    #
    #      That 0.10 m is bounded on both sides by sight lines and there is no
    #      slack in either. The ray from the seated eye to the near rim of the
    #      radar well passes y 0.976 at z -5.495 and y 0.937 at z -5.52; the ray
    #      to the bottom of the main display is far above both. A first cut with
    #      its top edge at y 0.950 / z -5.52 cleared the second and failed the
    #      first by 13 mm, and 13 mm of console laid a grey bar across the
    #      bottom third of the tactical plot. It runs from y 0.786 at z -5.42 to
    #      y 0.930 at z -5.505 now: 31 degrees of rake, facing up and aft into
    #      the pilot's eye, top edge 46 mm clear of the rim.
    #      The wedge is a triangular prism and nothing more: the raked face,
    #      a front wall at z -5.52 that only the nose ever sees, and a cheek
    #      each side. The first cut of it also closed the *aft* end, from
    #      y 0.786 up to 0.950 at z -5.42 -- 0.16 m from the seated eye, which
    #      put a two-thirds-of-a-metre grey wall across the bottom third of
    #      the frame. There is nothing to close there. The panel's low edge is
    #      its aft edge, and it lies on the pedestal top.
    RK = -0.534                     # rx that puts the face normal up and aft
    Mp = rotXY(RK, 0.0)
    op = (0.0, 0.858, -5.4625)
    HU, HV = 0.300, 0.0836
    ZF, YT = -5.505, 0.930
    B.quad((-HU, 0.786, ZF), (-HU, YT, ZF), (HU, YT, ZF), (HU, 0.786, ZF), DK)
    for sx in (-1, 1):
        # wound to face outboard on both cheeks. Emitted in this order the
        # cross product points -x, which is right to port and inside-out to
        # starboard -- and an inside-out face bakes as unoccluded, so the AO
        # pass would have left a bright triangle beside the pilot's knee.
        c = [(sx * HU, 0.786, -5.42), (sx * HU, 0.786, ZF), (sx * HU, YT, ZF)]
        if sx < 0:
            c.reverse()
        B.face(c, DK)
    # a raised lip round all four sides, so it is a tray and not a plate
    for (a, b, c_, d) in ((-HU, -HV, HU, -HV + 0.012), (-HU, HV - 0.012, HU, HV),
                          (-HU, -HV, -HU + 0.012, HV), (HU - 0.012, -HV, HU, HV)):
        panel_box(B, op, Mp, a, b, c_, d, 0.0, 0.011, DK)
    # The face itself *is* screen_bay's fascia: four rectangles around a hole,
    # covering the whole panel. Building the plate first and then cutting a bay
    # into it does not cut anything -- the bay's recess ends up behind a solid
    # plate and the display is simply invisible, which is exactly what happened
    # to the first version of this and to the radar well below it.
    #
    # The bay sits at (0.125, 0.030) in the panel's own frame, 16 mm behind its
    # face. Interior.js states the same world transform for the live canvas;
    # one of the two moving without the other leaves it floating.
    BU, BV = 0.125, 0.0261
    screen_bay(B, 0.28, 0.044, BU, 0.87212, -5.48991, RK, 0.0,
               -HU - BU, -HV - BV, HU - BU, HV - BV,
               gap=0.010, back=0.026, face=0.0164, lip=0.008)
    # switchgear along the bottom, in three groups with clean plate between
    # them: a uniform rank of keys across the whole width reads as a keyboard
    # and gives the eye nothing to fix on.
    for r in range(2):
        for c in range(5):
            u = -0.268 + c * 0.0372
            v = -0.0627 + r * 0.0366
            panel_box(B, op, Mp, u - 0.015, v - 0.0148, u + 0.015, v + 0.0148, 0.0, 0.006, DK)
            panel_box(B, op, Mp, u - 0.011, v - 0.0105, u + 0.011, v + 0.0105, 0.006, 0.013,
                      AC if (r * 5 + c) == 6 else RAIL)
    panel_box(B, op, Mp, -0.100, -0.0697, -0.030, -0.0261, 0.0, 0.009, AC)
    panel_box(B, op, Mp, -0.086, -0.0592, -0.044, -0.0366, 0.009, 0.023, RAIL)
    panel_box(B, op, Mp, -0.069, -0.0557, -0.061, -0.0418, 0.023, 0.029, AC)
    panel_box(B, op, Mp, -0.014, -0.0766, 0.060, -0.0627, 0.0, 0.005, AC)
    for k in range(3):
        u = 0.106 + k * 0.068
        panel_box(B, op, Mp, u - 0.027, -0.0732, u + 0.027, -0.0314, 0.0, 0.008, DK)
        panel_box(B, op, Mp, u - 0.018, -0.0662, u + 0.018, -0.0383, 0.008, 0.022, RAIL)
        panel_box(B, op, Mp, u - 0.004, -0.0644, u + 0.004, -0.0505, 0.022, 0.027, AC)
    return B.obj(name)


# ------------------------------------------------------------------ the seat
def pilot_seat(name='cp_seat'):
    """A piece of furniture somebody sits in for months.

       Built facing -Z, the direction the pilot faces, and placed at the seat
       datum in Interior.js. What makes a seat read is a rigid shell with
       something softer sitting *inside* it, padding divided into segments so
       it creases, bolsters that wrap, and a harness that is clearly load
       bearing -- not one box for the back and one for the cushion."""
    B = Build()
    SEAT, AC, RAIL, RUB = (MI['KIT_SEAT'], MI['KIT_ACCENT'],
                           MI['KIT_RAIL'], MI['KIT_RUBBER'])
    # The shell is its own material. It was the same painted alloy as every
    # bracket in the room, which under the helm practicals read as a slab of
    # near-white standing a metre from the camera on the walk to the seat.
    DK = MI['KIT_SHELL']
    Z0 = -5.02              # seat datum in cockpit coordinates

    def bx(x0, y0, z0, x1, y1, z1, m):
        B.box(x0, y0, Z0 + z0, x1, y1, Z0 + z1, m)

    # ---- pedestal: floor rails, column, gas strut, splayed base
    for sx in (-1, 1):
        bx(sx * 0.12 - 0.030, 0.080, -0.34, sx * 0.12 + 0.030, 0.104, 0.30, DK)
        bx(sx * 0.12 - 0.018, 0.104, -0.34, sx * 0.12 + 0.018, 0.118, 0.30, RAIL)
    bx(-0.23, 0.104, -0.20, 0.23, 0.150, 0.18, DK)
    for i in range(4):
        a = (i / 4) * math.pi * 2 + math.pi / 4
        cx, cz = math.sin(a) * 0.15, math.cos(a) * 0.15
        bx(cx - 0.038, 0.150, cz - 0.038, cx + 0.038, 0.300, cz + 0.038, DK)
    bx(-0.085, 0.290, -0.085, 0.085, 0.430, 0.085, DK)
    bx(-0.042, 0.410, -0.042, 0.042, 0.520, 0.042, RAIL)
    bx(-0.115, 0.505, -0.115, 0.115, 0.545, 0.115, DK)

    # ---- shell: pan and back.
    #
    #      Second pass on this, and the finding was the plainest in the review:
    #      "the seat back is a flat slab wearing the same panel treatment as the
    #      bulkheads". It was literally that. The back was fourteen quads spanned
    #      straight across from -w to +w — a *ruled* surface, flat in x at every
    #      height — with two side walls and a rolled edge boxed onto it. Nothing
    #      in it curved in the direction a seat back curves, so from anywhere in
    #      the room except the seat itself the object read as a sheet of plate
    #      leaning against the pedestal, and the panel-line map on KIT_SHELL
    #      finished the job.
    #
    #      It is a moulded shell now: a closed section lofted up the rake, with
    #      the aft face convex on the centreline and the wings coming *forward*
    #      of it at the edges, which is the shape that says a body sits in it.
    #      A spine channel runs the height of the outer face, the section
    #      narrows and deepens toward the shoulders, and the whole thing closes
    #      into a rolled lip at the sides rather than meeting a boxed-on strip.
    BSHELL = [
        # t (0 at the pan, 1 at the shoulder), half-width, wrap depth, spine dip
        (0.00, 0.372, 0.052, 0.014),
        (0.16, 0.378, 0.060, 0.016),
        (0.34, 0.372, 0.070, 0.018),
        (0.52, 0.358, 0.078, 0.018),
        (0.70, 0.338, 0.082, 0.016),
        (0.86, 0.316, 0.074, 0.012),
        (0.96, 0.300, 0.058, 0.008),
        (1.00, 0.288, 0.040, 0.004),
    ]

    #  The shell's own section, evaluated anywhere on it. Everything soft on
    #  this seat is laid *against* the shell, so it has to be laid out from the
    #  shell rather than beside it -- see the upholstery block below for what
    #  happens when it is not.
    def shell_sect(t):
        """(half-width, wrap, spine) at any t, by interpolation of BSHELL."""
        t = max(0.0, min(1.0, t))
        for i in range(len(BSHELL) - 1):
            a, b = BSHELL[i], BSHELL[i + 1]
            if a[0] <= t <= b[0]:
                k = (t - a[0]) / (b[0] - a[0]) if b[0] > a[0] else 0.0
                return tuple(a[j] + (b[j] - a[j]) * k for j in (1, 2, 3))
        return BSHELL[-1][1:]

    def shell_y(t):
        return 0.575 + t * 1.020

    def shell_t(y):
        return (y - 0.575) / 1.020

    def shell_in(t, u):
        """z of the *inner* face of the back shell -- the side a body is on."""
        hw, wrap, spine = shell_sect(t)
        return ((0.255 + t * 0.185) + wrap * (1.0 - u * u)
                - spine * math.exp(-(u * 5.4) ** 2) - 0.026)

    #  and the rake of that face, which every pad on it has to share
    BACK_RAKE = math.atan2(shell_in(0.90, 0.0) - shell_in(0.10, 0.0),
                           shell_y(0.90) - shell_y(0.10))

    def back_ring(t, hw, wrap, spine, thick=0.026, grow=0.0):
        """One closed section of the back shell at parameter t.

           The outer arc is the aft face: deepest on the centreline, pulled
           forward toward the wings by `wrap`, with a channel of depth `spine`
           cut down the middle. The inner arc is the same curve `thick` forward
           of it, which is what makes the piece a shell with an edge instead of
           a plate with a strip glued along it."""
        y = 0.575 + t * 1.020
        zc = 0.255 + t * 0.185
        N = 13
        out, inn = [], []
        for i in range(N):
            u = -1.0 + 2.0 * i / (N - 1)
            x = u * (hw + grow)
            # aft face: convex at the centre, wings forward, spine channel
            z = zc + wrap * (1.0 - u * u) - spine * math.exp(-(u * 5.4) ** 2)
            out.append((x, y, Z0 + z))
            inn.append((x, y + 0.004, Z0 + z - thick))
        return out + inn[::-1]

    bx(-0.40, 0.520, -0.365, 0.40, 0.585, 0.335, DK)
    # The shell, wound explicitly rather than through loft2().
    #
    #      loft2() decides winding by pushing each face away from the ring's own
    #      centroid, which is correct for a closed section and wrong for a
    #      *curved shell*. This one is a 26 mm skin bowed 80 mm in its own
    #      thickness direction, so the section centroid lands 3 mm in front of
    #      the inner face rather than inside the material, and the entire
    #      occupant side of the seat back came out inside-out. A back face is
    #      culled, so it did not render as "wrong": from the seat and from
    #      anywhere forward of it the seat back was a hole with the corridor
    #      visible through it, and it survived because the pads that used to
    #      hide it were themselves 100 to 280 mm out of place.
    #
    #      Every face here has a facing that is known by construction, so it is
    #      stated. The loop is out[0..12] then inn[12..0], so inn[i] is at
    #      2*N-1-i.
    RINGS = [back_ring(t, hw, wr, sp) for (t, hw, wr, sp) in BSHELL]
    NB = len(BSHELL[0]) and 13
    for k in range(len(RINGS) - 1):
        A, C = RINGS[k], RINGS[k + 1]
        for i in range(NB - 1):
            face_dir(B, [A[i], A[i + 1], C[i + 1], C[i]], (0.0, 0.0, 1.0), DK)
            j, j1 = 2 * NB - 1 - i, 2 * NB - 2 - i
            face_dir(B, [A[j], A[j1], C[j1], C[j]], (0.0, 0.0, -1.0), DK)
        for (i, o, sgn) in ((0, 2 * NB - 1, -1.0), (NB - 1, NB, 1.0)):
            face_dir(B, [A[i], A[o], C[o], C[i]], (sgn, 0.0, 0.0), DK)
    for (R, want) in ((RINGS[0], (0.0, -1.0, 0.0)), (RINGS[-1], (0.0, 1.0, 0.0))):
        c = tuple(sum(p[j] for p in R) / len(R) for j in range(3))
        for i in range(len(R)):
            face_dir(B, [c, R[i], R[(i + 1) % len(R)]], want, DK)
    # the rolled lip: a bead run down each side edge of the shell, following the
    # shell's own outline rather than a box standing beside it
    for sx in (-1, 1):
        path, secs = [], []
        for (t, hw, wr, sp) in BSHELL:
            y = 0.575 + t * 1.020
            zc = 0.255 + t * 0.185
            path.append((sx * hw, y, Z0 + zc - 0.013))
            secs.append([(a * 0.016, b * 0.019) for (a, b) in rrect(1.0, 1.0, 0.5, 3)])
        sweep_profile(B, path, secs, DK, up=(0.0, 1.0, 0.0))

    # ---- what the shell carries on its back, which is the side of it the
    #      player walks past. A blank moulding is still a blank moulding.
    #      Six cooling louvres down the spine channel, in two columns.
    for k in range(6):
        t = 0.20 + k * 0.115
        y = 0.575 + t * 1.020
        zc = 0.255 + t * 0.185
        for sxx in (-1, 1):
            recess(B, (sxx * 0.088, y, Z0 + zc + 0.030), (0.0, 0.0, 1.0),
                   0.030, 0.008, 0.010, DK, r=0.003, up=(1.0, 0.0, 0.0))
    # harness pass-through slots at the shoulders, with moulded grommets, so the
    # straps in front of the shell have somewhere they come from
    #  On the surface, and above the top pad. These were at z 0.400 at y 1.398,
    #  which is 63 mm *inside* the shell's aft face and directly behind the top
    #  back pad: the straps came out of a grommet buried in the moulding.
    HARN_Y, HARN_Z = 1.575, 0.477
    for sxx in (-1, 1):
        recess(B, (sxx * 0.150, HARN_Y, Z0 + HARN_Z), (0.0, 0.0, 1.0),
               0.040, 0.014, 0.020, RUB, r=0.006, up=(1.0, 0.0, 0.0))
        lathe(B, (sxx * 0.150, HARN_Y, Z0 + HARN_Z + 0.004), (0.0, 0.0, 1.0),
              [(0.030, 0.0), (0.032, 0.004), (0.026, 0.010)], RAIL, 14,
              ref=(1.0, 0.0, 0.0), cap0=False)
    # a recline adjuster on the starboard cheek: a lathed wheel on a boss, which
    # is the one control on this object a hand actually turns
    lathe(B, (0.352, 0.700, Z0 + 0.262), (1.0, 0.0, 0.0),
          [(0.020, 0.0), (0.022, 0.008), (0.038, 0.012), (0.038, 0.026),
           (0.030, 0.030)], RAIL, 20, shape=knurl(14, 0.07), ref=(0.0, 1.0, 0.0))
    # and a stowage pocket on the back of the shell with a slate left in it —
    # the one thing on this piece that says somebody uses the chair
    pk = []
    for (t, sc) in ((0.0, 1.0), (0.55, 1.0), (1.0, 0.94)):
        y = 0.760 + t * 0.230
        z = 0.318 + t * 0.042 + (0.030 if t > 0.1 else 0.0)
        pk.append((0.0, y, Z0 + z))
    sweep_profile(B, pk, [[(a * 0.150 * s, b * 0.014) for (a, b) in rrect(1.0, 1.0, 0.35, 3)]
                          for s in (1.0, 1.0, 0.94)], RUB, up=(0.0, 1.0, 0.0))
    bx(-0.088, 0.905, 0.352, 0.076, 1.010, 0.368, DK)      # the slate in it
    bx(-0.076, 0.918, 0.368, 0.064, 0.996, 0.372, RAIL)
    # data plate, low on the aft face where a real one goes
    pad(B, (-0.130, 0.640, Z0 + 0.300), (0.0, 0.0, 1.0), 0.062, 0.024, 0.0035,
        AC, r=0.004, up=(1.0, 0.0, 0.0))
    #  top rail, capping the shell's own top edge (outer face z 0.476) rather
    #  than sitting 50 mm inside it, which is where the headrest bolts on
    bx(-0.375, 1.585, 0.400, 0.375, 1.618, 0.486, DK)

    # ---- upholstery.
    #
    #      Every pad on this seat was an axis-aligned box, and a box is what the
    #      review saw: "no upholstery, no cushion". What separates a cushion from
    #      a block is not softness in the abstract, it is three specific things,
    #      and all three are cheap — a *crowned* face, so the middle stands proud
    #      and the light falls off toward the edges; a piping bead round the
    #      perimeter where the panels are sewn together; and stitch lines across
    #      the face dividing it into flutes. Without those, foam and plate are
    #      the same solid.
    def cushion(cx, cy, cz, w, hh, d, axis='z', flutes=2, seam=None, crown=0.011,
                face=1, rake=0.0, warp=None):
        """A padded panel centred at (cx, cy, cz), `d` thick along `axis`.

           `w` and `hh` are half-extents in the two axes that are not `axis`.
           The section is swept along `axis` through five rings: a tucked back
           edge, two full-size rings, a tucked front edge and a crowned cap, so
           the silhouette is a rounded slab rather than a prism and the face it
           presents to the room is convex.

           `face` is which way that convex face points along `axis`, +1 or -1.
           It is not cosmetic: a pad whose crown points into the shell behind it
           is a pad fitted backwards, and every one on this seat was.

           `rake` tilts the pad about X through its own centre, so a pad on a
           leaning seat back leans with it instead of standing vertically
           against it.

           `warp(a, b)` returns an extra offset along `axis` for the point at
           local (a, b), which is how a flat-backed pad is bedded onto a shell
           that is a shallow bowl in section. Without it a pad wide enough to
           be a seat back touches its shell on one line and stands 30-70 mm off
           it everywhere else.

           It is weighted to zero by the front of the pad, and that is load
           bearing in two ways. It is right -- the *back* of a cushion takes
           the shape of what it is pressed against and its face does not, so a
           seat back should not reproduce the shell's spine channel in the foam
           you lean on. And it is necessary: the last two rings are 6 mm apart
           along the axis, so an unweighted 10 mm warp puts the crown cap
           *behind* the ring in front of it, the sweep reverses, and the front
           of every pad comes out inside-out -- which renders as a hole you can
           see the room through, because a back face is culled."""
        cs, sn = math.cos(rake), math.sin(rake)

        def place(a, b, off):
            if axis == 'z':
                p = (cx + a, cy + b, cz + off)
            elif axis == 'y':
                p = (cx + a, cy + off, cz + b)
            else:
                p = (cx + off, cy + a, cz + b)
            if rake:
                dy, dz = p[1] - cy, p[2] - cz
                p = (p[0], cy + dy * cs - dz * sn, cz + dy * sn + dz * cs)
            return p

        rings = []
        for (t, s, e) in ((-0.50, 0.86, 0.0), (-0.30, 0.99, 0.0), (0.22, 1.00, 0.0),
                          (0.44, 0.94, 0.0), (0.50, 0.72, crown * 0.55),
                          (0.50, 0.34, crown)):
            off = face * (d * t + e)
            wk = max(0.0, 0.5 - t)          # 1 at the tucked back edge, 0 at the crown
            rings.append([place(a * w * s, b * hh * s,
                                off + (wk * warp(a * w * s, b * hh * s) if warp else 0.0))
                          for (a, b) in rrect(1.0, 1.0, 0.30, 4)])
        loft2(B, rings, SEAT, cap0=True, cap1=True)
        # piping: a 5 mm bead following the widest ring, which is the seam the
        # panels are sewn on. It is also the only edge on the pad that returns a
        # continuous highlight, so it is what reads the shape at a distance.
        pp, ss = [], []
        base = rings[2]
        for p in list(base) + [base[0]]:
            pp.append(p)
            ss.append([(a * 0.0052, b * 0.0052) for (a, b) in rrect(1.0, 1.0, 0.5, 3)])
        upv = (0.0, 0.0, 1.0) if axis != 'z' else (0.0, 1.0, 0.0)
        sweep_profile(B, pp, ss, seam or RUB, up=upv, cap0=False, cap1=False)
        # flutes: stitch lines across the crowned face, dividing it into panels.
        # Swept rather than boxed, so they follow the rake and the warp instead
        # of cutting across a pad that is no longer axis-aligned.
        for k in range(1, flutes):
            f = -0.5 + k / flutes
            pth, sec = [], []
            for i in range(9):
                a = (-0.92 + 1.84 * i / 8.0) * w
                b = f * 2 * hh
                pth.append(place(a, b, face * (d * 0.47)
                                 + (warp(a, b) if warp else 0.0)))
                sec.append([(p * 0.0072, q * 0.0072)
                            for (p, q) in rrect(1.0, 1.0, 0.5, 3)])
            fup = (0.0, 0.0, 1.0) if axis == 'y' else (
                (0.0, 1.0, 0.0) if axis == 'z' else (1.0, 0.0, 0.0))
            sweep_profile(B, pth, sec, seam or RUB, up=fup, cap0=False, cap1=False)

    # ---- the pan, and a rim round it.
    #
    #      A pad laid on a flat plate stands proud of it and reads as a mat on a
    #      bench, which is half of "not flush with seat". The pan carries a
    #      raised rim on three sides now -- the seat back closes the fourth --
    #      so the squab sits down *in* the shell with a lit edge all the way
    #      round it instead of balancing on top of it.
    for (x0, z0, x1, z1) in ((-0.40, -0.360, -0.318, 0.320),
                             (0.318, -0.360, 0.40, 0.320),
                             (-0.318, -0.360, 0.318, -0.326)):
        bx(x0, 0.578, z0, x1, 0.632, z1, DK)
    # three flutes, the front one lower so the cushion looks sat on
    for i, (dp, ht) in enumerate(((0.19, 0.080), (0.19, 0.090), (0.18, 0.074))):
        z = 0.165 - i * 0.200
        cushion(0.0, 0.578 + ht * 0.5, Z0 + z, 0.302, dp * 0.5, ht, axis='y',
                flutes=3, crown=0.009, face=1)

    # ---- back padding, four segments tapering toward the shoulders.
    #
    #      Second pass, and this is the defect the owner filed: "seat cushions
    #      at wrong angle, not flush with seat". They were literally that. The
    #      pads were laid on a stack that leaned *forward* going up -- z fell
    #      40 mm a segment -- while the shell they belong to leans aft, 185 mm
    #      over its height. Measured against shell_in(), the gap behind them ran
    #      23 mm at the lumbar, 115 at the shoulder blade and 279 at the
    #      shoulder; both bolsters and the entire headrest assembly hung in open
    #      air a quarter of a metre in front of the seat, and the headrest posts
    #      reached nothing at all. From the walk-up it read as a stack of
    #      floating slabs beside a plate.
    #
    #      Nothing here is a literal any more. Every pad takes its height,
    #      width, rake and depth from the shell's own inner face, beds 5 mm into
    #      it so no light can get behind it, and carries the shell's lateral
    #      curve in its own back through `warp` -- a flat-backed pad 560 mm wide
    #      touches a bowl this shallow along one line and stands 30 mm off it at
    #      the edges, which is a gap you can see from the door.
    for t in (0.216, 0.432, 0.647, 0.863):
        hw, _, _ = shell_sect(t)
        d = 0.104
        cushion(0.0, shell_y(t) + 0.5 * d * math.sin(BACK_RAKE),
                Z0 + shell_in(t, 0.0) + 0.005 - 0.5 * d * math.cos(BACK_RAKE),
                hw - 0.095, 0.098, d, axis='z', flutes=3, crown=0.014,
                face=-1, rake=BACK_RAKE,
                warp=lambda a, b, _t=t, _hw=hw:
                    shell_in(_t, a / _hw) - shell_in(_t, 0.0))

    # ---- bolsters, wrapping the occupant. Two segments a side up the back, so
    #      they follow the shell's wings inboard as the section narrows toward
    #      the shoulder rather than running straight past them; one straight one
    #      is 44 mm outside the shell at the top and 44 inside it at the bottom.
    for sx in (-1, 1):
        for t in (0.26, 0.62):
            hw, _, _ = shell_sect(t)
            bxx = hw - 0.062
            d = 0.118
            cushion(sx * bxx, shell_y(t) + 0.5 * d * math.sin(BACK_RAKE),
                    Z0 + shell_in(t, bxx / hw) + 0.005
                    - 0.5 * d * math.cos(BACK_RAKE),
                    0.056, 0.176, d, axis='z', flutes=3, crown=0.012,
                    face=-1, rake=BACK_RAKE)
        # and the pan bolster, sitting on the tray rim
        cushion(sx * 0.290, 0.652, Z0 - 0.020, 0.048, 0.210, 0.104,
                axis='y', flutes=3, crown=0.008, face=1)

    # ---- headrest, standing on the shell's own top rail.
    #      It does not continue the back's rake: the shell's section flattens
    #      over the last tenth of its height, so a headrest carried on up at
    #      11 degrees ends 50 mm behind the shell it is bolted to.
    HR_Z, HR_RAKE = 0.418, 0.06
    for sx in (-1, 1):
        bx(sx * 0.052, 1.572, 0.408, sx * 0.082, 1.664, 0.442, RAIL)
    cushion(0.0, 1.700, Z0 + HR_Z, 0.172, 0.082, 0.104, axis='z', flutes=2,
            crown=0.012, face=-1, rake=HR_RAKE)
    for sx in (-1, 1):
        cushion(sx * 0.156, 1.700, Z0 + HR_Z - 0.030, 0.062, 0.058, 0.090,
                axis='x', flutes=2, crown=0.008, face=-sx, rake=HR_RAKE)

    # ---- five-point harness.
    #
    #      Webbing, not ribbon. The straps were flat quads with no section, so
    #      they had no edge to catch a highlight and no thickness where they
    #      pass over the bolster — which is the difference between a belt and a
    #      painted stripe. Each run is a swept 62 mm section with rolled edges
    #      and a raised stitch line down the middle, and each one ends in real
    #      hardware: a slider adjuster on the shoulder, an anchor plate at the
    #      lap, and a rotary release in the middle that is the one bright turned
    #      part on the whole seat.
    def webbing(pts, width, mat, up=(0.0, 0.0, 1.0)):
        secs = [[(a * width, b * 0.0035) for (a, b) in rrect(1.0, 1.0, 0.45, 3)]
                for _ in pts]
        sweep_profile(B, pts, secs, mat, up=up, cap0=True, cap1=True)
        # the stitch line, 1 mm proud along the centre of the run
        secs2 = [[(a * width * 0.42, b * 0.0016) for (a, b) in rrect(1.0, 1.0, 0.5, 3)]
                 for _ in pts]
        sweep_profile(B, [(p[0], p[1], p[2]) for p in pts], secs2, mat, up=up,
                      cap0=False, cap1=False)

    for sx in (-1, 1):
        # Shoulder run: out of the shell slot, over the shell's top edge, down
        # the front of the padding to the lap. Every station rides ~20 mm proud
        # of the pad face it crosses, which is now where the pads actually are.
        sh = [(sx * 0.150, HARN_Y, Z0 + HARN_Z - 0.006),
              (sx * 0.156, 1.548, Z0 + 0.392),
              (sx * 0.166, 1.470, Z0 + 0.320),
              (sx * 0.176, 1.300, Z0 + 0.284),
              (sx * 0.174, 1.120, Z0 + 0.250),
              (sx * 0.152, 0.940, Z0 + 0.214),
              (sx * 0.112, 0.780, Z0 + 0.140),
              (sx * 0.074, 0.686, Z0 + 0.010)]
        webbing(sh, 0.031, RUB, up=(1.0, 0.0, 0.0))
        # slider adjuster, two thirds of the way down where a hand reaches it
        lathe(B, (sx * 0.174, 1.120, Z0 + 0.250), (1.0, 0.0, 0.0),
              [(0.0, -0.006), (0.030, -0.006), (0.034, 0.0), (0.030, 0.006),
               (0.0, 0.006)], RAIL, 12, ref=(0.0, 1.0, 0.0))
        # lap run, and the anchor plate it bolts to on the shell
        lap = [(sx * 0.322, 0.664, Z0 - 0.030),
               (sx * 0.240, 0.658, Z0 - 0.062),
               (sx * 0.130, 0.652, Z0 - 0.082),
               (sx * 0.062, 0.650, Z0 - 0.086)]
        webbing(lap, 0.024, RUB, up=(0.0, 1.0, 0.0))
        pad(B, (sx * 0.330, 0.660, Z0 - 0.026), (sx * 1.0, 0.0, 0.0),
            0.030, 0.038, 0.010, DK, r=0.006, up=(0.0, 1.0, 0.0))
        hexbolt(B, (sx * 0.340, 0.660, Z0 - 0.026), (sx * 1.0, 0.0, 0.0),
                0.0068, RAIL, up=(0.0, 1.0, 0.0))
    # crotch strap, coming up out of the pan
    webbing([(0.0, 0.596, Z0 - 0.150), (0.0, 0.624, Z0 - 0.126),
             (0.0, 0.644, Z0 - 0.098)], 0.020, RUB, up=(1.0, 0.0, 0.0))
    # ---- the rotary release. Turned, anodised and the brightest small object
    #      on the seat: what a five-point harness is *for* is the one control in
    #      the middle of it, and the old one was two stacked boxes.
    lathe(B, (0.0, 0.664, Z0 - 0.096), (0.0, 0.30, -0.95),
          [(0.0, 0.0), (0.052, 0.0), (0.056, 0.008), (0.054, 0.020),
           (0.044, 0.026)], DK, 24, ref=(1.0, 0.0, 0.0))
    lathe(B, (0.0, 0.664, Z0 - 0.096), (0.0, 0.30, -0.95),
          [(0.0, 0.026), (0.036, 0.026), (0.038, 0.032), (0.030, 0.038)],
          AC, 24, shape=knurl(12, 0.055), ref=(1.0, 0.0, 0.0))
    # the four tongues plugged into it, at 45 degrees
    for a in (0.62, 2.52, 3.76, 5.66):
        ca, sa = math.cos(a), math.sin(a)
        B.box(ca * 0.052 - 0.011, 0.664 + sa * 0.052 - 0.011, Z0 - 0.106,
              ca * 0.052 + 0.011, 0.664 + sa * 0.052 + 0.011, Z0 - 0.086, RAIL)

    # ---- armrests, and the control heads on their forward ends.
    #
    #      This is the single highest-value object in the cockpit and it took
    #      three attempts to get into frame. The first pair ran z -5.25 to
    #      -4.83, entirely *behind* the seated eye at -5.26. The second reached
    #      -5.64 at x 0.328-0.424, which projects to 87% of the way to the
    #      right-hand edge at the seated down-pitch -- technically in frame,
    #      practically invisible, and indistinguishable from the pedestal it
    #      sits beside because it stood only 58 mm proud of it.
    #
    #      These run to z -5.82, a full 0.56 m forward of the eye, and come
    #      inboard to x 0.27 so the beam crosses the frame rather than grazing
    #      its corner. Projected at pitch -0.62 the forward inboard corner
    #      lands at 67% across and 58% down: a solid diagonal into the bottom
    #      corner on each side, which is what tells the eye it is sitting in
    #      something rather than floating in front of a wall of instruments.
    #
    #      The forward 0.21 m is a raised control head, and that is where the
    #      hands go: sidestick to starboard, throttle quadrant to port. Both
    #      are built in flight_controls().
    #      Fourth pass, and what changed is *value*, not position. The beam was
    #      already reaching z -5.82; the reason it did not read is that a
    #      156 mm ribbon of KIT_DARK topped with near-black rubber, lit only by
    #      the footwell flood, arrives in the corner of the frame as one flat
    #      dark band with a single bright line on it. The eye cannot find an
    #      armrest in that. It is 194 mm wide now, 62 mm deep in section rather
    #      than 50, and -- the part that actually does the work -- it is
    #      *outlined*: an anodised bead down the inboard edge as well as the
    #      outboard one, so the mass sits between two lit lines with a dark
    #      pad between them, at three separate values instead of one.
    #      Fifth pass, and this one is about *form*. Every earlier version was
    #      a rectangular prism with a rectangular pad on it and a rectangular
    #      bead down each edge -- three boxes, one silhouette, and no edge in
    #      any of them that returned a highlight. In grey clay it read as
    #      exactly what it was.
    #
    #      It is a swept section now: a cast beam with tumblehome and a rolled
    #      top, a crowned pad lofted on top of it, round beads, and legs that
    #      are lathed columns rather than blocks. Nothing in it has a
    #      rectangular cross-section and every edge is chamfered by weld_bevel.
    ZOFF = Z0

    def wz(z):
        return ZOFF + z

    for sx in (-1, 1):
        # legs: a lathed column on a splayed foot, tying the beam to the shell
        for (zl, hgt) in ((-0.130, 0.752), (-0.658, 0.754)):
            revolve(B, sx * 0.375, wz(zl), [
                (0.052, 0.585), (0.050, 0.596), (0.030, 0.614), (0.026, 0.660),
                (0.030, hgt - 0.028), (0.044, hgt - 0.008), (0.044, hgt)], DK, 12)
        # the beam. Superellipse k = 3.2: soft-cornered, so the top and the
        # outboard cheek each carry a continuous highlight instead of meeting
        # at a dead corner.
        beam(B, [(wz(-0.905), sx * 0.356, 0.768, 0.098, 0.034),
                 (wz(-0.845), sx * 0.356, 0.770, 0.102, 0.038),
                 (wz(-0.560), sx * 0.357, 0.769, 0.100, 0.037),
                 (wz(-0.180), sx * 0.355, 0.764, 0.096, 0.035),
                 (wz(0.160), sx * 0.350, 0.757, 0.088, 0.030)], DK, 14, 3.2)
        # crowned pad, lofted so its top is convex. Its lower half is buried in
        # the beam, which is what gives the join a soft shadow line rather than
        # a step.
        beam(B, [(wz(-0.690), sx * 0.356, 0.792, 0.044, 0.026),
                 (wz(-0.650), sx * 0.356, 0.796, 0.058, 0.036),
                 (wz(-0.300), sx * 0.357, 0.795, 0.060, 0.037),
                 (wz(0.060), sx * 0.354, 0.789, 0.057, 0.034),
                 (wz(0.140), sx * 0.352, 0.785, 0.048, 0.026)], RUB, 14, 2.4)
        # two creases across the pad, so it reads as something sat on rather
        # than a moulding
        for zc in (-0.400, -0.120):
            beam(B, [(wz(zc - 0.010), sx * 0.3565, 0.7945, 0.061, 0.038),
                     (wz(zc), sx * 0.3565, 0.7935, 0.059, 0.0355),
                     (wz(zc + 0.010), sx * 0.3565, 0.7945, 0.061, 0.038)],
                 RUB, 14, 2.4, cap0=False, cap1=False)
        # round beads down both edges: the outboard one catches the deck
        # practical, the inboard one separates the beam from the pedestal
        # behind it. Two lit lines with a dark pad between them is what makes
        # the mass legible in the corner of the frame.
        for (bxo, r) in ((0.452, 0.011), (0.258, 0.008)):
            beam(B, [(wz(-0.892), sx * bxo, 0.782, r, r),
                     (wz(0.146), sx * (bxo - 0.004), 0.772, r * 0.9, r * 0.9)],
                 RAIL, 8, 2.0)
        # ribs under the beam: the underside is in frame from a seated
        # down-look and a flat soffit 0.5 m from the lens is a blank plane
        for k in range(4):
            z = -0.760 + k * 0.230
            beam(B, [(wz(z), sx * 0.355, 0.726, 0.092, 0.016),
                     (wz(z + 0.028), sx * 0.355, 0.722, 0.098, 0.022),
                     (wz(z + 0.056), sx * 0.355, 0.726, 0.092, 0.016)],
                 DK, 10, 3.0)
        # ---- control head: a shaped casting with a raked nose, not a block.
        #      It is the nearest hard edge to the camera in the seated view,
        #      so it gets the most section variation of anything in the piece.
        beam(B, [(wz(-0.912), sx * 0.360, 0.784, 0.076, 0.036),
                 (wz(-0.892), sx * 0.358, 0.790, 0.096, 0.050),
                 (wz(-0.840), sx * 0.357, 0.794, 0.104, 0.058),
                 (wz(-0.740), sx * 0.357, 0.792, 0.104, 0.058),
                 (wz(-0.660), sx * 0.356, 0.786, 0.100, 0.050),
                 (wz(-0.630), sx * 0.356, 0.780, 0.098, 0.044)], DK, 14, 3.4)
        # anodised cap on the head, following the same outline inboard
        beam(B, [(wz(-0.886), sx * 0.358, 0.812, 0.088, 0.036),
                 (wz(-0.830), sx * 0.357, 0.816, 0.095, 0.040),
                 (wz(-0.690), sx * 0.357, 0.815, 0.095, 0.040),
                 (wz(-0.646), sx * 0.356, 0.808, 0.088, 0.034)], RAIL, 14, 3.6)
        # parting line round the head, 4 mm proud: scale-two detail, the join
        # between the casting and its cover plate
        beam(B, [(wz(-0.884), sx * 0.357, 0.792, 0.100, 0.054),
                 (wz(-0.876), sx * 0.357, 0.792, 0.104, 0.058),
                 (wz(-0.868), sx * 0.357, 0.792, 0.100, 0.054)],
             DK, 14, 3.4, cap0=False, cap1=False)
        # a rank of switch caps on the head's inboard cheek, each a lathed
        # button on a shaped base rather than a rectangle laid on a rectangle
        beam(B, [(wz(-0.874), sx * 0.256, 0.818, 0.010, 0.022),
                 (wz(-0.700), sx * 0.256, 0.816, 0.010, 0.022)], DK, 10, 2.6)
        for k in range(4):
            zc = wz(-0.852 + k * 0.040)
            cyl_x(B, 0.818, zc, sx * 0.246, sx * 0.262, 0.011,
                  AC if k == 1 else RAIL, 10)
        # thumb switches along the pad's inboard edge: lathed caps with a
        # pointer, so a glance reads them as rotaries and not as tiles
        for k in range(4):
            zc = wz(-0.500 + k * 0.062)
            revolve(B, sx * 0.322, zc, [(0.020, 0.806), (0.019, 0.816),
                                        (0.015, 0.822), (0.014, 0.828)],
                    AC if k == 2 else RAIL, 24, knurl(8, 0.09))
    # ---- and the two things that are NOT the same to port and starboard.
    #      A stowed slate to starboard; a headset on its hook to port. Small,
    #      but they are the closest objects in the frame to the eye, so they
    #      carry more than their size.
    #      Sat 4 mm clear of the pad, not on it: coplanar with the surface it
    #      rests on is a z-fight, not a joint.
    bx(0.300, 0.836, 0.020, 0.420, 0.848, 0.140, DK)        # slate, stbd
    bx(0.312, 0.848, 0.032, 0.408, 0.862, 0.128, RAIL)
    bx(0.330, 0.862, 0.048, 0.390, 0.870, 0.112, AC)
    bx(-0.416, 0.836, -0.030, -0.302, 0.922, 0.075, DK)     # headset hook, port
    bx(-0.404, 0.922, -0.018, -0.314, 0.934, 0.062, RAIL)
    bx(-0.396, 0.862, -0.006, -0.322, 0.920, 0.050, RUB)
    return B.obj(name)


# -------------------------------------------------------- stick and throttle
def flight_controls(name='cp_controls'):
    """HOTAS: sidestick to starboard, throttle quadrant to port.

       Both stand on the control heads at the forward ends of the armrests,
       0.40-0.44 m ahead of the seated eye, which is where a hand actually
       falls. Two things follow from that split and both matter.

       It is the layout every single-seat aircraft since the 1970s has used --
       right hand flies, left hand sets power -- so it reads as a flight deck
       before a single label is legible.

       And it is the one asymmetry in the cockpit that nobody can mistake for
       a mistake. The interior measured 63-68% of central pixels within six
       levels of their own mirror image, which the review called the loudest
       "generated, not built" signal in the game. A pair of identical sticks
       was part of that. A stick and a throttle cannot be.

       Heights are set against one sight line: the bottom edge of the outboard
       display sits about 23 degrees below the eye horizon at the azimuth the
       grip occupies, so the grip tops stop at y 1.078 -- four degrees clear.
       Half a centimetre higher and the stick eats the corner of the screen it
       is meant to sit beneath."""
    B = Build()
    DK, RAIL, AC, RUB = (MI['KIT_DARK'], MI['KIT_RAIL'],
                         MI['KIT_ACCENT'], MI['KIT_RUBBER'])
    SH = MI['KIT_SHELL']

    # ------------------------------------------------------------ sidestick
    #
    # Modelled as the object actually is, from the bottom up: a lathed pivot
    # housing, a concertina boot, a moulded pistol grip with the finger grooves
    # *cut into the form*, a trigger inside a wrapped guard, and a lobed hat
    # switch. Nothing in it has a rectangular section.
    #
    # Three earlier versions failed the same way and it is worth being exact
    # about why, because "add more segments" was the wrong answer twice. Four
    # 90 mm boxes read as a radiator. Eight 11 mm boxes read as a finer
    # radiator. The failure is not the step size: a stack of axis-aligned boxes
    # has a staircase silhouette at any resolution, and no lighting recovers a
    # silhouette. Grey clay says so in one frame.
    #
    # The fourth failed on *proportion*, which grey clay also says in one
    # frame: a 172 mm base flange under a 90 mm grip is a chess pawn. Real
    # numbers, and they are not negotiable if it is to read as something a hand
    # closes around -- flange 92 mm across, boot 76 tapering to 46, grip 111 mm
    # tall and 54 wide, raked 22 mm aft and 15 mm inboard over its length.
    SX, SZ = 0.352, -5.735

    # pivot housing on the control head: flange, shoulder, throat
    revolve(B, SX, SZ, [(0.000, 0.856), (0.046, 0.856), (0.048, 0.860),
                        (0.046, 0.866), (0.040, 0.872), (0.034, 0.877)], DK, 16)
    for i in range(6):                       # hex-head fasteners round it
        a = math.pi / 6 + i * math.pi / 3
        revolve(B, SX + math.cos(a) * 0.037, SZ + math.sin(a) * 0.037,
                [(0.0065, 0.858), (0.0065, 0.8635), (0.004, 0.866)], RAIL, 6)
    # concertina boot. Three folds, tapering hard: the ridges give the darkest
    # part of the assembly four lit edges and say the thing pivots. It must
    # taper *below* the grip's widest point or it dominates the silhouette --
    # the first cut flared wider than the grip and the whole assembly read as a
    # chess pawn.
    BOOT = [(0.032, 0.872)]
    for k in range(3):
        y = 0.878 + k * 0.0135
        BOOT += [(0.034 - k * 0.0038, y), (0.025 - k * 0.0026, y + 0.0068)]
    BOOT += [(0.021, 0.9195), (0.020, 0.923)]
    revolve(B, SX, SZ, BOOT, RUB, 16, cap0=False, cap1=False)
    # machined collar where the boot clamps to the column
    revolve(B, SX, SZ, [(0.020, 0.921), (0.023, 0.925), (0.023, 0.932),
                        (0.020, 0.936)], RAIL, 14, cap0=False, cap1=False)

    # ---- the grip.
    #      Three things make it a pistol grip rather than a bottle.
    #
    #      The centreline rakes 41 mm aft and 15 mm inboard over 116 mm of
    #      height while the depth grows, so the top overhangs into a heel the
    #      palm sits on. A grip whose centreline is vertical is a rod however
    #      well its section is shaped.
    #
    #      The finger grooves are cut into the forward face *as a function of
    #      height*. The first cut ran them round the circumference instead --
    #      three grooves side by side across the front -- which is not what a
    #      hand does, and at sixteen segments the forward face is five of them
    #      so the modulation was undersampled into nothing anyway. They are
    #      four scallops stacked up the front now, resolved by twenty-two
    #      stations, and they are the feature that reads first.
    #
    #      And the palm pad's amplitude fades to zero at both ends, so it
    #      merges into the moulding. Held constant it stood proud with a hard
    #      lip all the way round and read as a fin bolted to the back.
    FRONT = -math.pi / 2                     # -Z, the direction the fingers face
    KEY = [(0.00, 0.934, 0.3520, -5.7360, 0.0180, 0.0230),
           (0.12, 0.948, 0.3519, -5.7345, 0.0230, 0.0285),
           (0.30, 0.966, 0.3513, -5.7300, 0.0260, 0.0320),
           (0.48, 0.988, 0.3500, -5.7240, 0.0270, 0.0340),
           (0.64, 1.006, 0.3480, -5.7172, 0.0275, 0.0350),
           (0.76, 1.020, 0.3456, -5.7104, 0.0270, 0.0360),
           (0.87, 1.032, 0.3424, -5.7024, 0.0255, 0.0380),
           (0.94, 1.040, 0.3396, -5.6962, 0.0220, 0.0380),
           (0.98, 1.046, 0.3376, -5.6942, 0.0160, 0.0310),
           (1.00, 1.050, 0.3366, -5.6950, 0.0100, 0.0200)]

    def at_t(t):
        t = min(max(t, 0.0), 1.0)
        for a, b in zip(KEY, KEY[1:]):
            if a[0] <= t <= b[0]:
                k = (t - a[0]) / (b[0] - a[0] or 1.0)
                return tuple(a[1 + i] + (b[1 + i] - a[1 + i]) * k for i in range(5))
        return KEY[-1][1:]

    GRIP = []
    for i in range(22):
        t = i / 21.0
        y, cx, cz, w, d = at_t(t)
        gd = 0.0
        if 0.06 < t < 0.78:
            u = (t - 0.06) / 0.72
            gd = 0.21 * (0.5 - 0.5 * math.cos(2 * math.pi * 3.0 * u)) \
                * math.sin(math.pi * u) ** 0.5
        GRIP.append((y, cx, cz, w, d,
                     scallops(1, gd, FRONT, 1.30) if gd > 1e-4 else None))
    tube_section(B, GRIP, SH, seg=20, k=2.2)
    # parting line: the join between the two halves of the moulding, 1.5 mm
    # proud, all the way round. Scale-two detail, and it is what stops the grip
    # reading as a single extruded lump.
    PL = []
    for (dt, s) in ((-0.014, 1.000), (0.0, 1.045), (0.014, 1.000)):
        y, cx, cz, w, d = at_t(0.50 + dt)
        PL.append((y, cx, cz, w * s, d * s, None))
    tube_section(B, PL, SH, seg=20, k=2.2, cap0=False, cap1=False)
    # palm pad, wrapped round the aft face, fading into the moulding at both ends
    HEEL = []
    for i in range(10):
        t = i / 9.0
        y, cx, cz, w, d = at_t(0.16 + 0.66 * t)
        HEEL.append((y, cx, cz, w * 1.004, d * 1.004,
                     scallops(1, -0.11 * math.sin(math.pi * t), math.pi / 2, 1.20)))
    tube_section(B, HEEL, RUB, seg=20, k=2.2, cap0=False, cap1=False)
    # crown and hat switch: an eight-lobed rocker on a domed pedestal, which is
    # what a coolie hat actually looks like
    revolve(B, 0.3372, -5.6946, [(0.013, 1.046), (0.015, 1.050),
                                 (0.014, 1.055)], DK, 22)
    # Segment count against tooth count, not against size. At seg 8 with an
    # 8-tooth knurl every facet landed on one tooth, which cancels the ripple
    # exactly and leaves a plain octagon -- the review read this cap as "a
    # clean hexagon at 1:1". Three facets per tooth is the floor.
    revolve(B, 0.3372, -5.6946, [(0.000, 1.054), (0.012, 1.055), (0.014, 1.060),
                                 (0.010, 1.065), (0.004, 1.067)], RAIL, 24,
            knurl(8, 0.16))
    # ---- trigger, in a wrapped guard.
    #      Both are swept arcs in the grip's own vertical plane, with the plane
    #      normal handed to sweep_path so the section cannot twist. A guard
    #      made of two boxes is the single feature that makes a stick look
    #      printed rather than machined.
    YZ = (1.0, 0.0, 0.0)
    sweep_path(B, [(0.3495, 0.9660, -5.7590), (0.3495, 0.9670, -5.7700),
                   (0.3495, 0.9790, -5.7760), (0.3495, 0.9940, -5.7720),
                   (0.3495, 1.0040, -5.7560), (0.3495, 1.0070, -5.7470)],
               0.0048, AC, 8, up=YZ)
    sweep_path(B, [(0.3495, 1.0020, -5.7500), (0.3495, 0.9920, -5.7590),
                   (0.3495, 0.9820, -5.7610)],
               [0.0048, 0.0066, 0.0050], RAIL, 8, up=YZ)
    # thumb cluster on the inboard cheek: two lathed buttons, the upper one
    # with a witness mark
    for (y, zc, m) in ((1.0200, -5.7110, RAIL), (0.9950, -5.7220, AC)):
        cyl_x(B, y, zc, 0.3200, 0.3275, 0.0078, m, 10)
        cyl_x(B, y, zc, 0.3165, 0.3200, 0.0056, DK, 8)
    # pinky paddle: a curved blade, low and aft
    sweep_path(B, [(0.3480, 0.9420, -5.7180), (0.3455, 0.9500, -5.7110),
                   (0.3430, 0.9620, -5.7070)],
               [0.0055, 0.0075, 0.0060], RAIL, 8, up=YZ)

    # ------------------------------------------------- throttle quadrant, port
    #
    # Two shaped levers running in a slotted detent plate, with the linkage
    # visible under them. The quadrant's job is to be legibly *not* a stick
    # from the seat at a glance -- it is the one asymmetry in this cockpit
    # nobody can mistake for a mistake -- so every feature is chosen for
    # silhouette: the slot, the two knobs at different heights, the friction
    # wheel on its lateral axle.
    TX, TZ = -0.352, -5.790
    SL0, SL1 = TX - 0.028, TX + 0.028          # slot in x
    GZ0, GZ1 = TZ - 0.078, TZ + 0.084          # slot in z
    PY = 0.920                                  # top of the detent plate

    # body: swept fore-and-aft with a rolled outboard cheek and tumblehome, so
    # the outline in plan is a shaped casting rather than a rectangle
    beam(B, [(TZ - 0.108, TX + 0.004, 0.880, 0.070, 0.026),
             (TZ - 0.092, TX,         0.880, 0.086, 0.030),
             (TZ - 0.030, TX - 0.002, 0.882, 0.094, 0.034),
             (TZ + 0.046, TX - 0.002, 0.882, 0.094, 0.034),
             (TZ + 0.092, TX + 0.002, 0.879, 0.086, 0.030),
             (TZ + 0.106, TX + 0.006, 0.877, 0.068, 0.024)], DK, 16, 3.0)
    # the linkage, seen through the open inboard cheek: a lateral pivot shaft
    # on two bearing blocks, and a bell crank on it
    cyl_x(B, 0.878, TZ - 0.020, TX - 0.062, TX + 0.062, 0.009, RAIL, 10)
    for xb in (TX - 0.062, TX + 0.054):
        beam(B, [(TZ - 0.034, xb + 0.004, 0.874, 0.010, 0.020),
                 (TZ - 0.006, xb + 0.004, 0.874, 0.010, 0.020)], DK, 8, 2.4)
    rod(B, (TX - 0.030, 0.868, TZ + 0.018), (TX - 0.030, 0.884, TZ + 0.044),
        0.007, 0.005, DK, 8)

    # ---- the detent plate.
    #      Two shaped rails with rounded ends either side of the slot, plus a
    #      fore and aft closer. Rectangles here read as a grille laid on a lid;
    #      a shaped outline with a rolled edge reads as a gate that was cut for
    #      the lever to run in.
    def gate_rail(x0, x1, mat):
        p = []
        N = 8
        for i in range(N + 1):
            a = -math.pi / 2 + math.pi * i / N
            p.append((0.5 * (x0 + x1) + math.cos(a) * (x1 - x0) * 0.5,
                      GZ1 + 0.014 + math.sin(a) * 0.016))
        for i in range(N + 1):
            a = math.pi / 2 + math.pi * i / N
            p.append((0.5 * (x0 + x1) + math.cos(a) * (x1 - x0) * 0.5,
                      GZ0 - 0.014 + math.sin(a) * 0.016))
        plate_slab(B, p, 0.906, PY, mat, rolled=0.0035)
    gate_rail(SL0 - 0.026, SL0, RAIL)
    gate_rail(SL1, SL1 + 0.026, RAIL)
    plate_slab(B, [(SL0, GZ0 - 0.030), (SL1, GZ0 - 0.030),
                   (SL1 - 0.006, GZ0), (SL0 + 0.006, GZ0)], 0.906, PY, DK, 0.003)
    plate_slab(B, [(SL0 + 0.006, GZ1), (SL1 - 0.006, GZ1),
                   (SL1, GZ1 + 0.030), (SL0, GZ1 + 0.030)], 0.906, PY, DK, 0.003)
    # slot walls and floor
    for (a, c) in ((SL0 - 0.004, SL0), (SL1, SL1 + 0.004)):
        B.box(a, 0.884, GZ0, c, PY, GZ1, DK)
    B.box(SL0 - 0.004, 0.878, GZ0 - 0.004, SL1 + 0.004, 0.884, GZ1 + 0.004, DK)
    # detent teeth, milled into the port rail
    for k in range(7):
        z = GZ0 + 0.014 + k * 0.021
        beam(B, [(z, SL0 - 0.012, PY + 0.003, 0.011, 0.005),
                 (z + 0.006, SL0 - 0.012, PY + 0.005, 0.012, 0.007),
                 (z + 0.012, SL0 - 0.012, PY + 0.003, 0.011, 0.005)],
             DK, 8, 2.6)

    # ---- the levers.
    #      A tapering blade arm with a spine down it, rising to a knob that is
    #      swollen on the palm side. Different heights, different travel,
    #      different cap material: they must not read as one control doubled.
    for i, (lx, ly, lz, kd, mbody, mcap) in enumerate(
            ((TX - 0.017, 0.986, -0.058, 0.030, DK, AC),
             (TX + 0.017, 0.958, -0.014, 0.026, RUB, RAIL))):
        za = TZ + lz
        # The arm is a *blade*: 20 mm across the hand, 38 mm fore-and-aft. The
        # first cut had it thicker in x than in z, which is a post, and a post
        # under a ball is a gear lever out of a car.
        tube_section(B, [(0.884, lx, za + 0.040, 0.011, 0.021, None),
                         (0.916, lx, za + 0.028, 0.010, 0.019, None),
                         (0.952, lx, za + 0.012, 0.009, 0.017, None),
                         (ly - 0.008, lx, za + 0.002, 0.008, 0.015, None)],
                     RAIL if i else DK, seg=10, k=3.0)
        # a rib down the forward edge of the blade, and a lightening scallop
        # cut into its cheek: scale-two detail on a part 0.5 m from the lens
        tube_section(B, [(0.906, lx, za + 0.030, 0.013, 0.005, None),
                         (ly - 0.020, lx, za + 0.005, 0.011, 0.004, None)],
                     DK, seg=6, k=2.2)
        # ---- the knob.
        #      Elongated fore-and-aft, flattened across the hand, cut away
        #      under the front for the fingers and swollen aft where the heel
        #      of the palm bears. A sphere on a stick is a gear knob; this is
        #      the shape a hand pushing a lever actually leaves.
        palm = scallops(1, -0.20, math.pi / 2, 1.25)
        tube_section(B, [(ly - 0.014, lx, za + 0.004, kd * 0.50, kd * 0.62, palm),
                         (ly + 0.000, lx, za - 0.002, kd * 0.82, kd * 1.16, palm),
                         (ly + 0.016, lx, za - 0.010, kd * 0.92, kd * 1.38, palm),
                         (ly + 0.032, lx, za - 0.018, kd * 0.88, kd * 1.32, palm),
                         (ly + 0.044, lx, za - 0.026, kd * 0.70, kd * 1.02, palm),
                         (ly + 0.052, lx, za - 0.032, kd * 0.40, kd * 0.58, palm)],
                     mbody, seg=16, k=2.4)
        # thumb ledge on the aft shoulder, where the hand actually pushes
        tube_section(B, [(ly + 0.030, lx, za + kd * 0.86, kd * 0.62, 0.006, None),
                         (ly + 0.038, lx, za + kd * 1.10, kd * 0.72, 0.008, None),
                         (ly + 0.044, lx, za + kd * 1.30, kd * 0.56, 0.006, None)],
                     mcap, seg=10, k=2.8)
        # index-finger lip under the nose of the knob. Kept short: at kd*1.5 it
        # ran past the nose and the knob grew a beak.
        tube_section(B, [(ly + 0.002, lx, za - kd * 0.98, kd * 0.62, 0.006, None),
                         (ly + 0.010, lx, za - kd * 1.20, kd * 0.50, 0.007, None)],
                     DK, seg=8, k=2.6)

    # friction wheel on a lateral axle: a knurled rim on a hub, which is what
    # the part is, and the only genuinely circular silhouette on the quadrant
    cyl_x(B, 0.938, TZ + 0.066, TX - 0.114, TX - 0.098, 0.032, RAIL, 16)
    for (xa, xb, r, m) in ((TX - 0.098, TX - 0.092, 0.032, RAIL),
                           (TX - 0.092, TX - 0.086, 0.018, DK)):
        cyl_x(B, 0.938, TZ + 0.066, xa, xb, r, m, 14)
    beam(B, [(TZ + 0.042, TX - 0.086, 0.914, 0.012, 0.020),
             (TZ + 0.090, TX - 0.086, 0.914, 0.012, 0.020)], DK, 8, 2.6)
    # wire-locked cut-off gate on the outboard shoulder
    beam(B, [(TZ - 0.100, TX + 0.086, 0.930, 0.016, 0.026),
             (TZ - 0.074, TX + 0.090, 0.936, 0.018, 0.030),
             (TZ - 0.046, TX + 0.086, 0.930, 0.016, 0.026)], AC, 10, 2.8)
    rod(B, (TX + 0.088, 0.952, TZ - 0.088), (TX + 0.088, 0.966, TZ - 0.056),
        0.005, 0.004, RAIL, 8)
    # a knurled rotary with a pointer and a witness mark, and two guarded
    # buttons, on the quadrant's aft shoulder
    revolve(B, TX - 0.044, TZ + 0.078, [(0.021, PY - 0.006), (0.022, PY),
                                        (0.020, PY + 0.018), (0.018, PY + 0.025),
                                        (0.012, PY + 0.029)], RAIL, 18,
            knurl(18, 0.075))
    # pointer, and the witness mark it lines up against
    beam(B, [(TZ + 0.058, TX - 0.044, PY + 0.023, 0.004, 0.004),
             (TZ + 0.050, TX - 0.044, PY + 0.021, 0.003, 0.003)], AC, 6, 2.0)
    B.box(TX - 0.046, PY - 0.008, TZ + 0.106, TX - 0.038, PY - 0.004, TZ + 0.112, AC)
    for k, m in enumerate((AC, RAIL)):
        revolve(B, TX + 0.024 + k * 0.030, TZ + 0.074,
                [(0.016, PY - 0.002), (0.016, PY + 0.008), (0.012, PY + 0.014)],
                m, 12)
        revolve(B, TX + 0.024 + k * 0.030, TZ + 0.074,
                [(0.020, PY + 0.016), (0.020, PY + 0.022)], DK, 12,
                cap0=False, cap1=False)

    # ---- rudder pedals: a cast footrest on a swinging arm, on a torque tube.
    #      Three boxes before, and although they sit deep in the footwell they
    #      are in frame at every down-pitch the player uses.
    cyl_x(B, 0.168, -5.700, -0.330, 0.330, 0.020, DK, 12)
    for sx in (-1, 1):
        for (xa, xb) in ((sx * 0.086, sx * 0.104), (sx * 0.300, sx * 0.318)):
            cyl_x(B, 0.168, -5.700, xa, xb, 0.030, RAIL, 12)
        # swinging arm
        sweep_path(B, [(sx * 0.200, 0.168, -5.700), (sx * 0.200, 0.230, -5.742),
                       (sx * 0.200, 0.292, -5.766)],
                   [0.024, 0.020, 0.017], DK, 10)
        # footrest: a shaped pan with a raised heel stop and a ribbed tread
        tube_section(B, [(0.288, sx * 0.200, -5.772, 0.076, 0.010, None),
                         (0.318, sx * 0.200, -5.766, 0.084, 0.013, None),
                         (0.362, sx * 0.200, -5.756, 0.080, 0.012, None),
                         (0.386, sx * 0.202, -5.748, 0.066, 0.009, None)],
                     DK, seg=12, k=3.4)
        for k in range(4):
            beam(B, [(-5.7690 + k * 0.0135, sx * 0.200, 0.300 + k * 0.021,
                      0.070, 0.004),
                     (-5.7655 + k * 0.0135, sx * 0.200, 0.302 + k * 0.021,
                      0.072, 0.006),
                     (-5.7620 + k * 0.0135, sx * 0.200, 0.300 + k * 0.021,
                      0.070, 0.004)], RUB, 8, 2.6)
        # heel cup below the pan
        tube_section(B, [(0.252, sx * 0.200, -5.780, 0.058, 0.010, None),
                         (0.286, sx * 0.200, -5.774, 0.070, 0.012, None)],
                     DK, seg=12, k=3.0)
    return B.obj(name)


# --------------------------------------------------------------- overhead
def overhead_panel(name='cp_overhead'):
    """Breaker and systems console, set into the roof over the pilot.

       Two things were wrong with it and they were the same thing twice.

       It hung 0.40 m below the roof and reached forward to z -6.86, which from
       the seated eye put its leading edge 13 degrees up -- so it capped the
       top quarter of the windscreen, and the measured sky in the forward
       frame's top 25% was 11-25%. A cockpit is a room you look *out* of. The
       console is at the roof line now, from z -4.58 to -6.36, and at the
       seated rest pitch its forward lip sits past the top edge of the frame:
       you look up to read it, which is what you do in a real aeroplane.

       And it was 96 extruded rectangles -- 4x7 identical guard boxes with an
       identical sub-box in each, plus 15 more. One family of hardware in a
       regular grid is a coffered ceiling tile, not a panel. There are four
       families here: bat toggles on hex bezels with locking rings, guarded
       switches under wire cages and hinged covers (two standing open), knurled
       rotaries with moulded pointers and detent arcs, and breakers with rocker
       caps and white trip bands -- three of them tripped. The row pitch varies
       between groups so the eye counts functional blocks instead of a grid."""
    B = Build()
    DK, RAIL, AC, HULL = (MI['KIT_DARK'], MI['KIT_RAIL'],
                          MI['KIT_ACCENT'], MI['KIT_HULL'])
    ZA, ZB = -4.58, -6.22

    def at(t):
        z = ZA + (ZB - ZA) * t
        return (z, nose_at(z)[1] - 0.092, 1.00 - 0.20 * t)

    # ---- the casting. A closed section swept along the roof line, with two
    #      sunk equipment bays either side of a centre rib and a coved cheek
    #      running out to the roof. Every fitting below stands in one of the
    #      bays, so the hardware is *in* the console rather than on it.
    N = 17
    path, sects = [], []
    for k in range(N + 1):
        z, y, w = at(k / N)
        path.append((0.0, y, z))
        e = 1.0 - 0.10 * math.sin(math.pi * k / N)     # a slight barrel in plan
        W = w * e
        # One wide sunk bay with a low centre rib, not two narrow ones: a
        # fitting has to stand on a flat floor, and a bay narrow enough that
        # half the hardware lands on its drafted wall is worse than no bay.
        sects.append([
            (W, 0.150), (W * 0.995, 0.052), (W * 0.965, 0.012), (W * 0.90, -0.002),
            (W * 0.845, -0.012), (W * 0.795, -0.054), (W * 0.060, -0.058),
            (0.0, -0.032), (-W * 0.060, -0.058), (-W * 0.795, -0.054),
            (-W * 0.845, -0.012), (-W * 0.90, -0.002), (-W * 0.965, 0.012),
            (-W * 0.995, 0.052), (-W, 0.150),
            (-W * 0.72, 0.208), (0.0, 0.232), (W * 0.72, 0.208)])
    sweep_profile(B, path, sects, DK)

    zf, yf, wf = at(1.0)
    # ---- the forward lip: a rolled nose with the wash lamp in a channel
    #      behind it. Interior.js puts the practical in that channel.
    lip_path = [(-wf * 0.98, yf + 0.004, zf), (0.0, yf, zf - 0.012),
                (wf * 0.98, yf + 0.004, zf)]
    lip_sect = [[(0.020, 0.052), (0.030, 0.030), (0.032, -0.006),
                 (0.018, -0.030), (-0.008, -0.036), (-0.024, -0.024),
                 (-0.026, 0.006), (-0.020, 0.030), (-0.026, 0.046),
                 (-0.010, 0.056)]] * 3
    sweep_profile(B, lip_path, lip_sect, DK, up=(0.0, 1.0, 0.0))
    for k in range(7):
        px = -wf * 0.80 + k * wf * 0.267
        hexbolt(B, (px, yf - 0.026, zf + 0.028), (0.0, -0.98, 0.20), 0.0060,
                RAIL, up=(1.0, 0.0, 0.0))

    # ---- where a fitting goes. The bay floors are at -0.049 in the section,
    #      the face normal points down and slightly aft, and everything below
    #      is placed through this so a switch sits on the surface it is in.
    def bay(t, s, dn=0.0):
        """s in [-1, 1] across the console; -1 is the port bay's outer edge."""
        z, y, w = at(t)
        e = 1.0 - 0.10 * math.sin(math.pi * t)
        x = s * w * e * 0.72
        return (x, y - 0.055 - dn, z)

    NRM = (0.0, -0.981, 0.196)
    LAT = (1.0, 0.0, 0.0)

    # group 1, aft: the breaker farm. Port bay only, on a 46 mm pitch, and
    # three of them tripped -- a panel where every state is the same is a
    # texture.
    for r in range(4):
        for c in range(5):
            t = 0.075 + r * 0.052
            p = bay(t, -0.94 + c * 0.30)
            breaker(B, p, NRM, DK, HULL, AC, up=LAT, s=1.0,
                    tripped=(r * 5 + c) in (3, 11, 16))
    pad(B, bay(0.245, -0.50), NRM, 0.150, 0.013, 0.004, AC, r=0.004, up=LAT)

    # starboard bay, same group: two gauges in a common surround and a rotary.
    for (tg, rg) in ((0.098, 0.058), (0.176, 0.058)):
        gauge(B, bay(tg, 0.62), NRM, rg, DK, HULL, RAIL, up=LAT,
              ang=-1.4 + tg * 6.0)
    rotary(B, bay(0.245, 0.66), NRM, DK, RAIL, AC, up=LAT, s=0.92, ang=0.6)
    pad(B, bay(0.300, 0.60), NRM, 0.090, 0.012, 0.004, AC, r=0.004, up=LAT)

    # group 2, middle: guarded switches. Wider pitch than group 1 so the two
    # groups read as two jobs. Two covers stand open, one cage carries a
    # switch that is up while its neighbours are down.
    for c in range(6):
        s = -0.92 + c * 0.368
        toggle(B, bay(0.375, s), NRM, DK, RAIL, AC, up=LAT, s=1.1,
               lean=(-0.55 if c in (1, 4) else 0.42))
        guard_cage(B, bay(0.375, s, -0.002), NRM, 0.026, 0.019, RAIL, up=LAT)
    for c in range(4):
        s = -0.78 + c * 0.52
        toggle(B, bay(0.452, s), NRM, DK, RAIL, AC, up=LAT, s=1.1, lean=0.30)
        if c in (0, 2):
            flip_cover(B, bay(0.452, s, -0.004), NRM, 0.026, 0.019, AC, RAIL,
                       up=LAT, ang=0.62 if c == 0 else 0.44)
        else:
            flip_cover(B, bay(0.452, s, -0.004), NRM, 0.026, 0.019, AC, RAIL,
                       up=LAT, ang=0.06)
    pad(B, bay(0.510, -0.30), NRM, 0.170, 0.013, 0.004, AC, r=0.004, up=LAT)

    # group 3, forward: a bare toggle rank at a third pitch, with a rotary
    # selector at each end, and the master placard on the lip.
    for c in range(8):
        s = -0.90 + c * 0.257
        toggle(B, bay(0.600 + (c % 2) * 0.040, s), NRM, DK, RAIL, AC,
               up=LAT, s=0.95, lean=(-0.48 if c in (2, 5, 6) else 0.36))
    for (tt, ss, ag) in ((0.700, -0.72, -0.8), (0.700, 0.72, 1.1)):
        rotary(B, bay(tt, ss), NRM, DK, RAIL, AC, up=LAT, s=1.0, ang=ag)
    for c in range(6):
        s = -0.80 + c * 0.32
        breaker(B, bay(0.790, s), NRM, DK, HULL, AC, up=LAT, s=0.92,
                tripped=(c == 4))
    pad(B, bay(0.862, -0.24), NRM, 0.180, 0.014, 0.004, AC, r=0.004, up=LAT)
    for c in range(5):
        s = -0.66 + c * 0.33
        toggle(B, bay(0.918, s), NRM, DK, RAIL, AC, up=LAT, s=1.05,
               lean=(0.44 if c % 2 else -0.40))

    # ---- cross-ribs dividing the three functional groups. A 1.7 m bay with
    #      switches evenly down it is a grid however varied the switches are;
    #      the ribs are what make the eye count blocks.
    for t in (0.036, 0.316, 0.556, 0.742, 0.958):
        z, y, w = at(t)
        e = 1.0 - 0.10 * math.sin(math.pi * t)
        W = w * e
        sweep_profile(B, [(-W * 0.78, y - 0.055, z), (0.0, y - 0.058, z),
                          (W * 0.78, y - 0.055, z)],
                      [[(-0.013, 0.021), (-0.006, 0.028), (0.006, 0.028),
                        (0.013, 0.021), (0.010, -0.001), (-0.010, -0.001)]] * 3,
                      DK, up=(0.0, 1.0, 0.0))

    # ---- the yokes carrying it off the canopy frame. Lofted brackets that
    #      taper and lose depth as they climb, not four rectangular posts.
    for sx in (-1, 1):
        for t in (0.06, 0.52, 0.94):
            z, y, w = at(t)
            hh = nose_at(z)[1]
            st = []
            for (dy, ww, dd) in ((0.030, 0.052, 0.028), (0.5, 0.036, 0.022),
                                 (1.0, 0.024, 0.016)):
                yy = y + 0.150 + (hh + 0.010 - y - 0.150) * min(dy, 1.0)
                st.append(sect(sx * (w - 0.06), yy, z, ww, dd, 3.0, 12))
            loft2(B, st, DK)
            hexbolt(B, (sx * (w - 0.06), y + 0.140, z), (0.0, -1.0, 0.0),
                    0.0068, RAIL, up=LAT)
    return B.obj(name)


# ----------------------------------------------------------- canopy framing
def _ring_run(hw, h, r, waist, y0, seg=11):
    """The hull section as one open run: up the starboard side, over the roof,
       back down to the deck to port.

       A closed loop would dive under the deck plate, where there is nothing to
       see and a frame member would fight the floor for the same 80 mm."""
    tp = tub_profile(hw, h, r, waist, seg)
    rp = roof_profile(hw, h, r, waist, seg)
    half = len(tp) // 2
    stb = [p for p in tp[:half] if p[1] >= y0][::-1]
    prt = [p for p in tp[half:] if p[1] >= y0][::-1]
    return stb + rp[1:-1] + prt


def _run_normals(run):
    """Outward XY normal at each station of an open, counter-clockwise run."""
    out = []
    n = len(run)
    for i in range(n):
        a, b = run[max(i - 1, 0)], run[min(i + 1, n - 1)]
        tx, ty = b[0] - a[0], b[1] - a[1]
        L = math.hypot(tx, ty) or 1.0
        out.append((ty / L, -tx / L))
    return out


def _run_arc(run):
    s, out = 0.0, [0.0]
    for a, b in zip(run, run[1:]):
        s += math.hypot(b[0] - a[0], b[1] - a[1])
        out.append(s)
    return out


def _lateral(path, ups, i):
    """The section's own sideways axis at station i of a swept member, which is
       what a fastener on the retaining strip has to be positioned along."""
    a, b = path[max(i - 1, 0)], path[min(i + 1, len(path) - 1)]
    t = [b[j] - a[j] for j in range(3)]
    L = math.sqrt(sum(c * c for c in t)) or 1.0
    t = [c / L for c in t]
    m = ups[i]
    s = [m[1] * t[2] - m[2] * t[1], m[2] * t[0] - m[0] * t[2],
         m[0] * t[1] - m[1] * t[0]]
    L = math.sqrt(sum(c * c for c in s)) or 1.0
    return [c / L for c in s]


def canopy_frame(name='cp_canopy'):
    """The structure the glazing sits in.

       The architecture -- two A-pillars, two hoop ribs, a centre spine -- was
       already right and the members on it were already real swept sections.
       What was wrong is what the owner saw straight away and described
       exactly: *random metal bars sticking out*. Every one of those members
       ran forward and then simply stopped. The hull's forward station is
       z -7.60 and there was nothing there -- no frame, no ring, no closing
       member of any kind. Both pillars ended in mid-air two metres in front of
       the pilot's face, the spine ended in mid-air between them, and the
       demist duct ended in mid-air on both shoulders.

       A bar that terminates on nothing is a bar. The same bar landing on a
       machined shoe bolted to a frame is a canopy rail. That is most of what
       changed, along with the things a glazed frame has that this one had none
       of at all:

         · a nose ring -- the forward frame of the hull, a channel 94 mm deep
           with a rebate on its forward face that the pane beds into, spliced,
           bolted, sealed and drained;
         · a retaining strip down both sides of every member that borders
           glass, standing 1 mm proud of the pane, with a countersunk fastener
           every 180 mm;
         · a sealant bead outboard of every strip. This is the smallest thing
           here and possibly the most load-bearing: a dark line exactly on the
           glass line is what tells the eye that a pane *ends* there, which is
           what turns a rail crossing a hole into a mullion between two panes;
         · a waist sill carrying the lower edge of the aperture, on stand-off
           brackets, where hull skin previously just stopped and glass started;
         · shoes, gussets, fishplates and bolts everywhere two members meet.

       Framing is the constraint on all of it -- every millimetre of frame is
       window it stands in front of, and tools/framing.mjs has to stay above
       45% sky. The ring's inboard flange is 94 mm on a 2.3 m throw, about two
       degrees, and it sits at the very edge of the aperture where the bare
       hull skin was already drawing a hard cut."""
    B = Build()
    DK, RAIL, HULL, AC, RUB = (MI['KIT_DARK'], MI['KIT_RAIL'], MI['KIT_HULL'],
                               MI['KIT_ACCENT'], MI['KIT_RUBBER'])

    def shoulder(z, ang):
        """A point on the hull's upper corner radius, and its outward normal.
           ang 0 is the top of the straight side, pi/2 the crown."""
        hw, h, r, waist = nose_at(z)
        return ((hw - r + math.cos(ang) * r, h - r + math.sin(ang) * r),
                (math.cos(ang), math.sin(ang)))

    def csk(p, axis, ref, s=1.0):
        """A countersunk glazing fastener, 9 mm across the head. Sixty of these
           run the perimeter, and they are most of what says the retaining
           strip is bolted down rather than drawn on."""
        lathe(B, p, axis, [(0.0, -0.0018 * s), (0.0045 * s, -0.0024 * s),
                           (0.0047 * s, 0.0008 * s), (0.0031 * s, 0.0021 * s)],
              RAIL, 10, ref=ref, cap0=False)

    # ---------------------------------------------------------- the nose ring
    #  Swept round the forward section with up = the outward skin normal, so
    #  the section's first coordinate runs fore-and-aft (+ aft) and its second
    #  radially (+ outboard). The pane is the surface at 0.
    ZR = -7.565
    NHW, NH, NR, NWAIST = nose_at(-7.60)
    RUN = _ring_run(NHW, NH, NR, NWAIST, 0.085)
    RUN = [(RUN[0][0], 0.075)] + RUN + [(RUN[-1][0], 0.075)]
    RNRM = _run_normals(RUN)
    RARC = _run_arc(RUN)
    TOT = RARC[-1]

    RING_SECT = [(-0.048, 0.006), (-0.048, -0.021), (-0.024, -0.026),
                 (-0.027, -0.060), (0.006, -0.070), (0.044, -0.057),
                 (0.044, -0.026), (0.021, -0.021), (0.021, 0.006)]
    rpath = [(px, py, ZR) for (px, py) in RUN]
    rups = [(nx, ny, 0.0) for (nx, ny) in RNRM]
    sweep_profile(B, rpath, [RING_SECT] * len(RUN), DK, up=rups)

    #  Retaining strip and sealant bead, the whole way round on the rebate.
    STRIP = [(-0.046, -0.019), (-0.046, 0.001), (-0.028, 0.001), (-0.028, -0.019)]
    BEAD = [(-0.0275, -0.0155), (-0.0275, 0.0012), (-0.0205, 0.0018),
            (-0.0205, -0.0130)]
    sweep_profile(B, rpath, [STRIP] * len(RUN), RAIL, up=rups)
    sweep_profile(B, rpath, [BEAD] * len(RUN), RUB, up=rups)

    #  Splice plates. A ring this size is rolled in segments and joined, and
    #  none of the four joints is on the centreline: a splice on the centreline
    #  reads as ornament rather than as a manufacturing joint.
    for frac in (0.16, 0.40, 0.62, 0.85):
        i = min(range(len(RARC)), key=lambda k: abs(RARC[k] - TOT * frac))
        (px, py), (nx, ny) = RUN[i], RNRM[i]
        pad(B, (px - nx * 0.070, py - ny * 0.070, ZR + 0.006),
            (-nx, -ny, 0.0), 0.060, 0.036, 0.006, DK, r=0.010, up=(0.0, 0.0, 1.0))
        for dz in (-0.030, 0.040):
            hexbolt(B, (px - nx * 0.076, py - ny * 0.076, ZR + dz),
                    (-nx, -ny, 0.0), 0.0062, RAIL, up=(0.0, 0.0, 1.0))
    nf = max(2, int(TOT / 0.18))
    for k in range(nf):
        i = min(range(len(RARC)),
                key=lambda kk: abs(RARC[kk] - TOT * (k + 0.5) / nf))
        (px, py), (nx, ny) = RUN[i], RNRM[i]
        csk((px - nx * 0.0090, py - ny * 0.0090, ZR - 0.0365),
            (0.0, 0.0, -1.0), (nx, ny, 0.0))

    #  Drain spigots off the two low corners. The bottom of a windscreen frame
    #  is a gutter and it has to go somewhere.
    for e in (0, -1):
        (px, py) = RUN[e]
        sgn = 1.0 if px > 0 else -1.0
        lathe(B, (px - sgn * 0.028, py + 0.010, ZR + 0.030), (0.0, -1.0, 0.0),
              [(0.0, 0.0), (0.015, 0.005), (0.016, 0.022), (0.012, 0.028),
               (0.012, 0.070)], DK, 12, ref=(0.0, 0.0, 1.0))

    # ---------------------------------------------------------- the A-pillars
    #  A member running fore-and-aft near the roof of a hull that tapers
    #  *downward* holds very nearly constant elevation from the seated eye,
    #  which draws it as a horizontal bar across the window. Climbing to the
    #  crown as it runs forward keeps the aft two thirds of each pillar outside
    #  a 47-degree half frame entirely, and what is left is a shallow V in the
    #  upper third where the top edge of the aperture is anyway.
    #
    #  The last station is new, and it is the point of the whole rewrite: the
    #  pillar now runs *past* the ring plane and dies inside its web, instead
    #  of stopping 40 mm short of it in open air.
    ARC = [(-6.06, -0.34), (-6.28, 0.40), (-6.56, 0.92), (-6.86, 1.26),
           (-7.14, 1.42), (-7.40, 1.50), (-7.56, 1.54), (-7.638, 1.556)]

    def pillar_sect(t, lighten=0.0):
        #  100 mm across the glass at the root, 44 at the nose. It was 152 and
        #  the two of them measured as the largest solid obstruction in the
        #  forward frame: a rail is read by its depth and its section, and
        #  every millimetre of *width* is window it stands in front of.
        #
        #  Inboard-opening, rather than standing proud outside the skin as it
        #  used to. A rail in front of the glass reads as a mullion; the same
        #  rail behind the glass reads as debris caught outside the window.
        #
        #  And a *channel*, not a ribbon. The whole inboard face used to be one
        #  flat plane, so the member returned exactly one value from root to
        #  tip whatever the lighting did -- which is what the review meant by
        #  "flat two-face ribbon whose value is constant along its length". The
        #  reference member shows three: a chamfer highlight on the cheek, a
        #  flange, and a web sunk between the flanges. Sinking the web 9 mm and
        #  drafting the step gives one lit edge and one shaded one down every
        #  millimetre of the run, and the depth of the web is modulated by
        #  `lighten` so the value changes along the length as well as across.
        wA = 0.041 - 0.023 * t
        dB = 0.072 - 0.042 * t
        fl = -dB + lighten                       # flange face, deepest inboard
        wb = fl + 0.009 + 0.005 * lighten * 40.0  # web, sunk back toward the glass
        return [(-wA, -0.013), (-wA * 0.92, -dB * 0.50), (-wA * 0.66, fl),
                (-wA * 0.44, fl), (-wA * 0.36, wb), (wA * 0.36, wb),
                (wA * 0.44, fl), (wA * 0.66, fl),
                (wA * 0.92, -dB * 0.50), (wA, -0.013)]

    for sx in (-1, 1):
        path, ups, sects = [], [], []
        for k, (z, ang) in enumerate(ARC):
            (px, py), (nx, ny) = shoulder(z, max(ang, 0.0))
            if ang < 0.0:                      # the root, down on the coaming
                cy, cz = coam_crown(sx * COAM_HW)
                px, py = COAM_HW - 0.02, cy - 0.03
                nx, ny = 0.94, 0.34
                z = cz + 0.02
            t = k / (len(ARC) - 1.0)
            path.append((sx * px, py, z))
            ups.append((sx * nx, ny, 0.0))
            lift = 0.020 * math.sin(math.pi * min(max((t - 0.25) / 0.5, 0.0), 1.0))
            sects.append(pillar_sect(t, lift))
        sweep_profile(B, path, sects, DK, up=ups)

        #  A retaining strip down each side, lapping 24 mm onto the pane and
        #  standing 1 mm proud of it, with the bead outboard of that.
        for side in (-1, 1):
            ss, bs = [], []
            for k in range(len(ARC)):
                wA = 0.041 - 0.023 * k / (len(ARC) - 1.0)
                ss.append([(side * (wA + 0.015), -0.0140),
                           (side * (wA + 0.013), 0.0010),
                           (side * (wA * 0.30), 0.0012),
                           (side * (wA * 0.28), -0.0140)])
                bs.append([(side * (wA + 0.0155), -0.0128),
                           (side * (wA + 0.0135), 0.0014),
                           (side * (wA + 0.0230), 0.0018),
                           (side * (wA + 0.0245), -0.0106)])
            sweep_profile(B, path, ss, RAIL, up=ups)
            sweep_profile(B, path, bs, RUB, up=ups)
        for k in (1, 3, 5, 6):
            s = _lateral(path, ups, k)
            u = ups[k]
            wA = 0.041 - 0.023 * k / (len(ARC) - 1.0)
            for side in (-1, 1):
                d = side * (wA + 0.007)
                csk(tuple(path[k][j] + s[j] * d + u[j] * 0.0012 for j in range(3)),
                    u, s, 0.85)

        # machined shoe where it lands on the tub, with a shim and two bolts
        cy, cz = coam_crown(sx * COAM_HW)
        st = []
        for (dy, w, d) in ((-0.10, 0.052, 0.070), (-0.03, 0.070, 0.086),
                           (0.04, 0.062, 0.076), (0.09, 0.044, 0.058)):
            st.append(sect(sx * (COAM_HW + 0.02), cy - 0.03 + dy, cz + 0.02,
                           w, d, 3.6, 14))
        loft2(B, st, DK)
        for (dy, dz) in ((-0.055, 0.052), (-0.055, -0.048)):
            hexbolt(B, (sx * (COAM_HW + 0.072), cy - 0.03 + dy, cz + 0.02 + dz),
                    (sx * 1.0, 0.0, 0.0), 0.0072, RAIL, up=(0.0, 1.0, 0.0))
        lathe(B, (sx * (COAM_HW + 0.062), cy - 0.055, cz + 0.02),
              (sx * 1.0, 0.0, 0.0), [(0.070, 0.0), (0.070, 0.006)], AC, 16,
              ref=(0.0, 1.0, 0.0), cap0=False, cap1=False)

        #  ...and the shoe at the far end, which is the one that was missing.
        #  A forged fitting straddling the ring, two bolts through it into the
        #  flange, and an identification plate on the outer face.
        (fx, fy), (fnx, fny) = shoulder(-7.58, 1.55)
        tnx, tny = sx * fnx, fny
        cxx, cyy = sx * fx - tnx * 0.030, fy - tny * 0.030
        st = []
        for (dz, w, hh) in ((0.092, 0.026, 0.028), (0.046, 0.043, 0.045),
                            (-0.016, 0.049, 0.051), (-0.056, 0.034, 0.036)):
            st.append(sect_xy(cxx, cyy, ZR + dz, w, hh, 3.2, 14))
        loft2(B, st, DK)
        for dz in (0.058, -0.032):
            hexbolt(B, (cxx - tnx * 0.030, cyy - tny * 0.030, ZR + dz),
                    (-tnx, -tny, 0.0), 0.0064, RAIL, up=(0.0, 0.0, 1.0))
        pad(B, (cxx - tnx * 0.032, cyy - tny * 0.032, ZR + 0.014),
            (-tnx, -tny, 0.0), 0.024, 0.040, 0.004, AC, r=0.005, up=(0.0, 0.0, 1.0))

        #  ---- the cast node where the pillar crosses the forward hoop.
        #  Two members passing each other at a right angle with nothing at the
        #  crossing is the single loudest "assembled from bars" tell, and it is
        #  the feature the reference frame leads with: the junction there is a
        #  chunky forged Y with a bolt circle and a cable saddle on it. Ours had
        #  the two sections simply interpenetrating.
        k = 1
        s = _lateral(path, ups, k)
        u, pk = ups[k], path[k]
        st = []
        for (dt, w, hh) in ((-0.078, 0.030, 0.032), (-0.034, 0.058, 0.062),
                            (0.006, 0.068, 0.072), (0.052, 0.050, 0.054),
                            (0.086, 0.026, 0.028)):
            st.append(sect_xy(pk[0] - u[0] * 0.022 + s[0] * 0.0,
                              pk[1] - u[1] * 0.022, pk[2] + dt, w, hh, 3.2, 14))
        loft2(B, st, DK)
        for (da, dt) in ((-0.026, 0.044), (0.026, 0.044),
                         (-0.026, -0.038), (0.026, -0.038)):
            hexbolt(B, tuple(pk[j] - u[j] * 0.052 + s[j] * da
                             + (0.0, 0.0, dt)[j] for j in range(3)),
                    (-u[0], -u[1], 0.0), 0.0056, RAIL, up=(0.0, 0.0, 1.0))
        pad(B, tuple(pk[j] - u[j] * 0.056 for j in range(3)),
            (-u[0], -u[1], 0.0), 0.020, 0.038, 0.004, AC, r=0.004,
            up=(0.0, 0.0, 1.0))

        #  ---- and, on the port pillar only, the loom.
        #  Every canopy in the reference carries its wiring on the frame in
        #  plain sight -- a bundle in saddles, running from the shoe up to the
        #  ring, with a breakout at the node. It is the one feature that gives
        #  a 2 m member something hand-sized to be measured against, and
        #  putting it on one side only is another asymmetry that cannot read as
        #  a mistake.
        if sx < 0:
            loom, radii = [], []
            for k2 in range(len(ARC)):
                sl = _lateral(path, ups, k2)
                uu = ups[k2]
                wA = 0.041 - 0.023 * k2 / (len(ARC) - 1.0)
                off = wA * 0.30
                loom.append(tuple(path[k2][j] - uu[j] * 0.062 + sl[j] * off
                                  for j in range(3)))
                radii.append(0.017 - 0.005 * k2 / (len(ARC) - 1.0))
            sweep_path(B, loom, radii, RUB, 9)
            for k2 in (0, 2, 4, 6):
                sl = _lateral(path, ups, k2)
                uu = ups[k2]
                wA = 0.041 - 0.023 * k2 / (len(ARC) - 1.0)
                #  the saddle: a strap over the bundle, bolted to the flange
                ctr = tuple(path[k2][j] - uu[j] * 0.048 + sl[j] * (wA * 0.30)
                            for j in range(3))
                lathe(B, ctr, (sl[0], sl[1], sl[2]),
                      [(0.021, -0.009), (0.024, -0.006), (0.024, 0.006),
                       (0.021, 0.009)], RAIL, 12, ref=(uu[0], uu[1], 0.0),
                      cap0=False, cap1=False)
            #  a placard on the web, where a canopy carries its jettison
            #  markings. Raised plate, drafted, in the one accent colour.
            k2 = 3
            sl = _lateral(path, ups, k2)
            uu = ups[k2]
            pad(B, tuple(path[k2][j] - uu[j] * 0.036 - sl[j] * 0.006
                         for j in range(3)),
                (-uu[0], -uu[1], 0.0), 0.017, 0.052, 0.0035, AC, r=0.003,
                up=(sl[0], sl[1], sl[2]))

    # ------------------------------------------------------------- hoop ribs
    #  Swept round the roof profile with up = +Z, so the section's first
    #  coordinate is radial (+ inboard) and its second runs fore-aft. A channel
    #  with an inboard bulb, growing in depth toward the waist where the load
    #  is. Both stations sit above the seated frame's top edge at rest pitch.
    for (zc, fwd) in ((-5.55, False), (-6.30, True)):
        hw, h, r, waist = nose_at(zc)
        P = roof_profile(hw, h, r, waist, 9)
        path, ups, sects = [], [], []
        n = len(P)
        for i, (px, py) in enumerate(P):
            u = abs(i / (n - 1.0) - 0.5) * 2.0        # 1 at the waist ends
            path.append((px, py, zc))
            ups.append((0.0, 0.0, 1.0))
            dp = 0.050 + 0.040 * u * u                 # depth, radial
            wd = 0.062 + 0.030 * u                     # width, fore-aft
            #  Flange, web, flange across the inboard face -- the same three
            #  values the pillars and the spine now carry, so the whole cage
            #  reads as one family of rolled sections rather than as bars of
            #  assorted thickness. The web sinks deeper toward the waist, where
            #  the section is deepest, so the value varies along the run too.
            wb = 0.0015 - 0.0035 * u
            sects.append([(-dp, -wd), (-dp * 0.55, -wd * 1.10),
                          (0.004, -wd * 1.02), (0.012, -wd * 0.84),
                          (0.012, -wd * 0.56), (wb, -wd * 0.44),
                          (wb, wd * 0.44), (0.012, wd * 0.56),
                          (0.012, wd * 0.84), (0.004, wd * 1.02),
                          (-dp * 0.55, wd * 1.10),
                          (-dp, wd), (-dp * 0.72, wd * 0.42),
                          (-dp * 0.72, -wd * 0.42)])
        sweep_profile(B, path, sects, DK, up=ups, cap0=True, cap1=True)
        for i in range(2, n - 2, 4):
            (px, py) = P[i]
            nx, ny = px - (hw - r if px > 0 else -(hw - r)), py - (h - r)
            L = math.hypot(nx, ny) or 1.0
            hexbolt(B, (px - nx / L * 0.030, py - ny / L * 0.030, zc),
                    (0.0, 0.0, 1.0), 0.0068, RAIL, up=(1.0, 0.0, 0.0))
        for side in (-1, 1):
            ss, bs = [], []
            for i in range(n):
                u = abs(i / (n - 1.0) - 0.5) * 2.0
                wd = 0.062 + 0.030 * u
                ss.append([(0.0155, side * (wd + 0.015)), (0.0012, side * (wd + 0.013)),
                           (0.0010, side * (wd * 0.30)), (0.0150, side * (wd * 0.28))])
                bs.append([(0.0135, side * (wd + 0.0155)), (0.0016, side * (wd + 0.0135)),
                           (0.0020, side * (wd + 0.0230)), (0.0115, side * (wd + 0.0245))])
            sweep_profile(B, path, ss, RAIL, up=ups)
            sweep_profile(B, path, bs, RUB, up=ups)
        if fwd:
            #  The demist duct, which used to begin and end in open air on the
            #  two shoulders. It turns down into a plenum at each end now.
            dp = [(px * 0.955, py * 0.955 + 0.018, zc + 0.082) for (px, py) in P[3:-3]]
            heads = []
            for e in (0, -1):
                (ex, ey, ez) = dp[e]
                sgn = 1.0 if ex > 0 else -1.0
                heads.append([(ex + sgn * 0.030, ey - 0.030, ez + 0.014),
                              (ex + sgn * 0.062, ey - 0.120, ez + 0.030)])
            sweep_path(B, [heads[0][1], heads[0][0]] + dp + heads[1],
                       0.030, RAIL, 10, up=(0.0, 0.0, 1.0))
            for hd in heads:
                (ex, ey, ez) = hd[1]
                sgn = 1.0 if ex > 0 else -1.0
                st = []
                for (dy, w, d) in ((0.034, 0.036, 0.040), (-0.006, 0.050, 0.056),
                                   (-0.066, 0.046, 0.052), (-0.090, 0.032, 0.038)):
                    st.append(sect(ex, ey + dy, ez, w, d, 3.4, 14))
                loft2(B, st, DK)
                for dz in (-0.032, 0.032):
                    hexbolt(B, (ex + sgn * 0.048, ey - 0.028, ez + dz),
                            (sgn, 0.0, 0.0), 0.0060, RAIL, up=(0.0, 1.0, 0.0))
            for k in range(3, len(dp) - 3, 3):
                lathe(B, dp[k], (0.0, 0.0, 1.0),
                      [(0.033, -0.010), (0.036, -0.006), (0.036, 0.006),
                       (0.033, 0.010)], DK, 12, ref=(1.0, 0.0, 0.0),
                      cap0=False, cap1=False)

    # ------------------------------------------------------------ centre spine
    #  Slim on purpose, and it divides the window instead of blocking it.
    #
    #  It used to *begin* at z -6.42, which is 120 mm forward of the hoop rib
    #  at -6.30 and 220 mm forward of the overhead console's lip at -6.22. So
    #  its aft end was a flat capped face hanging in the middle of the glazing,
    #  square to the overhead lamp and therefore the brightest thing in the
    #  upper frame: at any pitch between +0.5 and +0.85 -- which is what the
    #  player looks at when the ship is nose-down over a world -- the eye
    #  followed the spine up the windscreen and it stopped, in nothing, with a
    #  highlight on the end. The forward half of the rewrite landed the members
    #  on the nose ring and the aft half was never done.
    #
    #  It now starts under the console's forward lip, runs aft-to-forward
    #  *through* the hoop rib at -6.30 -- with a cast node at the crossing, the
    #  way a spine and a frame are actually joined -- and dies in the ring's
    #  apex fitting at the other end. Every member in the canopy lands on
    #  structure at both ends.
    spath, sects, ups = [], [], []
    NS = 13
    SZ0, SZ1 = -6.205, -7.662
    for k in range(NS):
        t = k / (NS - 1.0)
        z = SZ0 + (SZ1 - SZ0) * t
        y = nose_at(z)[1] - 0.038
        spath.append((0.0, y, z))
        ups.append((0.0, 1.0, 0.0))
        #  Deepest at the root, where it is carrying into the console, closing
        #  to a blade at the ring. A member of constant section is an extrusion.
        w = 0.034 - 0.016 * t
        d = 0.040 - 0.018 * t
        #  Three values across the width, not one. The reference frame's member
        #  shows a chamfered outer cheek, a flange face and a web recessed
        #  between them; ours was a flat ribbon whose value never changed
        #  either across the section or along the run, which is why it read as
        #  a painted bar rather than as a rolled channel. The step up into the
        #  web is 8 mm, which after the 2.5 mm chamfer in 50_assemble.py is two
        #  lit edges and a shaded floor at every point along the length.
        rec = -d + 0.009 + 0.004 * math.sin(math.pi * t)
        sects.append([(-w, 0.004), (-w * 0.74, -d), (-w * 0.46, -d),
                      (-w * 0.38, rec), (w * 0.38, rec), (w * 0.46, -d),
                      (w * 0.74, -d), (w, 0.004)])
    sweep_profile(B, spath, sects, DK, up=ups)
    for side in (-1, 1):
        ss, bs = [], []
        for k in range(NS):
            w = 0.034 - 0.016 * k / (NS - 1.0)
            ss.append([(side * (w + 0.014), -0.0130), (side * (w + 0.012), 0.0010),
                       (side * (w * 0.30), 0.0012), (side * (w * 0.28), -0.0130)])
            bs.append([(side * (w + 0.0145), -0.0118), (side * (w + 0.0125), 0.0014),
                       (side * (w + 0.0220), 0.0018), (side * (w + 0.0235), -0.0098)])
        sweep_profile(B, spath, ss, RAIL, up=ups)
        sweep_profile(B, spath, bs, RUB, up=ups)
    for k in (2, 5, 8, 11):
        hexbolt(B, (0.0, spath[k][1] - 0.030, spath[k][2]), (0.0, -1.0, 0.0),
                0.0062, RAIL, up=(1.0, 0.0, 0.0))
    #  The node where the spine crosses the forward hoop: a forged saddle over
    #  the rib with a bolt through each corner and a data plate on its face.
    #  This is the feature that reads first in the reference -- the junction is
    #  a *casting*, not two bars passing each other.
    node_y = nose_at(-6.30)[1] - 0.038
    st = []
    for (dz, w, hh) in ((0.118, 0.030, 0.026), (0.064, 0.055, 0.048),
                        (0.000, 0.066, 0.058), (-0.062, 0.052, 0.046),
                        (-0.108, 0.028, 0.024)):
        st.append(sect_xy(0.0, node_y - 0.014, -6.30 + dz, w, hh, 3.2, 14))
    loft2(B, st, DK)
    for (dx, dz) in ((-0.026, 0.070), (0.026, 0.070), (-0.026, -0.066),
                     (0.026, -0.066)):
        hexbolt(B, (dx, node_y - 0.044, -6.30 + dz), (0.0, -1.0, 0.0), 0.0058,
                RAIL, up=(1.0, 0.0, 0.0))
    pad(B, (0.0, node_y - 0.046, -6.30), (0.0, -1.0, 0.0), 0.044, 0.020, 0.004,
        AC, r=0.004, up=(0.0, 0.0, 1.0))
    #  ...and the short stub that carries the spine's root into the console's
    #  forward lip, so the run reads as continuous structure from the roof.
    st = []
    for (dz, w, hh) in ((0.020, 0.032, 0.030), (-0.006, 0.040, 0.038),
                        (-0.040, 0.036, 0.034)):
        st.append(sect_xy(0.0, nose_at(-6.21)[1] - 0.034, -6.19 + dz, w, hh,
                          3.0, 12))
    loft2(B, st, DK)
    #  the apex fitting: where the spine dies into the crown of the ring
    ay = nose_at(-7.60)[1] - 0.044
    st = []
    for (dz, w, hh) in ((0.086, 0.020, 0.022), (0.042, 0.034, 0.036),
                        (-0.018, 0.040, 0.042), (-0.054, 0.028, 0.030)):
        st.append(sect_xy(0.0, ay, ZR + dz, w, hh, 3.2, 14))
    loft2(B, st, DK)
    for dz in (0.054, -0.030):
        hexbolt(B, (0.0, ay - 0.040, ZR + dz), (0.0, -1.0, 0.0), 0.0062, RAIL,
                up=(1.0, 0.0, 0.0))

    # ------------------------------------------- shoulder rails between hoops
    #  Two short longitudinals well outboard, tying the hoops together where a
    #  canopy is actually panelled -- clipped to them at both ends, which they
    #  were not.
    for sx in (-1, 1):
        rp2, rsect, rup2 = [], [], []
        for k in range(6):
            z = -5.55 - k * 0.150
            ang = 0.62 + k * 0.090
            (px, py), (nx, ny) = shoulder(z, ang)
            rp2.append((sx * px, py, z))
            rup2.append((sx * nx, ny, 0.0))
            w = 0.024 - 0.006 * (k / 5.0)
            rsect.append([(-w, 0.006), (-w * 0.6, -0.030), (w * 0.6, -0.030),
                          (w, 0.006), (w * 0.7, 0.002), (-w * 0.7, 0.002)])
        sweep_profile(B, rp2, rsect, DK, up=rup2)
        for k in (0, 5):
            p, u = rp2[k], rup2[k]
            st = []
            for (dt, w, hh) in ((-0.032, 0.024, 0.026), (0.002, 0.036, 0.040),
                                (0.036, 0.028, 0.032)):
                st.append(sect_xy(p[0] - u[0] * 0.016, p[1] - u[1] * 0.016,
                                  p[2] + dt, w, hh, 3.2, 12))
            loft2(B, st, DK)
            hexbolt(B, (p[0] - u[0] * 0.042, p[1] - u[1] * 0.042, p[2]),
                    (-u[0], -u[1], 0.0), 0.0058, RAIL, up=(0.0, 0.0, 1.0))

    # -------------------------------------------------------- the waist sills
    #  The lower edge of a windscreen is carried on a sill, and there was none:
    #  hull skin simply stopped and glass simply started along a line 2.3 m
    #  long. A channel with a gutter, the same retaining strip and bead as
    #  everywhere else, and a stand-off bracket down onto the tub every 660 mm.
    #
    #  Swept with up = +Y so the section reads directly: first coordinate
    #  inboard (mirrored by sx, because the lateral axis does not flip with
    #  the side), second up.
    for sx in (-1, 1):
        sp, sup, ssec, rsec, bsec = [], [], [], [], []
        K = 15
        for k in range(K):
            z = -5.25 - (7.565 - 5.25) * k / (K - 1.0)
            hw, h, r, waist = nose_at(z)
            sp.append((sx * hw, waist, z))
            sup.append((0.0, 1.0, 0.0))
            ssec.append([(sx * a, b) for (a, b) in
                         ((0.007, 0.040), (-0.007, 0.042), (-0.011, 0.004),
                          (-0.009, -0.034), (0.042, -0.066), (0.062, -0.022),
                          (0.036, 0.006))])
            rsec.append([(sx * a, b) for (a, b) in
                         ((0.0075, 0.0385), (0.0185, 0.0360), (0.0195, 0.0090),
                          (0.0085, 0.0080))])
            bsec.append([(sx * a, b) for (a, b) in
                         ((0.0020, 0.0410), (-0.0020, 0.0420), (-0.0025, 0.0310),
                          (0.0025, 0.0300))])
        sweep_profile(B, sp, ssec, DK, up=sup)
        sweep_profile(B, sp, rsec, RAIL, up=sup)
        sweep_profile(B, sp, bsec, RUB, up=sup)
        for k in range(1, K - 1, 2):
            p = sp[k]
            csk((p[0] - sx * 0.013, p[1] + 0.0230, p[2]), (-sx * 1.0, 0.0, 0.0),
                (0.0, 1.0, 0.0), 0.85)
        for k in range(2, K - 1, 4):
            p = sp[k]
            st = []
            for (dy, w, d) in ((0.000, 0.024, 0.048), (-0.048, 0.030, 0.054),
                               (-0.115, 0.022, 0.040)):
                st.append(sect(p[0] - sx * 0.048, p[1] + dy, p[2], w, d, 3.2, 12))
            loft2(B, st, DK)
            hexbolt(B, (p[0] - sx * 0.048, p[1] - 0.126, p[2]), (0.0, -1.0, 0.0),
                    0.0058, RAIL, up=(1.0, 0.0, 0.0))

    # ------------------------------ corner gussets on the waist rail
    for zc in (-5.55, -6.30):
        hw, h, r, waist = nose_at(zc)
        for sx in (-1, 1):
            st = []
            for (dy, w, d) in ((-0.030, 0.048, 0.100), (0.040, 0.056, 0.112),
                               (0.120, 0.040, 0.086), (0.170, 0.022, 0.052)):
                st.append(sect(sx * (hw - 0.060), waist + dy, zc, w, d, 3.4, 14))
            loft2(B, st, DK)
            hexbolt(B, (sx * (hw - 0.060), waist + 0.150, zc), (0.0, 1.0, 0.0),
                    0.0064, RAIL, up=(1.0, 0.0, 0.0))
    return B.obj(name)


# ------------------------------------------------------------------- stowage
def cockpit_stowage(name='cp_stow'):
    """The things that make a cockpit look occupied rather than delivered."""
    B = Build()
    DK, AC, RAIL, HULL = (MI['KIT_DARK'], MI['KIT_ACCENT'],
                          MI['KIT_RAIL'], MI['KIT_HULL'])
    # document pocket and a mug bracket on the port console cheek
    B.box(-1.62, 0.90, -5.35, -1.44, 1.16, -4.98, HULL)
    B.box(-1.60, 0.92, -5.33, -1.46, 1.13, -5.30, DK)
    B.box(-1.615, 1.16, -5.34, -1.435, 1.185, -4.97, AC)
    B.box(1.46, 0.90, -5.20, 1.62, 0.925, -5.02, DK)
    for i in range(10):
        a = 2 * math.pi * i / 10
        B.box(1.54 + math.cos(a) * 0.052 - 0.010, 0.925, -5.11 + math.sin(a) * 0.052 - 0.010,
              1.54 + math.cos(a) * 0.052 + 0.010, 0.985, -5.11 + math.sin(a) * 0.052 + 0.010, RAIL)
    # a cable run down the starboard tub wall into the console
    for k in range(9):
        z = -5.05 - k * 0.17
        hw = nose_at(z)[0]
        B.box(hw - 0.145, 0.44 - k * 0.012, z - 0.055, hw - 0.075, 0.50 - k * 0.012, z + 0.055, DK)
    for k in range(3):
        z = -5.20 - k * 0.50
        hw = nose_at(z)[0]
        B.box(hw - 0.160, 0.40 - k * 0.036, z - 0.028, hw - 0.060, 0.52 - k * 0.036, z + 0.028, AC)
    # A grab handle over each shoulder -- but only these are symmetric, and
    # even they sit at different z. Everything else in this piece is one job
    # to port and a different one to starboard.
    for sx, z0, z1 in ((-1, -4.90, -4.44), (1, -4.78, -4.38)):
        B.box(sx * 1.52, 1.32, z0, sx * 1.60, 1.38, z1, RAIL)
        for z in (z0 + 0.04, z1 - 0.04):
            B.box(sx * 1.50, 1.30, z - 0.030, sx * 1.63, 1.40, z + 0.030, DK)
    # port: an access hatch with dogs and a handle
    B.box(-1.66, 0.30, -4.62, -1.50, 1.14, -3.86, HULL)
    B.box(-1.62, 0.34, -4.58, -1.505, 1.10, -3.90, DK)
    for k in range(4):
        z = -4.46 - k * 0.20
        B.box(-1.63, 0.42 + (k % 2) * 0.42, z - 0.036, -1.49, 0.50 + (k % 2) * 0.42, z + 0.036, RAIL)
    B.box(-1.68, 0.66, -4.30, -1.47, 0.72, -4.06, RAIL)
    B.box(-1.655, 0.60, -4.60, -1.495, 0.64, -4.38, AC)
    # starboard: open stowage with three shelves and a strapped roll
    B.box(1.50, 0.34, -4.64, 1.66, 1.22, -3.92, HULL)
    for k in range(3):
        y = 0.44 + k * 0.28
        B.box(1.50, y, -4.62, 1.645, y + 0.026, -3.94, DK)
        B.box(1.50, y + 0.026, -4.60 + k * 0.06, 1.60, y + 0.16, -4.30 + k * 0.09, DK)
    B.box(1.505, 0.98, -4.28, 1.63, 1.14, -4.02, MI['KIT_SEAT'])
    for z in (-4.24, -4.08):
        B.box(1.495, 0.96, z - 0.018, 1.64, 1.16, z + 0.018, MI['KIT_RUBBER'])
    B.box(1.49, 1.22, -4.66, 1.67, 1.26, -3.90, AC)
    return B.obj(name)
