# ---------------------------------------------------------------- hi-poly tiles
def _plate_box(bm, x0, y0, x1, y1, ztop, base):
    box_bm(bm, x0, y0, base, x1, y1, ztop)

def rivet_row(bm, x0, y0, x1, y1, n, r=0.0055, h=0.0035, base=0.0):
    for i in range(n):
        t = (i + 0.5) / n
        cx = x0 + (x1 - x0) * t; cy = y0 + (y1 - y0) * t
        cyl_bm(bm, cx, cy, base - 0.002, base + h, r, 8, taper=0.72)

def hex_bolt(bm, cx, cy, base, r=0.011, h=0.006):
    cyl_bm(bm, cx, cy, base - 0.002, base + h, r, 6, taper=0.86)

PANEL_TILE = 2.0
PANEL_PLATES = [
    (0.00, 0.00, 1.15, 0.86,  0.000),
    (1.15, 0.00, 2.00, 0.86, -0.013),
    (0.00, 0.86, 0.72, 2.00,  0.000),
    (0.72, 0.86, 1.46, 1.44, -0.013),
    (1.46, 0.86, 2.00, 1.44,  0.000),
    (0.72, 1.44, 2.00, 2.00,  0.007),
]
DECK_TILE = 1.5
DECK_PLATES = [
    (0.00, 0.00, 0.75, 0.75, 0.0), (0.75, 0.00, 1.50, 0.75, 0.0),
    (0.00, 0.75, 0.75, 1.50, 0.0), (0.75, 0.75, 1.50, 1.50, 0.0),
]

def recess(bm, x0, y0, x1, y1, top, floor, base, w):
    """A sunken bay: four frame boxes at plate height around a lower floor.
       Boxes are additive here, so a recess has to be built as the walls that
       surround it -- dropping a shallower box inside a taller one changes
       nothing at all."""
    box_bm(bm, x0, y0, base, x1, y0+w, top)
    box_bm(bm, x0, y1-w, base, x1, y1, top)
    box_bm(bm, x0, y0+w, base, x0+w, y1-w, top)
    box_bm(bm, x1-w, y0+w, base, x1, y1-w, top)
    box_bm(bm, x0+w, y0+w, base, x1-w, y1-w, floor)

def build_panel_hi(seed=3):
    """2 m tile of ship plating: irregular plates, welds, rivets, a hatch,
       a louvre vent and a stiffener. Emitted as a 3x3 array so the bake of the
       centre tile is seamless."""
    TILE = PANEL_TILE
    GAP  = 0.011
    BASE = -0.026
    PLATES = PANEL_PLATES
    bm = bmesh.new()
    for ox in (-1, 0, 1):
        for oy in (-1, 0, 1):
            dx, dy = ox * TILE, oy * TILE
            # backing sheet
            box_bm(bm, dx - 0.001, dy - 0.001, BASE - 0.02, dx + TILE + 0.001, dy + TILE + 0.001, BASE)
            for (x0, y0, x1, y1, zt) in PLATES:
                _plate_box(bm, dx + x0 + GAP*0.5, dy + y0 + GAP*0.5,
                               dx + x1 - GAP*0.5, dy + y1 - GAP*0.5, zt, BASE)
            # weld bead along one long seam, half-round
            cyl_bm(bm, 0, 0, 0, 0, 0.0001, 3)  # keep bmesh happy on empty branches
            for (ax, ay, bx, by) in [(0.00, 0.86, 1.15, 0.86), (1.46, 0.86, 1.46, 1.44)]:
                n = 26
                for i in range(n):
                    t0, t1 = i/n, (i+1)/n
                    px = ax + (bx-ax)*t0; py = ay + (by-ay)*t0
                    qx = ax + (bx-ax)*t1; qy = ay + (by-ay)*t1
                    w = 0.011 + 0.0035*math.sin(i*2.1)
                    if abs(bx-ax) > abs(by-ay):
                        box_bm(bm, dx+px, dy+py-w, -0.010, dx+qx, dy+py+w, -0.0035 + 0.0012*math.sin(i*1.7))
                    else:
                        box_bm(bm, dx+px-w, dy+py, -0.010, dx+px+w, dy+qy, -0.0035 + 0.0012*math.sin(i*1.7))
            # rivets down the frame edges
            rivet_row(bm, dx+0.055, dy+0.05, dx+0.055, dy+0.81, 9)
            rivet_row(bm, dx+1.095, dy+0.05, dx+1.095, dy+0.81, 9)
            rivet_row(bm, dx+0.06, dy+0.055, dx+1.09, dy+0.055, 12)
            rivet_row(bm, dx+0.78, dy+1.94, dx+1.94, dy+1.94, 13)
            rivet_row(bm, dx+0.78, dy+1.50, dx+1.94, dy+1.50, 13, base=0.007)
            # access hatch recessed into plate 2, its cover sitting proud of
            # the bay floor and bolted at the corners
            hx0, hy0, hx1, hy1 = dx+0.075, dy+1.10, dx+0.645, dy+1.86
            recess(bm, hx0, hy0, hx1, hy1, 0.0, -0.021, BASE, 0.055)
            box_bm(bm, hx0+0.075, hy0+0.075, BASE, hx1-0.075, hy1-0.075, -0.008)
            for bxp in (hx0+0.105, hx1-0.105):
                for byp in (hy0+0.105, hy1-0.105):
                    hex_bolt(bm, bxp, byp, -0.008)
            # a shallow service bay on the big plate
            recess(bm, dx+0.14, dy+0.14, dx+0.62, dy+0.52, 0.0, -0.014, BASE, 0.04)
            # louvre vent on the sunk plate 1
            for i in range(6):
                yv = dy + 0.20 + i*0.098
                box_bm(bm, dx+1.34, yv, -0.013, dx+1.86, yv+0.052, -0.0045)
            box_bm(bm, dx+1.315, dy+0.175, -0.013, dx+1.885, dy+0.19, 0.001)
            box_bm(bm, dx+1.315, dy+0.775, -0.013, dx+1.885, dy+0.79, 0.001)
            # stiffener rib on the proud plate
            box_bm(bm, dx+0.90, dy+1.56, 0.007, dx+1.86, dy+1.60, 0.019)
            box_bm(bm, dx+0.90, dy+1.78, 0.007, dx+1.86, dy+1.82, 0.019)
            # a scatter of fasteners
            rnd = random.Random(seed)
            for k in range(7):
                hex_bolt(bm, dx + 0.15 + rnd.random()*1.7, dy + 0.10 + rnd.random()*0.6,
                         0.0 if rnd.random() < 0.5 else -0.013)
    ob = bm_to_obj(bm, "hi_panel")
    return ob

def build_deck_hi(seed=11):
    """1.5 m tile of anti-slip deck plate."""
    TILE = 1.5
    GAP  = 0.012
    BASE = -0.020
    bm = bmesh.new()
    for ox in (-1, 0, 1):
        for oy in (-1, 0, 1):
            dx, dy = ox*TILE, oy*TILE
            box_bm(bm, dx-0.001, dy-0.001, BASE-0.02, dx+TILE+0.001, dy+TILE+0.001, BASE)
            for px in range(2):
                for py in range(2):
                    x0 = dx + px*0.75 + GAP*0.5; y0 = dy + py*0.75 + GAP*0.5
                    x1 = dx + (px+1)*0.75 - GAP*0.5; y1 = dy + (py+1)*0.75 - GAP*0.5
                    box_bm(bm, x0, y0, BASE, x1, y1, 0.0)
                    # countersunk fasteners at the corners
                    for fx in (x0+0.035, x1-0.035):
                        for fy in (y0+0.035, y1-0.035):
                            cyl_bm(bm, fx, fy, -0.006, 0.0016, 0.010, 8, taper=0.62)
            # raised anti-slip lozenges, staggered rows
            nx, ny = 13, 26
            for r in range(ny):
                yy = dy + (r + 0.5) * TILE/ny
                lean = 0.030 if (r // 1) % 2 == 0 else -0.030
                for c in range(nx):
                    xx = dx + (c + (0.5 if r % 2 else 0.0)) * TILE/nx + 0.02
                    if xx > dx + TILE - 0.01: continue
                    box_bm(bm, xx-0.028, yy-0.011, 0.0, xx+0.028, yy+0.011, 0.0034)
                    box_bm(bm, xx-0.021+lean, yy-0.011, 0.0034, xx+0.021+lean, yy+0.011, 0.0044)
    ob = bm_to_obj(bm, "hi_deck")
    return ob

def build_soft_hi(seed=5):
    """0.5 m tile of woven acoustic liner / upholstery: a coarse weave with a
       quilted stitch line."""
    TILE = 0.5
    bm = bmesh.new()
    n = 34
    p = TILE / n
    for ox in (-1, 0, 1):
        for oy in (-1, 0, 1):
            dx, dy = ox*TILE, oy*TILE
            box_bm(bm, dx, dy, -0.008, dx+TILE, dy+TILE, -0.003)
            for i in range(n):
                for j in range(n):
                    x = dx + i*p; y = dy + j*p
                    # warp over weft, alternating
                    if (i + j) % 2 == 0:
                        box_bm(bm, x+p*0.08, y-p*0.02, -0.003, x+p*0.92, y+p*1.02, 0.0015)
                    else:
                        box_bm(bm, x-p*0.02, y+p*0.08, -0.003, x+p*1.02, y+p*0.92, 0.0012)
            # quilt seam every quarter
            for k in (0, 1):
                box_bm(bm, dx, dy+k*TILE*0.5-0.004, -0.006, dx+TILE, dy+k*TILE*0.5+0.004, -0.0015)
    return bm_to_obj(bm, "hi_soft")
