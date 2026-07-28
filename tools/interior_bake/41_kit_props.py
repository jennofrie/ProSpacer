# ---------------------------------------------------------------- bulkhead
def bulkhead(name, ohw, oh, orr, ihw, ih, ir, seg=7, deckY=0.08):
    """The step from a wide compartment into the corridor. The single most
       looked-at object in the cabin: it frames the whole forward view."""
    B = Build()
    P = rounded_profile(ohw, oh, orr, seg)         # outer, matches the hull
    C = rounded_profile(ihw+0.075, ih+0.075, ir, seg)  # collar
    D = rounded_profile(ihw+0.020, ih+0.020, ir, seg)  # door frame bore
    E = rounded_profile(ihw+0.004, ih+0.004, ir, seg)  # proud inner lip
    n = len(P)
    def ring(A, Bp, za, zb, mat, i0=0, i1=None, flip=False):
        i1 = n if i1 is None else i1
        for i in range(i0, i1-1):
            j = i+1
            q = [(A[i][0],A[i][1],za), (Bp[i][0],Bp[i][1],zb),
                 (Bp[j][0],Bp[j][1],zb), (A[j][0],A[j][1],za)]
            if flip: q.reverse()
            B.quad(*q, mat)
    i0 = 0
    while i0 < n-1 and P[i0][1] < deckY - 0.02: i0 += 1
    i1 = n
    while i1 > 1 and P[i1-1][1] < deckY - 0.02: i1 -= 1
    for sgn, m in ((-1, MI['KIT_HULL']), (1, MI['KIT_HULL'])):
        fl = sgn > 0
        ring(P, C, sgn*0.19, sgn*0.13, m, i0-1, i1+1, fl)               # face plate
        ring(C, C, sgn*0.13, sgn*0.105, MI['KIT_DARK'], i0-1, i1+1, fl)  # collar wall
        ring(C, D, sgn*0.105, sgn*0.085, MI['KIT_DARK'], i0-1, i1+1, fl)
        ring(D, D, sgn*0.085, 0, MI['KIT_DARK'], i0-1, i1+1, fl)         # bore
        ring(E, E, sgn*0.078, sgn*0.062, MI['KIT_ACCENT'], i0-1, i1+1, fl)
        ring(D, E, sgn*0.085, sgn*0.078, MI['KIT_ACCENT'], i0-1, i1+1, fl)
        ring(E, D, sgn*0.062, sgn*0.048, MI['KIT_ACCENT'], i0-1, i1+1, fl)
    # gussets in the upper corners, tying the frame back to the hull
    for sx in (-1, 1):
        for (yy, zz) in ((ih-0.10, 0.0),):
            pass
        gx = sx*(ihw + 0.16)
        B.box(gx - sx*0.045, ih-0.30, -0.19, gx, ih-0.02, 0.19, MI['KIT_DARK'])
        B.box(sx*(ihw+0.05), ih-0.05, -0.19, gx, ih+0.10, 0.19, MI['KIT_DARK'])
    # sill: you step over this
    B.box(-ihw-0.02, deckY, -0.185, ihw+0.02, deckY+0.055, 0.185, MI['KIT_DARK'])
    B.box(-ihw-0.02, deckY+0.048, -0.14, ihw+0.02, deckY+0.062, 0.14, MI['KIT_ACCENT'])
    # hinge stack on one side, latch on the other
    for k in range(3):
        y = 0.42 + k*0.62
        B.box(-ihw-0.14, y-0.075, -0.20, -ihw-0.03, y+0.075, -0.10, MI['KIT_DARK'])
        cyl_z(B, -ihw-0.115, y, -0.215, -0.085, 0.036, MI['KIT_RAIL'], 10)
    B.box(ihw+0.03, 1.02, -0.20, ihw+0.12, 1.30, -0.12, MI['KIT_DARK'])
    B.box(ihw+0.05, 1.10, -0.235, ihw+0.10, 1.22, -0.19, MI['KIT_RAIL'])
    # overhead placard
    B.box(-0.34, ih+0.02, -0.215, 0.34, ih+0.14, -0.19, MI['KIT_DARK'])
    return B.obj(name)

# ------------------------------------------------------------------- props
def locker(name, w=0.80, hgt=1.50, d=0.30, variant=0):
    """Two-door stowage locker.

       Seven boxes before, and it stands where the player walks past at 40 cm.
       It is a lofted carcass with drafted, chamfered sides now, with doors set
       into a real reveal, lathed T-handles on hinge barrels, a louvred vent
       and a data plate. Everything here is built out of 42_cockpit.py's
       vocabulary -- the corridor had no reason to be a different ship from the
       flight deck except that nobody had taken it yet."""
    B = Build()
    HULL, DK, AC, RAIL, RUB = (MI['KIT_HULL'], MI['KIT_DARK'],
                               MI['KIT_ACCENT'], MI['KIT_RAIL'], MI['KIT_RUBBER'])
    hw, hd = w / 2, d / 2
    # carcass: a superellipse section swept up, drawing in at the top
    st = []
    for (y, sw, sd, k) in ((0.070, hw, hd, 6.0), (0.100, hw, hd, 5.0),
                           (hgt - 0.16, hw, hd, 5.0),
                           (hgt - 0.02, hw - 0.008, hd - 0.006, 5.0),
                           (hgt + 0.020, hw - 0.026, hd - 0.020, 4.0)):
        st.append(sect(0.0, y, 0.0, sw, sd, k, 20))
    loft2(B, st, HULL)
    # plinth, set back so the carcass overhangs it -- a shadow line at the foot
    st = []
    for (y, sw, sd) in ((0.0, hw - 0.018, hd - 0.014), (0.062, hw - 0.018, hd - 0.014),
                        (0.076, hw - 0.004, hd - 0.002)):
        st.append(sect(0.0, y, 0.0, sw, sd, 5.0, 16))
    loft2(B, st, DK)
    ndoor = 1 if variant == 3 else 2
    for k in range(ndoor):
        y0 = 0.110 + k * (hgt - 0.20) / ndoor
        y1 = y0 + (hgt - 0.28) / ndoor
        yc = (y0 + y1) * 0.5
        # the door: a pressed panel with a rolled edge, standing in a reveal
        dp, ds = [], []
        for (zz, sc, dn) in ((hd - 0.004, 1.000, 0.0), (hd + 0.016, 0.992, 0.0),
                             (hd + 0.024, 0.958, 0.0)):
            dp.append((0.0, yc, zz))
            ds.append([(-a2 * sc, b2 * sc) for (a2, b2)
                       in rrect(hw - 0.026, (y1 - y0) * 0.5, 0.030, 4)])
        sweep_profile(B, dp, ds, HULL, up=(0.0, 1.0, 0.0))
        recess(B, (0.0, yc, hd + 0.024), (0.0, 0.0, 1.0), hw - 0.086,
               (y1 - y0) * 0.5 - 0.060, 0.014, HULL, r=0.024, up=(1.0, 0.0, 0.0))
        # door furniture, and it is different on every variant. Four of these
        # stand in a row 860 mm apart down the port wall: the handle is the
        # thing at eye height and it is what the eye uses to decide whether it
        # is looking at four lockers or at one locker four times.
        hx = hw - 0.115
        if variant == 2:
            # a paddle latch in a sunk cup, the sort a gloved hand hooks
            recess(B, (hx, yc, hd + 0.024), (0.0, 0.0, 1.0), 0.052, 0.034,
                   0.022, DK, r=0.008, up=(1.0, 0.0, 0.0))
            st2 = []
            for (t, sc) in ((0.006, 1.0), (0.020, 0.96), (0.030, 0.72)):
                st2.append([(hx + a * 0.044 * sc, yc - 0.006 + b * 0.026 * sc,
                             hd + 0.006 + t) for (a, b) in rrect(1.0, 1.0, 0.26, 4)])
            loft2(B, st2, RAIL, cap0=True, cap1=True)
            lathe(B, (hx - 0.040, yc, hd + 0.020), (0.0, 0.0, 1.0),
                  [(0.008, 0.0), (0.009, 0.008)], DK, 10, ref=(1.0, 0.0, 0.0))
        elif variant == 3:
            # a long lever on a pivot boss, canted down: the only handle in the
            # run that is not vertical
            lathe(B, (hx, yc + 0.140, hd + 0.024), (0.0, 0.0, 1.0),
                  [(0.0, 0.0), (0.026, 0.002), (0.028, 0.012), (0.020, 0.018)],
                  DK, 16, ref=(1.0, 0.0, 0.0))
            sweep_path(B, [(hx, yc + 0.140, hd + 0.036),
                           (hx - 0.010, yc + 0.020, hd + 0.040),
                           (hx - 0.014, yc - 0.096, hd + 0.052)],
                       0.0100, RAIL, 10, up=(0.0, 0.0, 1.0))
            lathe(B, (hx - 0.014, yc - 0.096, hd + 0.052), (0.0, 0.0, 1.0),
                  [(0.014, 0.0), (0.015, 0.010), (0.010, 0.016)], DK, 12,
                  ref=(1.0, 0.0, 0.0))
        else:
            lathe(B, (hx, yc, hd + 0.024), (0.0, 0.0, 1.0),
                  [(0.0, 0.0), (0.030, 0.002), (0.031, 0.010), (0.024, 0.016)],
                  DK, 16, ref=(1.0, 0.0, 0.0))
            sweep_path(B, [(hx, yc - 0.052, hd + 0.052), (hx, yc + 0.052, hd + 0.052)],
                       0.0095, RAIL, 10, up=(0.0, 0.0, 1.0))
            lathe(B, (hx, yc, hd + 0.016), (0.0, 0.0, 1.0),
                  [(0.010, 0.0), (0.010, 0.040)], RAIL, 10, ref=(1.0, 0.0, 0.0))
        for sy in (-1, 1):
            lathe(B, (-hw + 0.020, yc + sy * ((y1 - y0) * 0.5 - 0.046), hd + 0.006),
                  (0.0, 1.0, 0.0), [(0.014, -0.026), (0.015, -0.020),
                                    (0.015, 0.020), (0.014, 0.026)],
                  DK, 12, ref=(0.0, 0.0, 1.0), cap0=False, cap1=False)
        # louvre vent in the upper door, a data plate in the lower. On the
        # single-door variant the one door gets both, at the two ends.
        if k or ndoor == 1:
            for j in range(4):
                sweep_profile(
                    B, [(-hw + 0.100, y1 - 0.070 - j * 0.026, hd + 0.026),
                        (0.0, y1 - 0.069 - j * 0.026, hd + 0.028),
                        (hw - 0.180, y1 - 0.070 - j * 0.026, hd + 0.026)],
                    [[(-0.0022, 0.010), (0.0022, 0.007),
                      (0.0022, -0.007), (-0.0022, -0.010)]] * 3, DK,
                    up=(0.0, 1.0, 0.0))
        if k == 0:
            pad(B, (-hw + 0.150, y0 + 0.088, hd + 0.026), (0.0, 0.0, 1.0),
                0.088, 0.026, 0.004, AC, r=0.005, up=(1.0, 0.0, 0.0))
    # ---- what makes this one *this* locker.
    #      The review's last finding was the plainest: "six identical locker
    #      doors, identical handles, identical decals, no straps, labels, loose
    #      objects, cables or wear variation". Four of these stand in a row 860
    #      mm apart down the port wall and the eye reads a repeated asset in
    #      about a second. A second master costs one mesh and one entry in the
    #      occlusion bake, and it is the difference between a stowage run and a
    #      tiling pattern.
    if variant == 1:
        #      the lower door standing open on its hinge, with the shelf and
        #      what is on it visible behind
        yc0 = 0.110 + (hgt - 0.28) / 4
        ang = 0.62
        ca, sa = math.cos(ang), math.sin(ang)
        hxg = -hw + 0.020                     # the hinge line, port edge
        dw, dh = hw - 0.026, (hgt - 0.28) * 0.25
        dp, ds = [], []
        for (t, sc) in ((0.0, 1.000), (0.020, 0.992), (0.028, 0.958)):
            dp.append((hxg + (dw + t) * ca, yc0, hd - 0.004 + (dw + t) * sa))
            ds.append([(-a3 * sc, b3 * sc) for (a3, b3)
                       in rrect(dw, dh, 0.030, 4)])
        sweep_profile(B, dp, ds, HULL, up=(0.0, 1.0, 0.0))
        for sy in (-1, 1):
            lathe(B, (hxg, yc0 + sy * (dh - 0.046), hd + 0.006), (0.0, 1.0, 0.0),
                  [(0.016, -0.030), (0.017, -0.022), (0.017, 0.022),
                   (0.016, 0.030)], DK, 12, ref=(0.0, 0.0, 1.0),
                  cap0=False, cap1=False)
        #      the interior it now reveals: two shelves and three parcels, all
        #      different sizes and none of them square to the carcass
        for sy in (0.24, 0.52):
            B.box(-hw + 0.030, yc0 - dh + sy, -hd + 0.020,
                  hw - 0.030, yc0 - dh + sy + 0.014, hd - 0.030, DK)
        for (bx, by, bw, bh, bd, m) in ((-0.14, 0.268, 0.150, 0.115, 0.090, DK),
                                        (0.06, 0.268, 0.105, 0.150, 0.075, AC),
                                        (-0.05, 0.548, 0.220, 0.090, 0.100, HULL)):
            B.box(bx - bw/2, yc0 - dh + by, -hd + 0.030,
                  bx + bw/2, yc0 - dh + by + bh, -hd + 0.030 + bd, m)
        #      a strap across the upper door with a cam buckle on it
        yb = 0.110 + (hgt - 0.20) / 2 + (hgt - 0.28) / 4
        for zz in (hd + 0.028, hd + 0.030):
            B.box(-hw + 0.020, yb - 0.022, zz, hw - 0.020, yb + 0.022, zz + 0.004, RUB)
        B.box(-0.055, yb - 0.036, hd + 0.030, 0.055, yb + 0.036, hd + 0.046, RAIL)
        B.box(-0.034, yb - 0.020, hd + 0.046, 0.034, yb + 0.020, hd + 0.052, DK)
        #      and a second placard, taped on crooked, where the first is not
        pad(B, (hw - 0.190, yb + 0.130, hd + 0.026), (0.0, 0.0, 1.0),
            0.062, 0.038, 0.0035, HULL, r=0.004, up=(0.985, 0.174, 0.0))

    if variant == 2:
        #      the netted one. A cam-strap lattice over both doors, a ratchet
        #      on the cheek, a pushed-in top corner with the paint gone off the
        #      fold, and three labels at three angles -- which is what a locker
        #      somebody actually uses looks like next to one nobody opens.
        for t in (0.30, 0.62):
            yb = 0.110 + t * (hgt - 0.20)
            B.box(-hw + 0.014, yb - 0.017, hd + 0.026,
                  hw - 0.014, yb + 0.017, hd + 0.032, RUB)
        for xf in (-0.46, 0.10):
            xb = xf * w
            B.box(xb - 0.016, 0.130, hd + 0.026, xb + 0.016, hgt - 0.110, hd + 0.030, RUB)
        B.box(hw - 0.190, 0.110 + 0.30 * (hgt - 0.20) - 0.030, hd + 0.030,
              hw - 0.116, 0.110 + 0.30 * (hgt - 0.20) + 0.030, hd + 0.046, RAIL)
        lathe(B, (hw - 0.100, 0.110 + 0.30 * (hgt - 0.20), hd + 0.038),
              (1.0, 0.0, 0.0), [(0.0, 0.0), (0.020, 0.0), (0.022, 0.008),
                                (0.016, 0.014)], DK, 12, ref=(0.0, 1.0, 0.0))
        #      the dent: a pressed-in facet across the top outboard corner
        B.face([(hw - 0.150, hgt - 0.070, hd - 0.004),
                (hw - 0.020, hgt - 0.170, hd - 0.004),
                (hw - 0.020, hgt - 0.060, hd - 0.030),
                (hw - 0.086, hgt - 0.026, hd - 0.020)], HULL)
        B.face([(hw - 0.086, hgt - 0.026, hd - 0.020),
                (hw - 0.020, hgt - 0.060, hd - 0.030),
                (hw - 0.020, hgt - 0.060, hd + 0.010),
                (hw - 0.086, hgt - 0.026, hd + 0.014)], RAIL)
        for (lx, ly, ang, lw) in ((-hw + 0.120, hgt - 0.230, 0.0, 0.070),
                                  (-hw + 0.230, hgt - 0.250, 0.22, 0.044),
                                  (hw - 0.230, 0.240, -0.14, 0.056)):
            pad(B, (lx, ly, hd + 0.026), (0.0, 0.0, 1.0), lw, 0.020, 0.0032,
                HULL, r=0.003, up=(math.cos(ang), math.sin(ang), 0.0))
        #      a coil of line hung on a hook on the cheek
        lathe(B, (-hw - 0.012, hgt - 0.330, 0.0), (1.0, 0.0, 0.0),
              [(0.0, 0.0), (0.009, 0.0), (0.009, 0.030)], RAIL, 10,
              ref=(0.0, 1.0, 0.0))
        for r0 in (0.052, 0.062, 0.072):
            lathe(B, (-hw - 0.030, hgt - 0.392, 0.0), (1.0, 0.0, 0.0),
                  [(r0, -0.008), (r0 + 0.004, 0.0), (r0, 0.008)], RUB, 18,
                  ref=(0.0, 1.0, 0.0), cap0=False, cap1=False)
    if variant == 3:
        #      the tall one. A single full-height door already sets it apart in
        #      silhouette; what finishes it is a framed placard at head height,
        #      a barrel lock under the lever and a kit bag hung off the cheek.
        for (fx, fy, fw2, fh2) in ((0.0, hgt - 0.240, 0.126, 0.048),):
            recess(B, (fx, fy, hd + 0.026), (0.0, 0.0, 1.0), fw2, fh2, 0.006,
                   DK, r=0.005, up=(1.0, 0.0, 0.0))
            pad(B, (fx, fy, hd + 0.023), (0.0, 0.0, 1.0), fw2 - 0.010,
                fh2 - 0.009, 0.0028, HULL, r=0.003, up=(1.0, 0.0, 0.0))
            for sx in (-1, 1):
                hexbolt(B, (sx * (fw2 + 0.014), fy, hd + 0.026), (0.0, 0.0, 1.0),
                        0.0052, RAIL, up=(0.0, 1.0, 0.0))
        lathe(B, (hw - 0.115, 0.110 + (hgt - 0.28) * 0.5 - 0.190, hd + 0.024),
              (0.0, 0.0, 1.0), [(0.0, 0.0), (0.020, 0.0), (0.022, 0.008),
                                (0.014, 0.014), (0.014, 0.020)], RAIL, 14,
              ref=(1.0, 0.0, 0.0))
        st = []
        for (y, sw, sd, k) in ((0.0, 0.078, 0.062, 3.0), (0.070, 0.104, 0.084, 2.6),
                               (0.170, 0.098, 0.080, 2.4), (0.226, 0.050, 0.042, 2.2),
                               (0.250, 0.034, 0.030, 2.0)):
            st.append(sect(-hw - 0.106, hgt - 0.640 + y, 0.010, sw, sd, k, 14))
        loft2(B, st, MI['KIT_SEAT'], cap0=True, cap1=True)
        sweep_path(B, [(-hw - 0.106, hgt - 0.390, 0.010),
                       (-hw - 0.062, hgt - 0.344, 0.010),
                       (-hw - 0.014, hgt - 0.372, 0.010)], 0.0044, RUB, 8,
                   up=(0.0, 0.0, 1.0))
        lathe(B, (-hw - 0.012, hgt - 0.360, 0.010), (1.0, 0.0, 0.0),
              [(0.0, 0.0), (0.009, 0.0), (0.009, 0.026)], RAIL, 10,
              ref=(0.0, 1.0, 0.0))

    # top cap with a rolled front edge
    st = []
    for (y, sw, sd, k) in ((hgt + 0.006, hw - 0.004, hd + 0.020, 5.0),
                           (hgt + 0.026, hw, hd + 0.026, 4.4),
                           (hgt + 0.040, hw - 0.014, hd + 0.014, 4.0)):
        st.append(sect(0.0, y, 0.006, sw, sd, k, 18))
    loft2(B, st, DK)
    for sx in (-1, 1):
        hexbolt(B, (sx * (hw - 0.052), hgt + 0.040, 0.006), (0.0, 1.0, 0.0),
                0.0060, RAIL, up=(0.0, 0.0, 1.0))
    return B.obj(name)


def crate(name, s=0.50, seed=1):
    """A stacking transit case.

       Was a box, four corner boxes, two band boxes and two label boxes. It is
       a lofted shell with a real draft angle and softened corners, protective
       corner castings, over-centre latches turned out of a lathe, moulded
       stacking feet and a recessed label window."""
    B = Build()
    HULL, DK, AC, RAIL = (MI['KIT_HULL'], MI['KIT_DARK'],
                          MI['KIT_ACCENT'], MI['KIT_RAIL'])
    rng = random.Random(seed)
    hs = s / 2
    top = s * 0.90
    # shell: drafted, with a moulded waist rib where the two halves meet
    st = []
    for (y, sc, k) in ((0.020, 0.965, 5.4), (0.055, 0.995, 5.0),
                       (top * 0.47, 1.000, 4.6), (top * 0.50, 1.022, 4.2),
                       (top * 0.53, 1.000, 4.6), (top - 0.045, 0.992, 5.0),
                       (top - 0.006, 0.960, 5.4)):
        st.append(sect(0.0, y, 0.0, hs * sc, hs * sc, k, 20))
    loft2(B, st, HULL)
    # lid, standing a little proud, with a rolled edge
    st = []
    for (y, sc, k) in ((top - 0.020, hs * 0.985, 5.0), (top + 0.010, hs * 1.005, 4.4),
                       (top + 0.026, hs * 0.970, 4.2)):
        st.append(sect(0.0, y, 0.0, sc, sc, k, 20))
    loft2(B, st, DK)
    # corner castings and stacking feet
    for sx in (-1, 1):
        for sz in (-1, 1):
            cx, cz = sx * (hs - 0.036), sz * (hs - 0.036)
            st = []
            for (y, r_, k) in ((0.006, 0.052, 4.0), (0.060, 0.056, 3.6),
                               (top - 0.050, 0.056, 3.6), (top + 0.014, 0.050, 4.0)):
                st.append(sect(cx, y, cz, r_, r_, k, 12))
            loft2(B, st, DK)
            revolve(B, cx, cz, [(0.0, -0.008), (0.026, -0.008), (0.028, 0.002),
                                (0.024, 0.010)], DK, 12)
    # two over-centre latches on the front face, one of them swung open
    for (k, ang) in ((0, 0.0), (1, 0.55)):
        cy = top * (0.42 + 0.36 * k)
        lathe(B, (hs * (0.42 - 0.84 * k), cy, hs - 0.002), (0.0, 0.0, 1.0),
              [(0.0, 0.0), (0.022, 0.002), (0.023, 0.010), (0.018, 0.015)],
              DK, 12, ref=(0.0, 1.0, 0.0))
        cx = hs * (0.42 - 0.84 * k)
        sweep_path(B, [(cx - 0.020, cy - 0.026, hs + 0.014),
                       (cx - 0.020, cy + 0.020 - 0.030 * ang, hs + 0.014 + 0.050 * ang),
                       (cx + 0.020, cy + 0.020 - 0.030 * ang, hs + 0.014 + 0.050 * ang),
                       (cx + 0.020, cy - 0.026, hs + 0.014)],
                   0.0055, RAIL, 8, up=(0.0, 0.0, 1.0))
    # recessed label window, and a strap slot each side
    recess(B, (0.0, top * 0.62, hs + 0.001), (0.0, 0.0, 1.0), hs * 0.52, 0.052,
           0.008, DK, r=0.010, up=(1.0, 0.0, 0.0))
    pad(B, (0.0, top * 0.62, hs + 0.002), (0.0, 0.0, 1.0), hs * 0.44, 0.040,
        0.002, AC, r=0.006, up=(1.0, 0.0, 0.0))
    for sx in (-1, 1):
        recess(B, (sx * (hs - 0.001), top * 0.50, 0.0), (sx * 1.0, 0.0, 0.0),
               0.070, 0.020, 0.016, DK, r=0.009, up=(0.0, 0.0, 1.0))
    return B.obj(name)


def wallbox(name):
    """Junction box, breaker face, conduit glands.

       This is the closest prop to the player's face on the whole ship -- a
       hand's width away at the archive station -- and it was nine rectangles
       with five smaller rectangles inside them. It is a lofted enclosure with
       a rolled bezel, a hinged cover on real barrel hinges, four breakers off
       the same lathe the flight deck uses, a lathed isolator, and glands where
       the conduit enters."""
    B = Build()
    HULL, DK, AC, RAIL = (MI['KIT_HULL'], MI['KIT_DARK'],
                          MI['KIT_ACCENT'], MI['KIT_RAIL'])
    # the enclosure, swept along -Z (its face is at z -0.14)
    path, sects = [], []
    for (z, sc) in ((0.005, 0.94), (-0.020, 1.00), (-0.120, 1.00), (-0.148, 0.985)):
        path.append((0.0, 0.21, z))
        sects.append([(-a, b) for (a, b) in rrect(0.235 * sc, 0.205 * sc, 0.034, 4)])
    sweep_profile(B, path, sects, HULL, up=(0.0, 1.0, 0.0))
    # bezel: a rolled rim standing proud of the face
    bp, bs = [], []
    for (z, sc, hh) in ((-0.146, 1.000, 0.205), (-0.166, 1.012, 0.207),
                        (-0.178, 0.986, 0.202)):
        bp.append((0.0, 0.21, z))
        bs.append([(-a, b) for (a, b) in rrect(0.235 * sc, hh, 0.032, 4)])
    sweep_profile(B, bp, bs, DK, up=(0.0, 1.0, 0.0))
    recess(B, (0.0, 0.21, -0.170), (0.0, 0.0, -1.0), 0.196, 0.166, 0.026, DK,
           r=0.020, up=(1.0, 0.0, 0.0), seg=3)
    FACE = (0.0, 0.0, -1.0)
    for k in range(4):
        breaker(B, (-0.126 + k * 0.084, 0.255, -0.192), FACE, DK, HULL, AC,
                up=(1.0, 0.0, 0.0), s=1.5, tripped=(k == 2))
    for k in range(3):
        toggle(B, (-0.100 + k * 0.084, 0.150, -0.192), FACE, DK, RAIL, AC,
               up=(1.0, 0.0, 0.0), s=1.15, lean=(0.42 if k == 1 else -0.40))
    rotary(B, (0.132, 0.148, -0.192), FACE, DK, RAIL, AC, up=(1.0, 0.0, 0.0),
           s=0.95, ang=-0.7)
    pad(B, (-0.070, 0.348, -0.194), FACE, 0.086, 0.016, 0.004, AC, r=0.004,
        up=(1.0, 0.0, 0.0))
    # hinged cover, standing open on two barrels
    for sy in (-1, 1):
        lathe(B, (-0.238, 0.21 + sy * 0.150, -0.156), (0.0, 1.0, 0.0),
              [(0.013, -0.026), (0.014, -0.019), (0.014, 0.019), (0.013, 0.026)],
              DK, 12, ref=(0.0, 0.0, 1.0), cap0=False, cap1=False)
    flip_cover(B, (-0.238, 0.21, -0.150), (0.0, 0.0, -1.0), 0.200, 0.170, HULL,
               RAIL, up=(0.0, 1.0, 0.0), ang=0.72)
    # conduit glands and the stub each side, plus the drop into the deck
    for sx in (-1, 1):
        lathe(B, (sx * 0.232, 0.21, -0.070), (sx * 1.0, 0.0, 0.0),
              [(0.0, 0.0), (0.036, 0.004), (0.038, 0.016), (0.030, 0.024),
               (0.030, 0.030), (0.026, 0.036)], DK, 14, ref=(0.0, 1.0, 0.0))
        lathe(B, (sx * 0.268, 0.21, -0.070), (sx * 1.0, 0.0, 0.0),
              [(0.026, 0.0), (0.028, 0.008), (0.026, 0.016)], RAIL, 12,
              knurl(10, 0.06), ref=(0.0, 1.0, 0.0), cap0=False, cap1=False)
        sweep_path(B, [(sx * 0.290, 0.21, -0.070), (sx * 0.400, 0.21, -0.070)],
                   0.025, DK, 10, up=(0.0, 1.0, 0.0))
    lathe(B, (0.0, 0.040, -0.070), (0.0, -1.0, 0.0),
          [(0.0, -0.026), (0.040, -0.026), (0.042, -0.014), (0.034, -0.004)],
          DK, 14, ref=(0.0, 0.0, 1.0))
    sweep_path(B, [(0.0, 0.045, -0.070), (0.0, -0.36, -0.070)], 0.030, DK, 12,
               up=(0.0, 0.0, 1.0))
    return B.obj(name)


def _rope(B, pts, r, mat, zc=0.0):
    """A slung cable, as a staircase of short boxes along a polyline.

       Emitted as boxes rather than a swept tube on purpose. A sweep needs its
       side faces wound by hand and half of them come out inside-out, which for
       a FrontSide material means half the cable is simply missing and for the
       occlusion bake means it contributes nothing; B.box gets all six right.
       At 28 segments over two metres the steps are 3 cm on a 3 cm cable, which
       at corridor distance is a curve."""
    for (ax, ay), (bx2, by) in zip(pts, pts[1:]):
        B.box(min(ax, bx2), min(ay, by) - r, zc - r,
              max(ax, bx2), max(ay, by) + r, zc + r, mat)


def cable_drape(name, L=2.06, N=28):
    """Cable slung across the corridor ceiling, sagging under its own weight,
       with a service loop hanging off it.

       The corridor was the one interior frame the review called a real place,
       and what it said was missing is any sign that anyone lives in it. This
       is the cheapest possible sign: nobody routes a cable in a sag unless
       they added it after the ship was built."""
    B = Build()
    DK, AC, RAIL = MI['KIT_DARK'], MI['KIT_ACCENT'], MI['KIT_RAIL']
    # Sag is 0.13 m, not the 0.19 the first pass used. The corridor ceiling is
    # 2.25 m and a standing eye is at 1.66, so a bundle hung 0.20 m below the
    # deckhead with a deep sag comes down into the top of the frame and reads
    # as clutter falling on the camera rather than as a cable someone routed.
    for (sag, r, zc, m) in ((0.130, 0.017, -0.055, DK),
                            (0.100, 0.013, 0.005, AC),
                            (0.148, 0.011, 0.052, DK)):
        pts = []
        for k in range(N + 1):
            t = k / N
            x = -L / 2 + L * t
            pts.append((x, -sag * 4.0 * t * (1.0 - t)))
        _rope(B, pts, r, m, zc)
    # a service loop dropping out of the bundle, taped at the top
    loop = []
    for k in range(15):
        a = math.pi * k / 14
        loop.append((-0.34 + math.sin(a) * 0.085, -0.140 - (1 - math.cos(a)) * 0.105))
    _rope(B, loop, 0.012, DK, 0.0)
    B.box(-0.40, -0.162, -0.060, -0.26, -0.128, 0.060, RAIL)
    # clamps at both ends, and one in the middle carrying the whole bundle
    for x in (-L / 2 + 0.02, 0.0, L / 2 - 0.02):
        y = 0.0 if abs(x) > 0.3 else -0.130
        B.box(x - 0.030, y - 0.046, -0.070, x + 0.030, y + 0.026, 0.070, DK)
        B.box(x - 0.019, y - 0.058, -0.058, x + 0.019, y - 0.042, 0.058, RAIL)
    return B.obj(name)


def toolboard(name):
    """A shadow board on a wall: hose, hand tools, a clipboard and a rag.
       Wall-mounted and only 90 mm deep, so it dresses the corridor without
       taking any of the 1.72 m the player has to walk through."""
    B = Build()
    HULL, DK, AC, RAIL, RUB = (MI['KIT_HULL'], MI['KIT_DARK'], MI['KIT_ACCENT'],
                               MI['KIT_RAIL'], MI['KIT_RUBBER'])
    B.box(-0.28, 0.0, -0.030, 0.28, 0.66, 0.0, HULL)         # backing plate
    B.box(-0.255, 0.025, -0.042, 0.255, 0.635, -0.030, DK)   # perforated board
    for r in range(7):
        for c in range(6):
            B.box(-0.225 + c * 0.088, 0.060 + r * 0.086, -0.048,
                  -0.207 + c * 0.088, 0.078 + r * 0.086, -0.042, HULL)
    B.box(-0.28, 0.655, -0.038, 0.28, 0.685, 0.004, AC)      # legend rail
    # coiled hose, hung on a peg
    for k in range(14):
        a = 2 * math.pi * k / 14
        B.box(-0.145 + math.cos(a) * 0.082 - 0.014, 0.435 + math.sin(a) * 0.082 - 0.014, -0.082,
              -0.145 + math.cos(a) * 0.082 + 0.014, 0.435 + math.sin(a) * 0.082 + 0.014, -0.050, DK)
    B.box(-0.155, 0.500, -0.056, -0.135, 0.540, -0.036, RAIL)
    # four hand tools of different lengths, in their outlines
    for k, (ln, wd) in enumerate(((0.30, 0.030), (0.22, 0.044), (0.26, 0.022), (0.17, 0.052))):
        x = 0.030 + k * 0.056
        B.box(x - wd / 2, 0.520 - ln, -0.062, x + wd / 2, 0.520, -0.044, RAIL)
        B.box(x - wd / 2 - 0.006, 0.520 - ln * 0.34, -0.068, x + wd / 2 + 0.006, 0.520 - ln * 0.10,
              -0.040, RUB)
    # clipboard and a rag over the bottom rail
    B.box(-0.245, 0.055, -0.070, -0.055, 0.290, -0.052, HULL)
    B.box(-0.205, 0.245, -0.080, -0.095, 0.282, -0.062, RAIL)
    B.box(0.075, 0.070, -0.078, 0.230, 0.215, -0.044, MI['KIT_SEAT'])
    return B.obj(name)


def stack(name):
    """Two strapped crates and a rolled mat, left against a wall. Deliberately
       not square to anything: the placement rotates it, and the strap runs at
       a different height on each box."""
    B = Build()
    HULL, DK, AC, RAIL = (MI['KIT_HULL'], MI['KIT_DARK'], MI['KIT_ACCENT'],
                          MI['KIT_RAIL'])
    for (w, d, h, y0, ox, oz) in ((0.46, 0.34, 0.40, 0.0, 0.0, 0.0),
                                  (0.38, 0.30, 0.28, 0.40, 0.035, -0.02)):
        B.box(ox - w / 2, y0, oz - d / 2, ox + w / 2, y0 + h, oz + d / 2, HULL)
        for sx in (-1, 1):
            for sz in (-1, 1):
                B.box(ox + sx * w / 2, y0, oz + sz * d / 2,
                      ox + sx * (w / 2 - 0.042), y0 + h, oz + sz * (d / 2 - 0.042), DK)
        B.box(ox - w / 2 - 0.008, y0 + h * 0.42, oz - d / 2 - 0.008,
              ox + w / 2 + 0.008, y0 + h * 0.42 + 0.030, oz + d / 2 + 0.008, DK)
        B.box(ox - w * 0.24, y0 + h - 0.048, oz + d / 2, ox + w * 0.24, y0 + h - 0.012,
              oz + d / 2 + 0.008, AC)
    # a strap over the top, cinched
    B.box(-0.05, 0.40, -0.17, 0.02, 0.70, 0.15, MI['KIT_RUBBER'])
    B.box(-0.075, 0.545, 0.145, 0.045, 0.605, 0.175, RAIL)
    # rolled mat leaning against the stack
    for k in range(8):
        a = 2 * math.pi * k / 8
        B.box(0.30 + math.cos(a) * 0.075 - 0.022, 0.0, math.sin(a) * 0.075 - 0.022,
              0.30 + math.cos(a) * 0.075 + 0.022, 0.52, math.sin(a) * 0.075 + 0.022,
              MI['KIT_SEAT'])
    B.box(0.215, 0.235, -0.098, 0.385, 0.285, 0.098, MI['KIT_RUBBER'])
    return B.obj(name)


def coverall(name):
    """A suit on a hook. Soft-material, tapered, and it hangs off the wall by
       the shoulders -- which is the whole read: somebody took it off."""
    B = Build()
    SEAT, DK, RAIL = MI['KIT_SEAT'], MI['KIT_DARK'], MI['KIT_RAIL']
    B.box(-0.045, 0.955, -0.030, 0.045, 0.985, 0.030, RAIL)      # hook
    B.box(-0.020, 0.900, -0.014, 0.020, 0.960, 0.014, RAIL)
    B.box(-0.185, 0.855, -0.038, 0.185, 0.900, 0.038, DK)        # hanger
    for k in range(9):                                            # body, tapering
        t = k / 9.0
        w = 0.195 - t * t * 0.055
        d = 0.062 - t * 0.020
        B.box(-w, 0.855 - (k + 1) * 0.086, -d, w, 0.855 - k * 0.086, d, SEAT)
    for sx in (-1, 1):                                            # sleeves
        for k in range(5):
            t = k / 5.0
            B.box(sx * (0.150 + t * 0.052), 0.790 - k * 0.082, -0.048 + t * 0.010,
                  sx * (0.215 + t * 0.052), 0.860 - k * 0.082, 0.048 - t * 0.010, SEAT)
    B.box(-0.11, 0.700, -0.070, 0.11, 0.735, -0.052, MI['KIT_ACCENT'])   # chest tape
    B.box(-0.175, 0.455, -0.070, -0.055, 0.545, -0.056, DK)              # pocket
    return B.obj(name)


def pipe_run(name, L=2.2):
    B = Build()
    for k in range(4):
        y = 0.0 - k*0.052
        r = 0.030 + (k % 2)*0.010
        cyl_x(B, y, 0.0, -L/2, L/2, r, MI['KIT_DARK'] if k != 2 else MI['KIT_ACCENT'], 10)
    for k in range(3):
        x = -L/2 + L*(0.16 + 0.34*k)
        B.box(x-0.026, -0.20, -0.055, x+0.026, 0.055, 0.055, MI['KIT_DARK'])
    return B.obj(name)


# ------------------------------------------------------- personal effects
#
#  The all-areas review, comparing the habitat against Starfield: "steam_6.jpg
#  is 90% unique dressed props -- books, a cracked helmet, a strapped crate, a
#  poster -- and ours has none." The kit had *equipment* (a toolboard, a cable
#  drape, crates, a hung coverall) and no evidence that anybody in particular
#  lives here. Equipment says the ship is maintained; a helmet somebody cracked
#  and did not throw away says somebody survived something in it.
#
#  All four of these are unique, all four are asymmetric, and none of them is
#  placed twice.

def _panel(B, ox, oy, oz, w, h, mat, nx=7, ny=5, curl=0.0, sag=0.0, thick=0.0015):
    """A sheet of something thin pinned to a wall, with a corner peeling off.

       Emitted as a displaced grid rather than as a box, because the whole read
       of a pinned chart is that it is *not* flat: paper that has been up for a
       year lifts at one corner, bellies between its pins, and catches a hard
       line of light down the lift. A rectangle with a texture on it never
       does. Faces are doubled so the underside of the lift is real."""
    def at(u, v):
        # u across, v up, both 0..1. z is standoff from the wall.
        c = curl * (u ** 2.6) * ((1.0 - v) ** 2.0)
        s = sag * math.sin(math.pi * u) * math.sin(math.pi * v)
        return (ox + (u - 0.5) * w, oy + (v - 0.5) * h, oz + c + s)
    for i in range(nx):
        for j in range(ny):
            u0, u1 = i / nx, (i + 1) / nx
            v0, v1 = j / ny, (j + 1) / ny
            a, b, c, d = at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)
            B.quad(a, b, c, d, mat)
            e = (0.0, 0.0, -thick)
            B.quad(tuple(d[k] + e[k] for k in range(3)),
                   tuple(c[k] + e[k] for k in range(3)),
                   tuple(b[k] + e[k] for k in range(3)),
                   tuple(a[k] + e[k] for k in range(3)), mat)


def pinboard(name):
    """A chart taped to the wall, two photographs and a duty roster.

       Modelled facing +Z and hung on the starboard wall, so Interior.js turns
       it -pi/2. The chart is the only large flat thing in the cabin allowed to
       be off-square: it is pinned by a person, and a person does not measure."""
    B = Build()
    HULL, DK, AC, RAIL, SEAT = (MI['KIT_HULL'], MI['KIT_DARK'], MI['KIT_ACCENT'],
                                MI['KIT_RAIL'], MI['KIT_SEAT'])
    # a strip of ply screwed to the wall to pin things to
    st = []
    for (z, sc) in ((0.0, 0.995), (0.010, 1.0), (0.016, 0.984)):
        st.append([(-a, b) for (a, b) in rrect(0.42 * sc, 0.30 * sc, 0.018, 4)])
    sweep_profile(B, [(0.0, 0.0, 0.0), (0.0, 0.0, 0.010), (0.0, 0.0, 0.016)],
                  st, HULL, up=(0.0, 1.0, 0.0))
    for (sx, sy) in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        hexbolt(B, (sx * 0.386, sy * 0.266, 0.016), (0.0, 0.0, 1.0), 0.0058,
                RAIL, up=(0.0, 1.0, 0.0))
    # the chart: big, off-square, lifting at the right-hand lower corner
    _panel(B, 0.03, 0.02, 0.019, 0.52, 0.38, HULL, 9, 7, curl=0.052, sag=0.006)
    for (px, py) in ((-0.20, 0.19), (0.26, 0.20), (-0.22, -0.15)):
        lathe(B, (px, py, 0.0225), (0.0, 0.0, 1.0),
              [(0.0, 0.0), (0.0075, 0.0015), (0.0080, 0.0055), (0.0045, 0.0080)],
              AC if px < 0 else RAIL, 12, ref=(0.0, 1.0, 0.0))
    # two photographs, taped rather than pinned, at different angles
    for (px, py, w, h, tilt) in ((-0.255, -0.05, 0.085, 0.062, 0.16),
                                 (-0.245, -0.185, 0.070, 0.052, -0.11)):
        _panel(B, px, py, 0.0215, w, h, SEAT, 3, 3, sag=0.0015)
        for sy in (-1, 1):
            B.box(px - w * 0.28, py + sy * (h * 0.5 - 0.004) - 0.004,
                  0.0215, px + w * 0.28, py + sy * (h * 0.5 - 0.004) + 0.004,
                  0.0235, RAIL)
    # a duty roster on a clipboard, hung off one pin
    B.box(-0.05, -0.28, 0.019, 0.115, -0.055, 0.0235, DK)
    _panel(B, 0.032, -0.170, 0.0245, 0.145, 0.195, HULL, 4, 5, sag=0.0022)
    B.box(-0.008, -0.088, 0.0245, 0.072, -0.062, 0.0275, RAIL)
    for k in range(6):
        B.box(-0.028, -0.245 + k * 0.026, 0.0262, 0.088, -0.241 + k * 0.026,
              0.0268, AC if k == 2 else DK)
    return B.obj(name)


def helmet(name):
    """A cracked EVA helmet, put down on its side and never dealt with.

       Every other prop in this kit is a thing the ship needs. This one is a
       thing that happened. It is lathed and revolved rather than stacked, the
       visor is a real dished lens on its own axis, and the crack is a swept
       polyline in the shell -- close enough to walk up to, which is the point
       of putting it on top of a locker at eye height."""
    B = Build()
    HULL, DK, AC, RAIL, RUB = (MI['KIT_HULL'], MI['KIT_DARK'], MI['KIT_ACCENT'],
                               MI['KIT_RAIL'], MI['KIT_RUBBER'])
    # the shell: a revolved dome with a flattened crown and a rolled neck flange
    revolve(B, 0.0, 0.0, [(0.000, 0.242), (0.062, 0.240), (0.108, 0.229),
                          (0.146, 0.208), (0.166, 0.180), (0.174, 0.144),
                          (0.174, 0.102), (0.168, 0.068), (0.156, 0.046),
                          (0.150, 0.030), (0.156, 0.018), (0.150, 0.008)],
            HULL, 26)
    # neck ring: a machined collar with a bayonet lip and three lugs
    revolve(B, 0.0, 0.0, [(0.140, 0.006), (0.152, 0.004), (0.156, -0.010),
                          (0.152, -0.026), (0.138, -0.030), (0.132, -0.014)],
            RAIL, 26)
    revolve(B, 0.0, 0.0, [(0.126, -0.030), (0.134, -0.034), (0.134, -0.052),
                          (0.124, -0.056)], RUB, 24)
    for k in range(3):
        a = 2 * math.pi * k / 3 + 0.4
        lathe(B, (math.cos(a) * 0.152, -0.014, math.sin(a) * 0.152),
              (math.cos(a), 0.0, math.sin(a)),
              [(0.014, 0.0), (0.016, 0.006), (0.013, 0.013)], RAIL, 12,
              ref=(0.0, 1.0, 0.0))
    # the visor: a dished lens on its own axis, tipped forward and down, with a
    # gasket round it and a sun shade half-lowered over the top of it
    VA = (0.0, -0.34, 0.94)
    VC = (0.0, 0.118, 0.104)
    lathe(B, VC, VA, [(0.0, 0.052), (0.052, 0.050), (0.086, 0.038),
                      (0.108, 0.016), (0.114, -0.006)], DK, 26,
          ref=(0.0, 1.0, 0.0), cap1=False)
    lathe(B, VC, VA, [(0.110, -0.008), (0.122, -0.004), (0.124, -0.020),
                      (0.112, -0.026)], RAIL, 26, ref=(0.0, 1.0, 0.0),
          cap0=False, cap1=False)
    lathe(B, (VC[0] + VA[0] * 0.012, VC[1] + VA[1] * 0.012, VC[2] + VA[2] * 0.012),
          VA, [(0.100, 0.030), (0.116, 0.026), (0.118, 0.010)], AC, 24,
          ref=(0.0, 1.0, 0.0), cap0=False, cap1=False)
    # the crack: a jagged run across the upper right of the visor surround,
    # with a chip out of the shell where it started
    crack = [(0.070, 0.196, 0.062), (0.092, 0.184, 0.052), (0.084, 0.166, 0.070),
             (0.108, 0.150, 0.062), (0.098, 0.128, 0.078), (0.120, 0.108, 0.066),
             (0.112, 0.086, 0.080)]
    sweep_path(B, crack, [0.0026, 0.0032, 0.0028, 0.0034, 0.0026, 0.0030, 0.0018],
               DK, 6, up=(0.0, 1.0, 0.0))
    revolve(B, 0.072, 0.060, [(0.0, 0.196), (0.018, 0.198), (0.020, 0.206)],
            DK, 12)
    # a lamp cluster and an antenna stub on the left temple, and a name tape
    for k in range(2):
        lathe(B, (-0.150 - k * 0.004, 0.140 + k * 0.030, 0.020),
              (-0.94, 0.28, 0.18),
              [(0.0, 0.0), (0.020, 0.004), (0.021, 0.014), (0.014, 0.020)],
              DK, 14, ref=(0.0, 1.0, 0.0))
    sweep_path(B, [(-0.146, 0.176, -0.026), (-0.170, 0.208, -0.048),
                   (-0.176, 0.238, -0.052)], 0.0038, RAIL, 8, up=(0.0, 0.0, 1.0))
    pad(B, (-0.058, 0.040, -0.150), (0.0, 0.0, -1.0), 0.052, 0.013, 0.0022, AC,
        r=0.003, up=(0.0, 1.0, 0.0))
    ob = B.obj(name)
    # Laid on its side and rolled, so it reads as put down rather than
    # displayed. Baked into the mesh: the exporter zeroes every transform.
    ob.data.transform(Matrix.Rotation(math.radians(74), 4, 'X')
                      @ Matrix.Rotation(math.radians(-21), 4, 'Z'))
    return ob


def slates(name):
    """A shelf of data slates and two bound books, leaning.

       Nine slabs, no two the same thickness, height or lean, one lying flat
       across the top of the others and one that has slid down. A rank of equal
       slabs is a texture; this is the one prop in the kit whose entire subject
       is that nobody tidied it."""
    B = Build()
    HULL, DK, AC, RAIL, SEAT, RUB = (MI['KIT_HULL'], MI['KIT_DARK'],
                                     MI['KIT_ACCENT'], MI['KIT_RAIL'],
                                     MI['KIT_SEAT'], MI['KIT_RUBBER'])
    W, D = 0.62, 0.19
    # the shelf: a pressed tray with a rolled lip and two folded brackets
    sp, ss = [], []
    for (x, sc) in ((-W / 2, 0.984), (-W / 2 + 0.014, 1.0),
                    (W / 2 - 0.014, 1.0), (W / 2, 0.984)):
        sp.append((x, 0.0, 0.0))
        ss.append([(a * sc, b * sc) for (a, b) in
                   ((-D * 0.5, 0.012), (-D * 0.5 + 0.010, 0.026),
                    (-D * 0.5 + 0.030, 0.020), (D * 0.5 - 0.006, 0.016),
                    (D * 0.5, 0.006), (D * 0.5 - 0.004, -0.010),
                    (-D * 0.5 + 0.004, -0.012))])
    sweep_profile(B, sp, ss, HULL, up=(0.0, 1.0, 0.0))
    for sx in (-1, 1):
        st = []
        for (y, w, d) in ((-0.150, 0.010, 0.030), (-0.020, 0.013, 0.062),
                          (0.000, 0.013, 0.070)):
            st.append(sect(sx * (W / 2 - 0.045), y, 0.010, w, d, 4.0, 10))
        loft2(B, st, DK)
        hexbolt(B, (sx * (W / 2 - 0.045), -0.150, 0.010), (0.0, -1.0, 0.0),
                0.0055, RAIL, up=(1.0, 0.0, 0.0))
    # the slates. thickness, height, lean and material all vary, and the run
    # collapses into a leaning stack two thirds of the way along
    rng = random.Random(41)
    x = -W / 2 + 0.028
    tops = []
    for k in range(9):
        t = 0.017 + rng.random() * 0.017
        hh = 0.150 + rng.random() * 0.085
        lean = (0.02 + rng.random() * 0.10) * (1.0 if k > 5 else 0.10)
        m = (SEAT if k in (2, 7) else DK if k % 3 else HULL)
        # a slab with a rolled spine, swept so the lean is a real shear
        pth, sec = [], []
        for (yy, sc) in ((0.014, 1.0), (hh * 0.5, 1.0), (hh, 0.985)):
            pth.append((x + lean * yy, yy, 0.0))
            sec.append([(a, b) for (a, b) in
                        ((-t * 0.5 * sc, -D * 0.42), (t * 0.5 * sc, -D * 0.42),
                         (t * 0.5 * sc, D * 0.40), (t * 0.34 * sc, D * 0.44),
                         (-t * 0.34 * sc, D * 0.44), (-t * 0.5 * sc, D * 0.40))])
        sweep_profile(B, pth, sec, m, up=(0.0, 0.0, 1.0))
        # a label band on the spine of about half of them
        if k % 2 == 0:
            B.box(x + lean * hh * 0.62 - t * 0.30, hh * 0.58, D * 0.442,
                  x + lean * hh * 0.62 + t * 0.30, hh * 0.70, D * 0.452,
                  AC if k == 4 else RAIL)
        tops.append((x + lean * hh, hh, t))
        x += t + 0.004
    # one lying flat across the tops of the last few, and a mug beside it
    lx, ly, _ = tops[6]
    pth, sec = [], []
    for (xx, sc) in ((lx - 0.115, 0.99), (lx + 0.005, 1.0), (lx + 0.120, 0.99)):
        pth.append((xx, ly + 0.020 + (xx - lx) * 0.06, 0.006))
        sec.append([(a * sc, b * sc) for (a, b) in
                    ((-D * 0.40, -0.012), (D * 0.42, -0.011),
                     (D * 0.44, 0.010), (-D * 0.38, 0.012))])
    sweep_profile(B, pth, sec, HULL, up=(0.0, 1.0, 0.0))
    B.box(lx - 0.070, ly + 0.032, -0.040, lx + 0.060, ly + 0.036, 0.020, AC)
    # a mug, ring-stained, at the open end of the shelf
    mx = W / 2 - 0.070
    revolve(B, mx, -0.010, [(0.000, 0.016), (0.036, 0.017), (0.039, 0.030),
                            (0.040, 0.082), (0.038, 0.086), (0.033, 0.084),
                            (0.033, 0.024), (0.030, 0.020)], HULL, 22)
    sweep_path(B, [(mx + 0.038, 0.038, -0.010), (mx + 0.068, 0.052, -0.010),
                   (mx + 0.070, 0.074, -0.010), (mx + 0.040, 0.082, -0.010)],
               0.0065, HULL, 8, up=(0.0, 0.0, 1.0))
    revolve(B, mx, -0.010, [(0.030, 0.0165), (0.044, 0.0168)], RUB, 20,
            cap0=False, cap1=False)
    return B.obj(name)


# ------------------------------------------------------- the resonance chamber
def disc_z(B, cx, cy, z, r0, r1, mat, seg=40, behind=1.0):
    """A flat annulus in the XY plane, facing the room.

       `lathe` cannot make this one and it is worth knowing why, because the
       failure is spectacular and does not look like a winding bug. loft2 winds
       each face away from the midpoint of its two ring centroids, which for a
       flat annulus lies *in the plane of the face*: the outward test becomes a
       dot product of zero and the sign is decided by the last bit of the
       floating-point sum. What renders is a pinwheel -- alternating wedges of
       front and back face round the whole disc, with the wall visible through
       every other one. Handing it a reference point genuinely behind the plane
       removes the degeneracy."""
    ref = (cx, cy, z + behind)
    for i in range(seg):
        a0, a1 = 2*math.pi*i/seg, 2*math.pi*(i+1)/seg
        face_out(B, [(cx+math.cos(a0)*r0, cy+math.sin(a0)*r0, z),
                     (cx+math.cos(a1)*r0, cy+math.sin(a1)*r0, z),
                     (cx+math.cos(a1)*r1, cy+math.sin(a1)*r1, z),
                     (cx+math.cos(a0)*r1, cy+math.sin(a0)*r1, z)], ref, mat)


def resonance_wall(name='resonance'):
    """The aft bulkhead of the habitat, and the instrument set into it.

       What was here was two boxes. A 3.4 x 2.4 m slab of `M.panel` with a
       1.9 x 1.6 m slab of `M.dark` laid on it, seven torus rings and an
       icosahedron -- one of the two station walls the player walks up to and
       stands in front of, and by a wide margin the flattest surface in the
       ship. The review's phrase for it was "a 3 m plate of pure texture ...
       reads as wallpaper", and it is the clearest single case of the owner's
       complaint about piles of rectangles, because that is literally what it
       was.

       Everything here is the same wall doing the same job with the detail
       *modelled*: a stepped surround with real depth, plating with real seams
       and real fasteners, a sunk drum with seven machined sockets round it,
       a louvred cooling stack, cable trunking that goes somewhere, gauges,
       grab handles and a tripping hazard. The emissive rings and cores stay in
       Interior.js -- they animate, so they cannot be baked into the kit -- and
       what the kit provides is the wells they sit in.

       Authored in absolute cabin coordinates like the cockpit pieces: the wall
       plane is z 7.10 and everything stands forward of it."""
    B = Build()
    DK, AC, RAIL, HULL, RUB = (MI['KIT_DARK'], MI['KIT_ACCENT'], MI['KIT_RAIL'],
                               MI['KIT_HULL'], MI['KIT_RUBBER'])
    ZW = 7.10                      # the wall plane
    CY = 1.30                      # centre of the instrument
    zf = lambda d: ZW - d          # d metres proud of the wall

    # ---- the plating. Nine plates on a deliberately irregular grid with a
    #      26 mm groove between them, each standing 18 mm off the backing, with
    #      a countersunk fastener at every corner. A regular 3x3 would read as
    #      tiling; the columns are 1.02 / 1.36 / 1.02 and the courses differ.
    B.box(-1.70, 0.10, ZW, 1.70, 2.44, ZW + 0.10, HULL)
    XS = [-1.70, -0.68, 0.68, 1.70]
    YS = [0.10, 0.92, 1.72, 2.44]
    for a in range(3):
        for b in range(3):
            if a == 1 and b == 1:
                continue                       # the instrument bay goes here
            x0, x1 = XS[a] + 0.013, XS[a+1] - 0.013
            y0, y1 = YS[b] + 0.013, YS[b+1] - 0.013
            B.box(x0, y0, zf(0.018), x1, y1, ZW, HULL)
            for sa in (0, 1):
                for sb in (0, 1):
                    cx = x0 + 0.044 if sa == 0 else x1 - 0.044
                    cy = y0 + 0.044 if sb == 0 else y1 - 0.044
                    cyl_z(B, cx, cy, zf(0.026), zf(0.014), 0.014, DK, 8)
                    disc_z(B, cx, cy, zf(0.026), 0.014, 0.0, DK, 8)

    # ---- the instrument bay: a stepped surround sunk into the plating, with
    #      the drum at the bottom of it. Four rings rather than a single wall,
    #      so the bay has a lit face and a shaded one at every step.
    for (d, hw, hh, m) in ((0.018, 0.700, 0.700, DK), (0.052, 0.660, 0.660, DK),
                           (0.078, 0.628, 0.628, HULL)):
        for (ax, ay, bx, by) in ((-hw, -hh, hw, -hh + 0.030),
                                 (-hw, hh - 0.030, hw, hh),
                                 (-hw, -hh, -hw + 0.030, hh),
                                 (hw - 0.030, -hh, hw, hh)):
            B.box(ax, CY + ay, zf(d), bx, CY + by, zf(d - 0.034), m)
    lathe(B, (0.0, CY, zf(0.062)), (0.0, 0.0, -1.0),
          [(0.700, 0.0), (0.680, 0.014), (0.640, 0.020), (0.620, 0.050),
           (0.624, 0.062), (0.606, 0.070)], DK, 40, ref=(0.0, 1.0, 0.0),
          cap0=False, cap1=False)
    #      the drum floor and its machined centre boss
    disc_z(B, 0.0, CY, zf(0.070), 0.606, 0.150, HULL, 40)
    lathe(B, (0.0, CY, zf(0.070)), (0.0, 0.0, -1.0),
          [(0.150, 0.0), (0.140, 0.016), (0.120, 0.038),
           (0.104, 0.044), (0.086, 0.062), (0.082, 0.066)], HULL, 40,
          ref=(0.0, 1.0, 0.0), cap0=False, cap1=False)
    lathe(B, (0.0, CY, zf(0.132)), (0.0, 0.0, -1.0),
          [(0.086, 0.0), (0.092, 0.008), (0.088, 0.026), (0.070, 0.034),
           (0.052, 0.036)], RAIL, 24, ref=(0.0, 1.0, 0.0), cap0=False)

    # ---- the seven socket wells. Interior.js drops an emissive ring and a
    #      core into each; what it needs from here is somewhere for them to sit.
    #      A collar standing off the drum wall, a well sunk behind it, a
    #      retaining ring, a locating key and a hex fastener pair -- and the
    #      keys are clocked differently on every socket, which is the cheapest
    #      way to stop seven identical fittings reading as seven copies.
    for i in range(7):
        a = -math.pi / 2 + (i / 7.0) * math.pi * 2
        sx, sy = math.cos(a) * 0.52, CY + math.sin(a) * 0.52
        lathe(B, (sx, sy, zf(0.070)), (0.0, 0.0, -1.0),
              [(0.115, 0.0), (0.112, 0.012), (0.098, 0.020), (0.096, 0.046),
               (0.086, 0.052), (0.086, 0.030), (0.070, 0.024), (0.070, -0.030)],
              DK, 20, ref=(0.0, 1.0, 0.0), cap0=False, cap1=False)
        lathe(B, (sx, sy, zf(0.116)), (0.0, 0.0, -1.0),
              [(0.086, 0.0), (0.090, 0.006), (0.088, 0.016), (0.078, 0.020)],
              RAIL, 20, ref=(0.0, 1.0, 0.0), cap0=False, cap1=False)
        # locating key, clocked per socket
        ka = a + 0.9 + i * 0.7
        B.box(sx + math.cos(ka) * 0.074 - 0.011, sy + math.sin(ka) * 0.074 - 0.011,
              zf(0.126), sx + math.cos(ka) * 0.074 + 0.011,
              sy + math.sin(ka) * 0.074 + 0.011, zf(0.100), AC)
        for k in (0, 1):
            ba = a + math.pi * 0.5 + k * math.pi
            cyl_z(B, sx + math.cos(ba) * 0.104, sy + math.sin(ba) * 0.104,
                  zf(0.088), zf(0.070), 0.011, RAIL, 6)

    # ---- a louvred cooling stack up the port plate, cable trunking down the
    #      starboard one, and the two grab handles either side of the bay.
    #      Different fittings on the two sides, at different heights: the wall
    #      was perfectly symmetric and read as generated.
    for k in range(7):
        y = 1.62 + k * 0.062
        B.box(-1.52, y, zf(0.062), -0.86, y + 0.040, zf(0.026), DK)
        B.box(-1.52, y + 0.006, zf(0.026), -0.86, y + 0.034, zf(0.018), HULL)
    B.box(-1.56, 1.56, zf(0.070), -0.82, 1.62, zf(0.014), DK)
    B.box(-1.56, 2.06, zf(0.070), -0.82, 2.12, zf(0.014), DK)
    #      trunking: a capped duct that leaves the wall and turns into the deck
    for (y0, y1, w) in ((0.20, 1.66, 0.115), (0.20, 1.20, 0.075)):
        x = 1.16 if w > 0.10 else 1.40
        B.box(x - w, y0, zf(0.052), x + w, y1, ZW, DK)
        B.box(x - w * 0.72, y0, zf(0.070), x + w * 0.72, y1 - 0.06, zf(0.052), HULL)
        for k in range(int((y1 - y0) / 0.34)):
            yy = y0 + 0.18 + k * 0.34
            B.box(x - w - 0.014, yy, zf(0.078), x + w + 0.014, yy + 0.036, ZW, RAIL)
        lathe(B, (x, y1, zf(0.052)), (0.0, 1.0, 0.0),
              [(w * 0.98, -0.010), (w * 1.06, 0.004), (w * 1.06, 0.030),
               (w * 0.80, 0.044)], DK, 16, ref=(0.0, 0.0, 1.0), cap0=False)
    for (sx, y) in ((-1, 0.96), (1, 1.86)):
        for k in (-1, 1):
            cyl_z(B, sx * 0.86, y + k * 0.15, zf(0.108), zf(0.020), 0.026, DK, 10)
        cyl_y(B, sx * 0.86, 0.0, y - 0.15, y + 0.15, 0.020, RAIL, 12, taper=1.0)
    # ---- three gauges on the starboard plate, and a placard under them
    for k in range(3):
        gx = 1.02 + k * 0.20
        lathe(B, (gx, 2.06, zf(0.018)), (0.0, 0.0, -1.0),
              [(0.070, 0.0), (0.074, 0.010), (0.070, 0.030), (0.058, 0.036),
               (0.052, 0.030)], DK, 18, ref=(0.0, 1.0, 0.0), cap0=False)
        lathe(B, (gx, 2.06, zf(0.048)), (0.0, 0.0, -1.0),
              [(0.052, 0.0), (0.050, 0.006)], RAIL, 18, ref=(0.0, 1.0, 0.0),
              cap0=False, cap1=False)
        B.box(gx - 0.003, 2.06, zf(0.056), gx + 0.003, 2.11, zf(0.050), AC)
    B.box(0.94, 1.90, zf(0.026), 1.66, 1.96, zf(0.018), AC)
    # ---- and the thing everybody trips on: a raised threshold at the deck
    B.box(-1.62, 0.08, zf(0.150), 1.62, 0.18, ZW, DK)
    B.box(-1.62, 0.16, zf(0.166), 1.62, 0.20, zf(0.132), AC)
    return B.obj(name)


# =============================================================================
#  The two habitat stations the player walks up to and stands in front of.
#
#  Both of these were still what the resonance wall used to be. The archive
#  terminal was three slabs and twenty-two identical 55 mm cubes on a shelf;
#  the observation port was a torus, a circle and six identical bosses. They
#  are the two fittings in the ship the player approaches to arm's length and
#  then stops in front of, which is the worst possible place for a primitive.
#
#  Both are authored in the frame Interior.js places them in -- x across the
#  fitting, y up from the deck, z out of the wall into the room -- so the
#  numbers here and the numbers in placeKit() are the same numbers.
# =============================================================================

def loop_rrect(hw, hh, r, n=4):
    """A closed rounded-rectangle loop in XY, 4*(n+1) points, CCW."""
    r = min(r, hw * 0.98, hh * 0.98)
    p = []
    for (cx, cy, a0) in ((hw - r, hh - r, 0.0), (-(hw - r), hh - r, math.pi * 0.5),
                         (-(hw - r), -(hh - r), math.pi), (hw - r, -(hh - r), math.pi * 1.5)):
        for i in range(n + 1):
            a = a0 + (math.pi * 0.5) * (i / n)
            p.append((cx + math.cos(a) * r, cy + math.sin(a) * r))
    return p


def loop_circle(r, n, phase=0.0):
    """A closed circle in XY with the same point count as loop_rrect(n=k)."""
    return [(math.cos(phase + 2 * math.pi * i / n) * r,
             math.sin(phase + 2 * math.pi * i / n) * r) for i in range(n)]


def prism_z(B, loop, z0, z1, mat, cap0=True, cap1=True):
    """A closed XY loop given thickness along Z, every face wound outward."""
    cx = sum(p[0] for p in loop) / len(loop)
    cy = sum(p[1] for p in loop) / len(loop)
    ref = (cx, cy, (z0 + z1) * 0.5)
    A = [(p[0], p[1], z0) for p in loop]
    C = [(p[0], p[1], z1) for p in loop]
    n = len(loop)
    for i in range(n):
        j = (i + 1) % n
        face_out(B, [A[i], A[j], C[j], C[i]], ref, mat)
    if cap0:
        cap_fan(B, A, mat, ref)
    if cap1:
        cap_fan(B, C, mat, ref)


def annulus_z(B, outer, inner, z, mat, behind=1.0):
    """The face between two closed XY loops of equal length, at one z.

       disc_z's job for a shape that is not a circle: a doubler plate with a
       bore through it has an outer outline that is a rounded square and an
       inner one that is round, and there is no lathe that makes that."""
    n = len(outer)
    ref = (0.0, 0.0, z + behind)
    for i in range(n):
        j = (i + 1) % n
        face_out(B, [(outer[i][0], outer[i][1], z), (outer[j][0], outer[j][1], z),
                     (inner[j][0], inner[j][1], z), (inner[i][0], inner[i][1], z)],
                 ref, mat)


def bore_z(B, z0, z1, r0, r1, mat, seg=48):
    """A tube wound so its *inside* is the visible face: a hole in a wall.

       cyl_z faces outward, which for a bore means the whole barrel is
       backface-culled and the player looks through the hull. Two normalised
       radii and a reference point on the axis settle it."""
    for i in range(seg):
        a0, a1 = 2 * math.pi * i / seg, 2 * math.pi * (i + 1) / seg
        p = [(math.cos(a0) * r0, math.sin(a0) * r0, z0),
             (math.cos(a1) * r0, math.sin(a1) * r0, z0),
             (math.cos(a1) * r1, math.sin(a1) * r1, z1),
             (math.cos(a0) * r1, math.sin(a0) * r1, z1)]
        # the axis is *outside* the solid here, so wind toward it
        c = ((p[0][0] + p[2][0]) * 0.5, (p[0][1] + p[2][1]) * 0.5,
             (p[0][2] + p[2][2]) * 0.5)
        face_out(B, p, (c[0] * 3.0, c[1] * 3.0, c[2]), mat)


def keycap(B, cx, cz, y0, w, d, mat, h=0.0145, dish=0.0026, taper=0.855,
           legend=(), lm=None):
    """One key.

       A keycap is not a cube, and four things are what stop it being one:

         · the top is smaller than the base -- six degrees of draft, which is
           what a moulded cap has and what puts a lit band on the near wall and
           a dark one on the far wall of every key in the frame;
         · the top is *dished*, so the key light crosses it as a gradient
           rather than as one flat value. A flat cap top is the single loudest
           tell, because twenty-two of them return twenty-two identical values
           and the eye reads a painted grid;
         · it stands in a well with a 1.5 mm gap all round, so there is a real
           shadow line on four sides instead of a drawn one;
         · and it has travel. A few caps in the block sit 1.5 mm down.

       `legend` is a list of (u0, v0, u1, v1) bars in cap-fractional coords,
       raised 0.8 mm. At 0.6 m on a 2x display a 55 mm cap is about 120 px, so
       a 6 mm mark lands at a dozen -- not readable as a letter, exactly as
       readable as a marking, which is what a key at arm's length is."""
    hw0, hd0 = w * 0.5, d * 0.5
    hw1, hd1 = hw0 * taper, hd0 * taper
    y1 = y0 + h
    ref = (cx, y0 + h * 0.45, cz)
    A = [(cx - hw0, y0, cz - hd0), (cx + hw0, y0, cz - hd0),
         (cx + hw0, y0, cz + hd0), (cx - hw0, y0, cz + hd0)]
    C = [(cx - hw1, y1, cz - hd1), (cx + hw1, y1, cz - hd1),
         (cx + hw1, y1, cz + hd1), (cx - hw1, y1, cz + hd1)]
    for i in range(4):
        j = (i + 1) % 4
        face_out(B, [A[i], A[j], C[j], C[i]], ref, mat)
    face_out(B, A, ref, mat)
    N = 3

    def tp(i, k):
        u, v = i / N, k / N
        dx, dz = (u - 0.5) * 2.0, (v - 0.5) * 2.0
        return (cx - hw1 + 2 * hw1 * u,
                y1 - dish * (1.0 - dx * dx) * (1.0 - 0.5 * dz * dz),
                cz - hd1 + 2 * hd1 * v)
    for i in range(N):
        for k in range(N):
            face_out(B, [tp(i, k), tp(i + 1, k), tp(i + 1, k + 1), tp(i, k + 1)],
                     ref, mat)
    for (u0, v0, u1, v1) in legend:
        B.box(cx + (u0 - 0.5) * 2 * hw1, y1 - dish * 0.4,
              cz + (v0 - 0.5) * 2 * hd1, cx + (u1 - 0.5) * 2 * hw1,
              y1 + 0.0009, cz + (v1 - 0.5) * 2 * hd1, lm if lm is not None else mat)


# a handful of abstract marks, so no two keys in a row carry the same one
LEGENDS = [
    ((0.28, 0.30, 0.72, 0.40), (0.28, 0.58, 0.72, 0.68)),
    ((0.30, 0.28, 0.40, 0.72), (0.46, 0.28, 0.56, 0.72), (0.62, 0.28, 0.72, 0.72)),
    ((0.26, 0.44, 0.74, 0.56),),
    ((0.28, 0.28, 0.72, 0.38), (0.28, 0.46, 0.58, 0.56), (0.28, 0.62, 0.72, 0.72)),
    ((0.44, 0.26, 0.56, 0.74), (0.26, 0.44, 0.74, 0.56)),
    ((0.28, 0.30, 0.38, 0.70), (0.38, 0.30, 0.72, 0.40), (0.38, 0.60, 0.72, 0.70)),
    ((0.30, 0.26, 0.70, 0.36), (0.44, 0.36, 0.56, 0.74)),
    ((0.26, 0.30, 0.74, 0.40), (0.26, 0.60, 0.50, 0.70)),
]


def archive_terminal(name='archive'):
    """The records station on the port wall of the habitat.

       What was here: `box(1.15, 0.85, 0.12)` for the fascia, `box(0.86, 0.30,
       0.34)` for a shelf, one accent strip, and twenty-two copies of
       `box(0.055, 0.012, 0.055)` on an 8-column grid for the keyboard. Twenty
       five meshes, three of them slabs and twenty-two of them the same cube,
       floating 24 cm clear of the wall with nothing underneath -- and it is
       one of the two fittings the player walks up to and stands in front of.

       What it is now: a floor-standing console. It has a plinth with a toe
       recess and levelling feet, a cabinet with two doors, a real hinge line,
       a louvred vent and a lock, a work deck with a rolled nosing, a keyboard
       with varied, dished, legended caps standing in their own wells, a
       display in a machined bay, a riser plated with real seams and fasteners,
       a media rack, cooling louvres and cable trunking that goes somewhere.

       It stands on the deck between the bay's coving (which rises from the
       deck edge at z 0.0) and the grab rail (whose inboard face is at
       z -0.167), so the cabinet sits forward of z -0.14 and only the wall
       brackets reach past it."""
    B = Build()
    HULL, DK, AC = MI['KIT_HULL'], MI['KIT_DARK'], MI['KIT_ACCENT']
    RAIL, RUB, DECK = MI['KIT_RAIL'], MI['KIT_RUBBER'], MI['KIT_DECK']
    SHELL = MI['KIT_SHELL']
    DY = 0.08                        # deck
    ZB = -0.14                       # back of the cabinet
    HWD = 0.62                       # half width

    # ---- plinth: a recessed toe space with the cabinet sitting on it
    B.box(-HWD + 0.03, DY, 0.02, HWD - 0.03, DY + 0.115, 0.24, DK)
    B.box(-HWD, DY + 0.100, ZB, HWD, DY + 0.150, 0.29, DK)
    for sx in (-1, 1):               # levelling feet, visible in the toe space
        for z in (0.06, 0.20):
            lathe(B, (sx * (HWD - 0.10), DY, z), (0.0, 1.0, 0.0),
                  [(0.030, 0.0), (0.034, 0.010), (0.026, 0.026), (0.020, 0.038)],
                  RAIL, 10, ref=(0.0, 0.0, 1.0), cap0=False)

    # ---- cabinet. Cheeks proud of the doors, a capping rail over the top, and
    #      a hinge stile down the middle: three planes, so the front is not one
    #      flat rectangle however it is lit.
    Y0, Y1 = DY + 0.150, 0.742
    B.box(-HWD, Y0, ZB, HWD, Y1, 0.255, HULL)            # carcass
    for sx in (-1, 1):                                   # cheeks
        B.box(sx * HWD, Y0, ZB, sx * (HWD - 0.048), Y1, 0.292, DK)
        for k in range(3):                               # lightening slots
            y = Y0 + 0.085 + k * 0.150
            B.box(sx * (HWD - 0.004), y, 0.070, sx * (HWD - 0.052), y + 0.070, 0.220, HULL)
    B.box(-HWD, Y1 - 0.040, ZB, HWD, Y1, 0.300, DK)      # capping rail
    B.box(-HWD, Y0, ZB, HWD, Y0 + 0.034, 0.292, DK)      # plinth rail
    B.box(-0.030, Y0, 0.246, 0.030, Y1 - 0.040, 0.276, DK)   # hinge stile
    for sx in (-1, 1):
        # the doors themselves, standing 21 mm proud inside a margin
        B.box(sx * 0.044, Y0 + 0.030, 0.255, sx * (HWD - 0.056), Y1 - 0.062, 0.276, HULL)
        for k in range(2):                               # hinge knuckles
            cyl_z(B, sx * 0.030, Y0 + 0.090 + k * 0.400, 0.262, 0.298, 0.017, RAIL, 8)
        # recessed pull, cut into the outboard stile of each door
        recess(B, (sx * (HWD - 0.115), (Y0 + Y1) * 0.5, 0.276), (0.0, 0.0, 1.0),
               0.075, 0.030, 0.022, DK, r=0.010, up=(0.0, 1.0, 0.0), seg=3)
        cyl_x(B, (Y0 + Y1) * 0.5, 0.268, sx * (HWD - 0.135), sx * (HWD - 0.095),
              0.010, RAIL, 8)
    # left door: a louvred vent. Right door: a hasp, a lock and a data plate.
    for k in range(6):
        y = Y0 + 0.120 + k * 0.046
        B.box(-0.400, y, 0.276, -0.120, y + 0.030, 0.258, DK)
        B.box(-0.400, y + 0.005, 0.258, -0.120, y + 0.026, 0.250, SHELL)
    B.box(-0.416, Y0 + 0.104, 0.278, -0.104, Y0 + 0.120, 0.254, DK)
    B.box(-0.416, Y0 + 0.396, 0.278, -0.104, Y0 + 0.412, 0.254, DK)
    lathe(B, (0.300, Y0 + 0.300, 0.276), (0.0, 0.0, 1.0),
          [(0.030, 0.0), (0.032, 0.006), (0.026, 0.016), (0.014, 0.020)],
          RAIL, 14, ref=(0.0, 1.0, 0.0), cap0=False)
    B.box(0.296, Y0 + 0.298, 0.292, 0.304, Y0 + 0.318, 0.296, DK)
    pad(B, (0.300, Y0 + 0.150, 0.276), (0.0, 0.0, 1.0), 0.038, 0.090, 0.004,
        AC, r=0.006, up=(0.0, 1.0, 0.0))
    pad(B, (0.300, Y0 + 0.470, 0.276), (0.0, 0.0, 1.0), 0.040, 0.062, 0.004,
        RAIL, r=0.006, up=(0.0, 1.0, 0.0))
    for sx in (-1, 1):               # carcass fasteners on the cheeks
        for k in range(4):
            hexbolt(B, (sx * (HWD - 0.024), Y0 + 0.050 + k * 0.170, 0.290),
                    (0.0, 0.0, 1.0), 0.0068, RAIL, up=(0.0, 1.0, 0.0))

    # ---- work deck. A rolled front nosing, a rear lip, and a rubber rest.
    DKY = 0.742
    B.box(-0.545, DKY, 0.020, 0.545, DKY + 0.020, 0.316, DECK)
    lathe(B, (0.0, DKY + 0.010, 0.316), (1.0, 0.0, 0.0),
          [(0.010, -0.545), (0.014, -0.520), (0.014, 0.520), (0.010, 0.545)],
          DK, 12, ref=(0.0, 1.0, 0.0))
    B.box(-0.545, DKY + 0.020, 0.020, 0.545, DKY + 0.052, 0.052, DK)   # rear lip
    B.box(-0.330, DKY + 0.020, 0.276, 0.330, DKY + 0.030, 0.310, RUB)  # wrist rest
    for sx in (-1, 1):               # deck brackets down onto the capping rail
        B.box(sx * 0.520, DKY - 0.036, 0.240, sx * 0.560, DKY, 0.300, DK)

    # ---- the keyboard. A key plate with real wells, and caps that vary.
    #
    #      Twenty-two identical cubes on a 100 mm pitch was the old block. A
    #      real console keyboard is not a uniform grid: it has a command row
    #      that is wider than the rest, a space bar, a double-height execute
    #      key, and a transport block set apart from the alphanumerics. The
    #      variation is the whole point -- a grid of identical anything reads
    #      as generated whatever the individual cell is modelled like.
    KY = DKY + 0.020                                  # top of the deck plate
    B.box(-0.470, KY, 0.086, 0.180, KY + 0.016, 0.274, DK)      # main plate
    B.box(0.206, KY, 0.086, 0.470, KY + 0.016, 0.274, DK)       # transport plate
    KEYS = []                                          # (cx, cz, w, d, kind)
    # command row, eight 1u keys on a 56 mm pitch
    for i in range(8):
        KEYS.append((-0.442 + i * 0.056 + 0.028, 0.112, 0.048, 0.040, 0))
    # main row, two courses, with a wide shift and a double-height execute
    for i in range(7):
        KEYS.append((-0.442 + i * 0.056 + 0.028, 0.166, 0.048, 0.048, 1))
    KEYS.append((-0.442 + 7 * 0.056 + 0.056, 0.192, 0.104, 0.100, 2))
    for i in range(5):
        KEYS.append((-0.442 + i * 0.056 + 0.028, 0.220, 0.048, 0.048, 1))
    KEYS.append((-0.442 + 5.5 * 0.056 + 0.028, 0.220, 0.104, 0.048, 3))
    # space bar
    KEYS.append((-0.300, 0.256, 0.230, 0.036, 4))
    KEYS.append((-0.140, 0.256, 0.070, 0.036, 3))
    # transport block: six big square buttons, two of them accent
    for i in range(3):
        for k in range(2):
            KEYS.append((0.246 + i * 0.076, 0.126 + k * 0.078, 0.062, 0.062, 5))
    for (i, (cx, cz, w, d, kind)) in enumerate(KEYS):
        # the well: a 1.5 mm gap all round, cut through the plate
        B.box(cx - w * 0.5 - 0.0015, KY + 0.016, cz - d * 0.5 - 0.0015,
              cx + w * 0.5 + 0.0015, KY + 0.0055, cz + d * 0.5 + 0.0015, SHELL)
        press = 0.0015 if i in (3, 11, 22, 27) else 0.0
        mat = AC if kind == 5 and i % 3 == 0 else (RAIL if kind in (2, 4) else DK)
        keycap(B, cx, cz, KY + 0.0055 - press, w, d, mat,
               h=0.0175 if kind == 5 else 0.0145,
               dish=0.0034 if kind == 5 else 0.0026,
               legend=LEGENDS[i % len(LEGENDS)] if kind != 4 else
               ((0.20, 0.40, 0.80, 0.60),), lm=RAIL if mat is not RAIL else DK)
    # a jog wheel at the right-hand end, and its detent ring
    lathe(B, (0.470, KY, 0.208), (0.0, 1.0, 0.0),
          [(0.062, 0.0), (0.064, 0.006), (0.060, 0.028), (0.048, 0.036)],
          RAIL, 24, ref=(0.0, 0.0, 1.0), cap0=False, shape=knurl(24, 0.030))
    lathe(B, (0.470, KY - 0.002, 0.208), (0.0, 1.0, 0.0),
          [(0.078, 0.0), (0.080, 0.006), (0.074, 0.012)], DK, 24,
          ref=(0.0, 0.0, 1.0), cap0=False)

    # ---- the riser. Plated with real seams and fasteners rather than one
    #      slab: three courses of plate on an irregular grid, each standing
    #      14 mm off a backing sheet.
    RY0, RY1 = 0.700, 1.980
    B.box(-HWD, RY0, ZB, HWD, RY1, ZB + 0.055, HULL)
    XS = [-HWD, -0.24, 0.24, HWD]
    YS = [RY0, 1.020, 1.760, RY1]
    for a in range(3):
        for b in range(3):
            if b == 1 and a == 1:
                continue                                # the display goes here
            x0, x1 = XS[a] + 0.012, XS[a + 1] - 0.012
            y0, y1 = YS[b] + 0.012, YS[b + 1] - 0.012
            B.box(x0, y0, ZB + 0.055, x1, y1, ZB + 0.069, HULL)
            for sa in (0, 1):
                for sb in (0, 1):
                    cx = x0 + 0.036 if sa == 0 else x1 - 0.036
                    cy = y0 + 0.036 if sb == 0 else y1 - 0.036
                    cyl_z(B, cx, cy, ZB + 0.058, ZB + 0.076, 0.011, DK, 8)
                    disc_z(B, cx, cy, ZB + 0.076, 0.011, 0.0, DK, 8)
    # wall brackets, above the hatch in the bay skin and below the strake
    for sx in (-1, 1):
        for (y, h) in ((1.865, 0.095), (0.300, 0.085)):
            B.box(sx * 0.430, y, -0.370, sx * 0.490, y + h, ZB + 0.020, DK)
            B.box(sx * 0.410, y - 0.014, -0.370, sx * 0.510, y + h + 0.014,
                  -0.330, DK)

    # ---- the display, in a machined bay. The canvas is drawn by HoloScreen at
    #      exactly (0, 1.36, 0.06); what it needed was a home to sit in.
    B.box(-0.580, 0.980, ZB + 0.055, 0.580, 1.780, 0.036, DK)
    screen_bay(B, 0.98, 0.62, 0.0, 1.36, 0.06, 0.0, 0.0,
               -0.580, -0.380, 0.580, 0.420)
    # glare hood over the top of the bay, with three stiffening gussets
    B.box(-0.580, 1.780, 0.020, 0.580, 1.812, 0.126, DK)
    B.box(-0.580, 1.752, 0.108, 0.580, 1.812, 0.146, DK)
    for x in (-0.44, 0.0, 0.44):
        B.box(x - 0.012, 1.700, 0.036, x + 0.012, 1.784, 0.122, DK)

    # ---- what makes it an archive rather than a monitor: physical media.
    #      A rack of spools above the display, three of them out of place.
    B.box(-0.560, 1.836, ZB + 0.069, 0.180, 1.960, 0.086, DK)
    B.box(-0.560, 1.836, 0.070, 0.180, 1.852, 0.086, SHELL)
    # Six, not nine. At a 78 mm pitch a 112 mm spool overlaps its neighbours by
    # a third and the rack reads as one scalloped ridge -- which is what it did:
    # nine cans merged into three blobs. The pitch has to clear the diameter.
    for i in range(6):
        x = -0.540 + i * 0.112
        d = 0.016 if i in (1, 4) else 0.0
        lathe(B, (x + 0.040, 1.898, 0.078 - d), (0.0, 0.0, 1.0),
              [(0.040, -0.130), (0.040, -0.014), (0.047, -0.008),
               (0.047, 0.002), (0.040, 0.008), (0.024, 0.018)],
              SHELL if i % 3 else RAIL, 14, ref=(0.0, 1.0, 0.0), cap0=False)
        B.box(x + 0.022, 1.926, 0.082 - d, x + 0.058, 1.938, 0.086 - d, AC)
    # card reader with a lit throat, and a slate dock, on the right-hand plate
    B.box(0.268, 1.560, ZB + 0.069, 0.548, 1.660, 0.030, DK)
    recess(B, (0.408, 1.610, 0.030), (0.0, 0.0, 1.0), 0.010, 0.070, 0.030,
           SHELL, r=0.005, up=(0.0, 1.0, 0.0), seg=2)
    B.box(0.268, 1.540, ZB + 0.069, 0.548, 1.560, 0.024, RAIL)
    B.box(0.290, 1.180, ZB + 0.069, 0.528, 1.196, 0.086, DK)
    B.box(0.290, 1.196, 0.062, 0.528, 1.330, 0.078, DK)
    for k in range(2):               # two slates left in the dock
        B.box(0.302 + k * 0.116, 1.196, 0.066 - k * 0.004,
              0.400 + k * 0.116, 1.320, 0.074 - k * 0.004, SHELL)
    # breaker bank and two rotaries on the left-hand plate
    for k in range(4):
        breaker(B, (-0.470 + k * 0.058, 1.560, ZB + 0.069), (0.0, 0.0, 1.0),
                DK, RAIL, AC, up=(0.0, 1.0, 0.0), s=0.86)
    for (x, a) in ((-0.400, 0.6), (-0.250, -1.1)):
        rotary(B, (x, 1.320, ZB + 0.069), (0.0, 0.0, 1.0), DK, RAIL, AC,
               up=(0.0, 1.0, 0.0), s=0.9, ang=a)
    gauge(B, (-0.320, 1.130, ZB + 0.069), (0.0, 0.0, 1.0), 0.052, DK, SHELL,
          AC, up=(0.0, 1.0, 0.0), ang=-0.5)
    pad(B, (-0.360, 0.860, ZB + 0.069), (0.0, 0.0, 1.0), 0.036, 0.150, 0.004,
        AC, r=0.006, up=(0.0, 1.0, 0.0))
    pad(B, (0.380, 0.870, ZB + 0.069), (0.0, 0.0, 1.0), 0.052, 0.110, 0.004,
        RAIL, r=0.006, up=(0.0, 1.0, 0.0))

    # ---- cooling stack up the right cheek of the riser, and the trunking that
    #      leaves the cabinet and turns into the deck. A console that is not
    #      plumbed into anything is a prop.
    for k in range(7):
        y = 1.060 + k * 0.052
        B.box(0.300, y, ZB + 0.069, 0.560, y + 0.034, ZB + 0.100, DK)
        B.box(0.300, y + 0.005, ZB + 0.100, 0.560, y + 0.029, ZB + 0.108, SHELL)
    for (x, r) in ((-0.545, 0.036), (-0.480, 0.026)):
        sweep_path(B, [(x, RY0 + 0.10, ZB + 0.062), (x, 0.560, ZB + 0.052),
                       (x, 0.330, ZB + 0.020), (x, 0.190, 0.070),
                       (x, DY + 0.030, 0.110)],
                   [r] * 5, DK, seg=8)
        for k in range(3):
            lathe(B, (x, 0.640 - k * 0.180, ZB + 0.056), (0.0, 1.0, 0.0),
                  [(r * 1.30, 0.0), (r * 1.34, 0.008), (r * 1.24, 0.022)],
                  RAIL, 10, ref=(0.0, 0.0, 1.0), cap0=False)
    # grab handle down the left edge, where a hand steadies against a fold
    for k in (0, 1):
        cyl_z(B, -HWD - 0.014, 1.180 + k * 0.320, ZB + 0.069, 0.020, 0.017, DK, 8)
    lathe(B, (-HWD - 0.014, 1.180, 0.020), (0.0, 1.0, 0.0),
          [(0.019, 0.0), (0.019, 0.320)], RAIL, 12, ref=(0.0, 0.0, 1.0),
          cap0=False, cap1=False)
    return B.obj(name)


def observation_port(name='port'):
    """The starboard observation port.

       What was here: `TorusGeometry(0.56, 0.07)`, a `CircleGeometry(0.55)` and
       six copies of `box(0.10, 0.10, 0.05)` on a bolt circle. Eight meshes. It
       read as exactly what it was -- a ring stuck on a wall -- because a port
       is not a ring, it is a *hole*, and the whole read is the depth of the
       barrel and the thickness of the hull round it.

       So: a doubler stepped three times out of the skin, a bore with a drafted
       barrel and a machined seat, a clamp ring with twelve dogs holding the
       pane, a raised collar with a sixteen-bolt circle, a shutter in a housing
       above with guide rails, a jackscrew and a manual crank, a condensate
       gutter draining to a catch bottle, handles, placards and a service
       valve.

       Authored about the pane centre: y 0 is 1.35 m above the deck, z 0 is the
       plane Interior.js places the group on, and the bay skin behind is at
       z -0.086. The bay's rubbing strake stands to z +0.042, so the doubler
       face is at +0.052 and the strake dies into it either side, which is what
       a strake does when it meets a fitting.

       **Everything inside the bore faces the axis, and `lathe` cannot make
       it.** `lathe` skins through `loft2`, which winds each face away from the
       midpoint of its two ring centroids -- and for a form revolved about an
       axis both centroids are *on* that axis, so every face comes out pointing
       away from it. That is right for a knob and exactly inverted for a hole:
       the first cut of this piece had a collar whose inner wall, a barrel
       seat and a clamp ring all backface-culled, and what the player saw
       through the middle of the port was the bay skin 140 mm behind it, with
       a ring of painted louvres on it. Anything facing inward is `bore_z`;
       anything flat is `disc_z`, which takes a reference point off the plane
       because a flat annulus lofted against a centroid *in* its own plane is
       the degenerate case that pinwheels. `lathe` is left to do what it is
       good at, which is the outside of things."""
    B = Build()
    HULL, DK, AC = MI['KIT_HULL'], MI['KIT_DARK'], MI['KIT_ACCENT']
    RAIL, RUB, SHELL = MI['KIT_RAIL'], MI['KIT_RUBBER'], MI['KIT_SHELL']
    N = 48                                 # loop resolution, shared everywhere
    NC = N // 4 - 1                        # arc segments per rounded corner
    ZS = -0.086                            # the bay skin behind
    RB = 0.470                             # bore radius at the mouth

    # ---- doubler: three steps out of the skin, each a rounded square with the
    #      bore through it. Stepped rather than one slab so the fitting has a
    #      lit face and a shaded one at every level, and so the plating around
    #      it reads as hull *thickness* rather than as a picture frame.
    STEPS = [(0.680, 0.622, ZS, -0.030), (0.622, 0.566, -0.030, 0.014),
             (0.566, 0.000, 0.014, 0.052)]
    for (hw, nxt, z0, z1) in STEPS:
        outer = loop_rrect(hw, hw, 0.135, NC)
        prism_z(B, outer, z0, z1, HULL, cap0=False, cap1=False)
        inner = (loop_rrect(nxt, nxt, 0.125, NC) if nxt > 0.0
                 else loop_circle(RB, N))
        annulus_z(B, outer, inner, z1, HULL, behind=-1.0)
    # closed from behind, so the bake sees a solid fitting and not a tube
    annulus_z(B, loop_rrect(0.680, 0.680, 0.135, NC), loop_circle(RB, N), ZS,
              HULL, behind=1.0)
    # the barrel, wound so its inside is what is seen, with a machined seat
    bore_z(B, 0.052, -0.030, RB, 0.452, DK, N)
    disc_z(B, 0.0, 0.0, -0.030, 0.446, 0.452, RAIL, N, behind=-1.0)
    bore_z(B, -0.030, ZS, 0.446, 0.440, DK, N)

    # ---- clamp ring trapping the pane, and its dogs. The pane is a live mesh
    #      in Interior.js -- it is glass and it is bound to the sun -- so what
    #      the kit provides is the ring that holds it, at z -0.052.
    disc_z(B, 0.0, 0.0, -0.026, 0.424, 0.448, RAIL, N, behind=-1.0)
    bore_z(B, -0.026, -0.054, 0.424, 0.432, RAIL, N)
    disc_z(B, 0.0, 0.0, -0.054, 0.432, 0.446, RAIL, N, behind=1.0)
    for i in range(12):
        a = math.pi * 2 * i / 12 + 0.26
        hexbolt(B, (math.cos(a) * 0.436, math.sin(a) * 0.436, -0.026),
                (0.0, 0.0, 1.0), 0.0072, DK, up=(0.0, 1.0, 0.0))

    # ---- the collar: a raised ring standing off the doubler with the main
    #      bolt circle in it. This is the part that says "pressure fitting".
    bore_z(B, 0.052, 0.126, RB, RB, DK, N)              # inner wall
    bore_z(B, 0.126, 0.136, RB, 0.486, RAIL, N)         # chamfered mouth
    disc_z(B, 0.0, 0.0, 0.136, 0.486, 0.598, DK, N, behind=-1.0)
    lathe(B, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0),
          [(0.598, 0.136), (0.624, 0.122), (0.628, 0.070), (0.606, 0.050)],
          DK, N, ref=(0.0, 1.0, 0.0), cap0=False, cap1=False)
    for i in range(16):
        a = math.pi * 2 * i / 16 + math.pi / 16
        hexbolt(B, (math.cos(a) * 0.542, math.sin(a) * 0.542, 0.136),
                (0.0, 0.0, 1.0), 0.0102, RAIL, up=(0.0, 1.0, 0.0))
    for i in range(20):                                  # doubler fasteners
        a = math.pi * 2 * i / 20
        d = min(0.626 / max(abs(math.cos(a)), abs(math.sin(a))), 0.638)
        hexbolt(B, (math.cos(a) * d, math.sin(a) * d, -0.030),
                (0.0, 0.0, 1.0), 0.0080, DK, up=(0.0, 1.0, 0.0))

    # ---- shutter. It has to live somewhere: a housing over the port with the
    #      stowed plate visible in its mouth, guide rails down both sides of
    #      the bore, a jackscrew and a manual crank for when the power is out.
    B.box(-0.600, 0.660, ZS, 0.600, 0.900, 0.104, DK)
    B.box(-0.600, 0.660, 0.104, 0.600, 0.884, 0.118, HULL)
    B.box(-0.548, 0.638, 0.030, 0.548, 0.664, 0.086, SHELL)   # the plate's edge
    B.box(-0.560, 0.616, 0.036, 0.560, 0.640, 0.080, RAIL)
    for sx in (-1, 1):
        B.box(sx * 0.548, -0.660, 0.030, sx * 0.600, 0.660, 0.070, DK)
        B.box(sx * 0.558, -0.660, 0.070, sx * 0.590, 0.660, 0.082, RAIL)
        for k in range(5):
            hexbolt(B, (sx * 0.574, -0.600 + k * 0.300, 0.070), (0.0, 0.0, 1.0),
                    0.0070, DK, up=(0.0, 1.0, 0.0))
    lathe(B, (0.600, 0.780, 0.062), (1.0, 0.0, 0.0),
          [(0.028, 0.0), (0.028, 0.130), (0.038, 0.140), (0.038, 0.184)],
          RAIL, 12, ref=(0.0, 1.0, 0.0))
    lathe(B, (0.790, 0.780, 0.062), (1.0, 0.0, 0.0),
          [(0.066, 0.0), (0.070, 0.020), (0.060, 0.050)], DK, 14,
          ref=(0.0, 1.0, 0.0))
    # the crank handle, folded down against the gearbox
    sweep_path(B, [(0.846, 0.780, 0.062), (0.846, 0.700, 0.062),
                   (0.846, 0.650, 0.094)], [0.010, 0.010, 0.010], RAIL, seg=8)
    lathe(B, (0.846, 0.650, 0.104), (0.0, 0.0, 1.0),
          [(0.017, 0.0), (0.017, 0.048), (0.013, 0.054)], RUB, 12,
          ref=(0.0, 1.0, 0.0))

    # ---- condensate gutter under the collar, its drain, and the catch bottle.
    #      A porthole is the coldest surface in a crewed volume and it runs.
    sweep_profile(B, [(math.cos(a) * 0.560, math.sin(a) * 0.560, 0.030)
                      for a in [math.pi * (1.16 + 0.68 * i / 8) for i in range(9)]],
                  [[(-0.028, 0.0), (-0.028, 0.032), (-0.021, 0.032),
                    (-0.021, 0.010), (0.021, 0.010), (0.021, 0.032),
                    (0.028, 0.032), (0.028, 0.0)]] * 9, DK,
                  up=(0.0, 0.0, 1.0), cap0=True, cap1=True)
    sweep_path(B, [(0.0, -0.588, 0.044), (0.0, -0.680, 0.058),
                   (0.130, -0.760, 0.058)], [0.013, 0.013, 0.011], DK, seg=8)
    lathe(B, (0.190, -0.828, 0.058), (0.0, 1.0, 0.0),
          [(0.050, -0.126), (0.054, -0.114), (0.054, -0.012), (0.044, 0.0),
           (0.019, 0.008)], SHELL, 16, ref=(0.0, 0.0, 1.0), cap0=True)
    B.box(0.142, -0.872, 0.024, 0.238, -0.852, 0.092, RAIL)

    # ---- handles, placards, and the service valve that proves it is plumbed
    for sx in (-1, 1):
        for k in (0, 1):
            cyl_z(B, sx * 0.636, -0.190 + k * 0.380, 0.014, 0.086, 0.017, DK, 8)
        lathe(B, (sx * 0.636, -0.190, 0.086), (0.0, 1.0, 0.0),
              [(0.019, 0.0), (0.019, 0.380)], RAIL, 12, ref=(0.0, 0.0, 1.0),
              cap0=False, cap1=False)
    pad(B, (0.0, -0.606, 0.052), (0.0, 0.0, 1.0), 0.034, 0.160, 0.005, AC,
        r=0.006, up=(0.0, 1.0, 0.0))
    pad(B, (-0.300, 0.582, 0.052), (0.0, 0.0, 1.0), 0.038, 0.104, 0.005, RAIL,
        r=0.006, up=(0.0, 1.0, 0.0))
    B.box(-0.780, -0.620, ZS, -0.540, -0.380, 0.046, DK)
    B.box(-0.762, -0.602, 0.046, -0.558, -0.398, 0.058, HULL)
    gauge(B, (-0.660, -0.500, 0.058), (0.0, 0.0, 1.0), 0.054, DK, SHELL, AC,
          up=(0.0, 1.0, 0.0), ang=-0.9)
    lathe(B, (-0.660, -0.652, 0.030), (0.0, -1.0, 0.0),
          [(0.022, 0.0), (0.022, 0.058), (0.015, 0.068)], RAIL, 12,
          ref=(0.0, 0.0, 1.0))
    # handwheel: a rim, three spokes and a hub. A lathed disc from r 0 outward
    # is a flat annulus and pinwheels; a wheel is a rim with holes in it anyway.
    lathe(B, (-0.660, -0.726, 0.030), (0.0, -1.0, 0.0),
          [(0.040, 0.0), (0.052, 0.007), (0.052, 0.019), (0.040, 0.026)], AC, 18,
          ref=(0.0, 0.0, 1.0), cap0=False, cap1=False)
    for k in range(3):
        a = math.pi * 2 * k / 3 + 0.4
        B.box(-0.660 + math.cos(a) * 0.048 - 0.007, -0.740,
              0.030 + math.sin(a) * 0.048 - 0.007,
              -0.660 - 0.0 + 0.007, -0.726, 0.030 + 0.007, AC)
    lathe(B, (-0.660, -0.744, 0.030), (0.0, -1.0, 0.0),
          [(0.015, 0.0), (0.015, 0.022), (0.010, 0.028)], RAIL, 12,
          ref=(0.0, 0.0, 1.0))
    return B.obj(name)


# ============================================================ loose stowage
#
#  The review's loudest finding, and it was not about shading:
#
#    "Nothing in the ship is loose. In the reference: books with spine text, a
#     cracked visor, a printed poster, a labelled case with a red pull tab, a
#     cargo net with metal fittings, a cloth bag, a STOW 84S placard. In ours:
#     a few identical tan crates and some cylinders on a console top."
#
#  What that is really saying is that everything in the cabin belongs to the
#  *ship*. Equipment says the vessel is maintained; it does not say anybody
#  lives in it. These two pieces are the ones that do, and every object inside
#  them is a different size, a different material and sits at a different angle,
#  because the moment two of them match the eye reads a tiled asset.

def _book(B, x, y, z, w, h, d, lean, mat, band):
    """One volume, leaning. Boards proud of the block, a sunk spine panel and
       two raised bands — which is the whole of what reads as a book at 600 mm
       and costs eleven faces."""
    ca, sa = math.cos(lean), math.sin(lean)
    def P(a, b, c):
        return (x + a * ca - b * sa, y + a * sa + b * ca, z + c)
    B.face([P(-w, 0, -d), P(w, 0, -d), P(w, 0, d), P(-w, 0, d)], mat)
    # the block: boards front and back, pages between, all as one swept prism
    for (x0, x1, dd, m) in ((-w, -w + 0.006, d, mat),
                            (-w + 0.006, w - 0.006, d - 0.004, band),
                            (w - 0.006, w, d, mat)):
        pts = [P(x0, 0, -dd), P(x1, 0, -dd), P(x1, h, -dd), P(x0, h, -dd),
               P(x0, 0, dd), P(x1, 0, dd), P(x1, h, dd), P(x0, h, dd)]
        for f in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
                  (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
            B.face([pts[i] for i in f], m)
    # spine bands, proud of the spine face
    for t in (0.30, 0.62):
        pts = [P(-w * 0.98, h * t, -d * 1.02), P(w * 0.98, h * t, -d * 1.02),
               P(w * 0.98, h * (t + 0.10), -d * 1.02), P(-w * 0.98, h * (t + 0.10), -d * 1.02)]
        B.face(pts, band)


def stowbay(name='stowbay', w=0.92, hgt=0.62, d=0.30):
    """An open shelf bay with a restraint bar across it, and somebody's things.

       Modelled facing +Z, so it goes on the port wall at ry = +90 and the
       starboard wall at ry = -90, like the lockers and the wallbox."""
    B = Build()
    HULL, DK, AC, RAIL, RUB, SEAT = (MI['KIT_HULL'], MI['KIT_DARK'],
                                     MI['KIT_ACCENT'], MI['KIT_RAIL'],
                                     MI['KIT_RUBBER'], MI['KIT_SEAT'])
    hw, hd = w / 2, d / 2
    # ---- carcass: back, deck, roof and two cheeks, each a plate with a rolled
    #      front edge rather than a slab. The bay is open at the front, which is
    #      the whole point of it.
    B.box(-hw, 0.0, -hd, hw, hgt, -hd + 0.014, HULL)                   # back
    for (y0, y1) in ((0.0, 0.020), (hgt - 0.020, hgt)):                # deck/roof
        st = []
        for (zz, sc) in ((-hd + 0.010, 1.000), (hd - 0.030, 1.000), (hd, 0.86)):
            st.append([(a * hw * (1.0 if sc == 1.0 else 1.0),
                        y0 + (y1 - y0) * 0.5 + b * (y1 - y0) * 0.5 * sc, zz)
                       for (a, b) in rrect(1.0, 1.0, 0.22, 3)])
        loft2(B, st, HULL, cap0=True, cap1=True)
    for sx in (-1, 1):                                                 # cheeks
        st = []
        for (zz, sc) in ((-hd + 0.010, 1.000), (hd - 0.034, 1.000), (hd, 0.80)):
            st.append([(sx * hw - sx * 0.008 + a * 0.008,
                        hgt * 0.5 + b * hgt * 0.5 * sc, zz)
                       for (a, b) in rrect(1.0, 1.0, 0.20, 3)])
        loft2(B, st, HULL, cap0=True, cap1=True)
    # a mid shelf, two thirds up, so the bay reads as two compartments
    SHY = hgt * 0.58
    B.box(-hw + 0.010, SHY, -hd + 0.012, hw - 0.010, SHY + 0.012, hd - 0.020, DK)
    # ---- the restraint bar: a lathed rod on two folded brackets, with the
    #      placard the reference photograph hangs on it
    for sx in (-1, 1):
        B.box(sx * (hw - 0.024), SHY - 0.062, hd - 0.048,
              sx * (hw - 0.008), SHY - 0.030, hd - 0.014, DK)
    sweep_path(B, [(-hw + 0.014, SHY - 0.046, hd - 0.030),
                   (hw - 0.014, SHY - 0.046, hd - 0.030)],
               0.0085, RAIL, 10, up=(0.0, 1.0, 0.0))
    pad(B, (-hw + 0.230, SHY - 0.046, hd - 0.020), (0.0, 0.0, 1.0),
        0.100, 0.017, 0.0035, HULL, r=0.003, up=(1.0, 0.0, 0.0))
    # a second bar across the upper compartment, and a lashing cord over it
    sweep_path(B, [(-hw + 0.014, hgt - 0.086, hd - 0.026),
                   (hw - 0.014, hgt - 0.086, hd - 0.026)],
               0.0075, RAIL, 10, up=(0.0, 1.0, 0.0))
    for (a0, a1) in (((-hw + 0.030, hgt - 0.030, hd - 0.010),
                      (hw - 0.060, SHY + 0.030, hd - 0.010)),
                     ((hw - 0.030, hgt - 0.030, hd - 0.010),
                      (-hw + 0.060, SHY + 0.030, hd - 0.010))):
        mid = tuple((a0[i] + a1[i]) * 0.5 for i in range(3))
        mid = (mid[0], mid[1] - 0.012, mid[2] + 0.006)
        sweep_path(B, [a0, mid, a1], 0.0042, RUB, 6, up=(0.0, 0.0, 1.0))
    for p in ((-hw + 0.030, hgt - 0.030, hd - 0.010), (hw - 0.030, hgt - 0.030, hd - 0.010)):
        lathe(B, p, (0.0, 0.0, 1.0), [(0.010, -0.012), (0.011, -0.004),
                                      (0.008, 0.004)], RAIL, 10, ref=(1.0, 0.0, 0.0))

    # ---- what is in it. Nine objects and no two the same.
    #      Lower shelf: a rank of books, a soft bag and a canister.
    for (bx0, bw, bh, bd, ln, m, bnd) in (
            (-hw + 0.056, 0.014, 0.196, 0.062, 0.00, DK, AC),
            (-hw + 0.090, 0.020, 0.214, 0.070, 0.00, HULL, DK),
            (-hw + 0.128, 0.011, 0.178, 0.058, 0.00, AC, DK),
            (-hw + 0.156, 0.017, 0.202, 0.066, 0.13, DK, RAIL)):
        _book(B, bx0, 0.026, 0.0, bw, bh, bd, ln, m, bnd)
    # a cloth bag, slumped: a lofted blob with a gathered neck and a cord
    st = []
    for (y, sw, sd, k) in ((0.024, 0.088, 0.070, 3.0), (0.070, 0.104, 0.084, 2.6),
                           (0.140, 0.092, 0.076, 2.4), (0.186, 0.046, 0.040, 2.2),
                           (0.206, 0.030, 0.026, 2.0), (0.222, 0.038, 0.032, 2.0)):
        st.append(sect(-hw + 0.290, 0.026 + y, 0.006, sw, sd, k, 16))
    loft2(B, st, SEAT, cap0=True, cap1=True)
    sweep_path(B, [(-hw + 0.250, 0.222, 0.006), (-hw + 0.290, 0.216, 0.030),
                   (-hw + 0.330, 0.224, 0.004)], 0.0038, RUB, 6, up=(0.0, 1.0, 0.0))
    # a canister lying on its side, chocked
    lathe(B, (-hw + 0.430, 0.086, -0.030), (1.0, 0.0, 0.0),
          [(0.0, 0.0), (0.052, 0.0), (0.058, 0.010), (0.058, 0.176),
           (0.052, 0.186), (0.0, 0.186)], HULL, 20, ref=(0.0, 1.0, 0.0))
    lathe(B, (-hw + 0.430 + 0.190, 0.086, -0.030), (1.0, 0.0, 0.0),
          [(0.0, 0.0), (0.030, 0.0), (0.030, 0.024)], RAIL, 16, ref=(0.0, 1.0, 0.0))
    for t in (0.055, 0.140):
        lathe(B, (-hw + 0.430 + t, 0.086, -0.030), (1.0, 0.0, 0.0),
              [(0.060, 0.0), (0.062, 0.010), (0.060, 0.020)], AC, 20,
              ref=(0.0, 1.0, 0.0), cap0=False, cap1=False)
    #      Upper shelf: the labelled case with a pull tab, and a folded bundle.
    CX, CY0 = -hw + 0.150, SHY + 0.012
    st = []
    for (zz, sc) in ((-0.070, 0.90), (-0.052, 1.00), (0.052, 1.00), (0.070, 0.90)):
        st.append([(CX + a * 0.180 * sc, CY0 + 0.062 + b * 0.062 * sc, zz)
                   for (a, b) in rrect(1.0, 1.0, 0.16, 4)])
    loft2(B, st, HULL, cap0=True, cap1=True)
    B.box(CX - 0.182, CY0 + 0.058, -0.072, CX + 0.182, CY0 + 0.068, 0.072, DK)
    for sx in (-1, 1):                                   # corner bumpers
        for sy in (-1, 1):
            B.box(CX + sx * 0.176 - sx * 0.026, CY0 + 0.062 + sy * 0.058 - sy * 0.020,
                  -0.062, CX + sx * 0.182, CY0 + 0.062 + sy * 0.062, 0.062, AC)
    pad(B, (CX + 0.060, CY0 + 0.086, 0.072), (0.0, 0.0, 1.0), 0.086, 0.026,
        0.0030, DK, r=0.003, up=(1.0, 0.0, 0.0))
    #      the red pull tab. The one reserved-warm object in the bay, and the
    #      thing the eye lands on first in the reference photograph.
    B.box(CX - 0.028, CY0 + 0.044, 0.068, CX + 0.028, CY0 + 0.070, 0.078, RAIL)
    st = []
    for (t, sc) in ((0.0, 1.0), (0.030, 0.94), (0.058, 0.66)):
        st.append([(CX + a * 0.022 * sc, CY0 + 0.040 - t + b * 0.006, 0.074 + t * 0.20)
                   for (a, b) in rrect(1.0, 1.0, 0.3, 3)])
    loft2(B, st, AC, cap0=True, cap1=True)
    # a folded bundle, strapped
    st = []
    for (y, sw, sd, k) in ((0.004, 0.100, 0.062, 4.0), (0.030, 0.106, 0.068, 3.0),
                           (0.072, 0.100, 0.062, 3.0), (0.092, 0.084, 0.050, 2.6)):
        st.append(sect(hw - 0.150, CY0 + y, 0.004, sw, sd, k, 14))
    loft2(B, st, SEAT, cap0=True, cap1=True)
    for zz in (-0.030, 0.034):
        B.box(hw - 0.256, CY0 + 0.000, zz, hw - 0.044, CY0 + 0.096, zz + 0.008, RUB)
    B.box(hw - 0.166, CY0 + 0.090, -0.036, hw - 0.134, CY0 + 0.104, 0.042, RAIL)
    # a mug, because a mug is the single cheapest object that says somebody
    # lives here, and it is the only rotationally symmetric thing on the shelf
    lathe(B, (hw - 0.062, CY0, 0.020), (0.0, 1.0, 0.0),
          [(0.0, 0.0), (0.030, 0.0), (0.034, 0.006), (0.036, 0.062),
           (0.032, 0.064), (0.030, 0.010)], HULL, 18)
    sweep_path(B, [(hw - 0.030, CY0 + 0.014, 0.020), (hw - 0.014, CY0 + 0.032, 0.020),
                   (hw - 0.030, CY0 + 0.052, 0.020)], 0.0045, HULL, 8,
               up=(0.0, 0.0, 1.0))
    # a printed sheet taped to the back panel of the upper bay: the poster
    _panel(B, -hw + 0.330, SHY + 0.028, -hd + 0.016, 0.200, 0.150, HULL,
           nx=5, ny=5, curl=0.010, sag=0.004)
    for sx in (-1, 1):
        pad(B, (-hw + 0.430 + sx * 0.094, SHY + 0.172, -hd + 0.019),
            (0.0, 0.0, 1.0), 0.014, 0.010, 0.0016, AC, r=0.002, up=(1.0, 0.0, 0.0))
    return B.obj(name)


def netcargo(name='netcargo'):
    """Freight under a cargo net, on the deck.

       Three containers that are not the same container, a net that sags over
       what is under it rather than lying flat, and the metal that a net needs:
       corner hooks, a ratchet tensioner and two deck rings. Modelled standing
       on y = 0 so it can be dropped at DECK_TOP."""
    B = Build()
    HULL, DK, AC, RAIL, RUB, SEAT = (MI['KIT_HULL'], MI['KIT_DARK'],
                                     MI['KIT_ACCENT'], MI['KIT_RAIL'],
                                     MI['KIT_RUBBER'], MI['KIT_SEAT'])
    # ---- a square crate at the bottom, cornered in extrusion
    B.box(-0.230, 0.0, -0.210, 0.230, 0.300, 0.210, HULL)
    for sx in (-1, 1):
        for sz in (-1, 1):
            B.box(sx * 0.230 - sx * 0.026, 0.0, sz * 0.210 - sz * 0.026,
                  sx * 0.236, 0.312, sz * 0.216, DK)
    for y in (0.086, 0.214):
        B.box(-0.236, y, -0.216, 0.236, y + 0.014, 0.216, DK)
    pad(B, (0.060, 0.160, 0.212), (0.0, 0.0, 1.0), 0.086, 0.030, 0.0030,
        AC, r=0.003, up=(1.0, 0.0, 0.0))
    # ---- a drum lying on its side across the top, chocked
    lathe(B, (-0.245, 0.404, 0.030), (1.0, 0.0, 0.0),
          [(0.0, 0.0), (0.086, 0.0), (0.094, 0.014), (0.094, 0.402),
           (0.086, 0.416), (0.0, 0.416)], DK, 22, ref=(0.0, 1.0, 0.0))
    for t in (0.086, 0.330):
        lathe(B, (-0.245 + t, 0.404, 0.030), (1.0, 0.0, 0.0),
              [(0.096, 0.0), (0.101, 0.011), (0.096, 0.022)], RAIL, 22,
              ref=(0.0, 1.0, 0.0), cap0=False, cap1=False)
    for sx in (-1, 1):
        B.box(sx * 0.170, 0.312, -0.070, sx * 0.216, 0.348, 0.130, DK)
    # ---- a soft sack wedged in beside it, which is the one thing here with no
    #      straight edge anywhere on it
    st = []
    for (y, sw, sd, k) in ((0.316, 0.096, 0.086, 3.2), (0.360, 0.126, 0.112, 2.6),
                           (0.430, 0.132, 0.116, 2.4), (0.494, 0.104, 0.092, 2.2),
                           (0.532, 0.052, 0.046, 2.0), (0.556, 0.062, 0.054, 2.0)):
        st.append(sect(0.150, y, -0.086, sw, sd, k, 16))
    loft2(B, st, SEAT, cap0=True, cap1=True)
    sweep_path(B, [(0.096, 0.534, -0.086), (0.150, 0.528, -0.052),
                   (0.204, 0.536, -0.090)], 0.0040, RUB, 6, up=(0.0, 1.0, 0.0))

    # ---- the net. A lattice of 5 mm cord following a surface that sags into
    #      the gaps between the containers, because a net drawn as a flat grid
    #      over a lumpy pile is a decal.
    def surf(u, v):
        """u across (-1..1), v fore-aft (-1..1) -> the net's height there."""
        top = 0.30
        top = max(top, 0.560 - 2.6 * (abs(u - 0.62) ** 2) - 1.9 * (abs(v + 0.42) ** 2))
        top = max(top, 0.500 - 1.2 * (abs(v - 0.14) ** 2) - 0.30 * (abs(u + 0.60) ** 2))
        return top - 0.030 * (1.0 - u * u) * (1.0 - v * v)
    HX, HZ = 0.268, 0.248
    for i in range(7):
        u = -1.0 + 2.0 * i / 6
        pts = [(u * HX, surf(u, -1.0 + 2.0 * j / 8) - 0.004, (-1.0 + 2.0 * j / 8) * HZ)
               for j in range(9)]
        pts = [(pts[0][0], 0.0, pts[0][2] * 1.06)] + pts + [(pts[-1][0], 0.0, pts[-1][2] * 1.06)]
        sweep_path(B, pts, 0.0026, RUB, 6, up=(1.0, 0.0, 0.0))
    for j in range(7):
        v = -1.0 + 2.0 * j / 6
        pts = [((-1.0 + 2.0 * i / 8) * HX, surf(-1.0 + 2.0 * i / 8, v), v * HZ)
               for i in range(9)]
        pts = [(pts[0][0] * 1.06, 0.0, pts[0][2])] + pts + [(pts[-1][0] * 1.06, 0.0, pts[-1][2])]
        sweep_path(B, pts, 0.0026, RUB, 6, up=(0.0, 0.0, 1.0))
    # ---- the metal. Four corner hooks, a ratchet on the starboard face and two
    #      deck rings. This is the half of a cargo net that photographs.
    for (sx, sz) in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        p = (sx * HX * 1.06, 0.042, sz * HZ * 1.06)
        sweep_path(B, [(p[0], 0.086, p[2]), (p[0] + sx * 0.014, 0.044, p[2] + sz * 0.010),
                       (p[0] - sx * 0.006, 0.014, p[2] + sz * 0.024),
                       (p[0] + sx * 0.016, 0.020, p[2] + sz * 0.036)],
                   0.0048, RAIL, 8, up=(0.0, 1.0, 0.0))
    B.box(0.286, 0.150, -0.040, 0.330, 0.230, 0.040, DK)
    lathe(B, (0.352, 0.190, 0.0), (1.0, 0.0, 0.0),
          [(0.0, -0.030), (0.026, -0.030), (0.030, -0.020), (0.030, 0.020),
           (0.026, 0.030), (0.0, 0.030)], RAIL, 14, shape=knurl(10, 0.06),
          ref=(0.0, 1.0, 0.0))
    sweep_path(B, [(0.352, 0.190, 0.030), (0.352, 0.244, 0.062),
                   (0.352, 0.196, 0.092)], 0.0055, DK, 8, up=(1.0, 0.0, 0.0))
    for sz in (-1, 1):
        lathe(B, (0.300, 0.006, sz * 0.300), (0.0, 1.0, 0.0),
              [(0.020, 0.0), (0.024, 0.006), (0.020, 0.012)], DK, 12)
        sweep_path(B, [(0.300, 0.012, sz * 0.300), (0.300, 0.036, sz * 0.288),
                       (0.300, 0.030, sz * 0.312)], 0.0036, RAIL, 8, up=(1.0, 0.0, 0.0))
    return B.obj(name)
