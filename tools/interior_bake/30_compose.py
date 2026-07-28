# ------------------------------------------------------- numpy map composition
def grid_uv(res, tile):
    t = (np.arange(res, dtype=np.float32) + 0.5) / res * tile
    U = np.tile(t[None, :], (res, 1))
    V = np.tile(t[:, None], (1, res))
    return U, V

def rect(U, V, x0, y0, x1, y1, soft=0.0):
    if soft <= 0:
        return ((U >= x0) & (U < x1) & (V >= y0) & (V < y1)).astype(np.float32)
    sx = np.clip((U-x0)/soft, 0, 1) * np.clip((x1-U)/soft, 0, 1)
    sy = np.clip((V-y0)/soft, 0, 1) * np.clip((y1-V)/soft, 0, 1)
    return (sx*sy).astype(np.float32)

def stencil_marks(U, V, plates, seed, dens=1.0):
    """Painted information: part numbers, inspection placards, hazard striping,
       hatch roundels. rgb + coverage."""
    res = U.shape[0]
    ink = np.zeros((res, res, 3), np.float32)
    cov = np.zeros((res, res), np.float32)
    def put(m, colr):
        nonlocal ink, cov
        m3 = m[..., None]
        ink[:] = ink*(1-m3) + np.array(colr, np.float32)*m3
        np.maximum(cov, m, out=cov)
    for pi, (x0, y0, x1, y1, _z) in enumerate(plates):
        r = random.Random(seed*977 + pi)
        w, h = x1-x0, y1-y0
        # part number: rows of broken bars
        if r.random() < 0.85*dens:
            bx = x0 + 0.06 + r.random()*w*0.35
            by = y0 + 0.08 + r.random()*h*0.6
            bw = min(0.16 + r.random()*0.18, w-0.12)
            rows = r.randint(2, 3)
            bh = 0.016
            for k in range(rows):
                yy = by + k*(bh*1.9)
                n = r.randint(5, 11)
                for c in range(n):
                    if r.random() < 0.18: continue
                    cx = bx + bw*c/n
                    put(rect(U, V, cx, yy, cx + bw/n*0.66, yy+bh), (0.80, 0.80, 0.77))
        # inspection placard
        if r.random() < 0.6*dens:
            px = x0 + 0.10 + r.random()*max(w-0.30, 0.02)
            py = y0 + 0.10 + r.random()*max(h-0.20, 0.02)
            pw, ph = 0.15 + r.random()*0.09, 0.075
            put(rect(U, V, px, py, px+pw, py+ph), (0.78, 0.78, 0.74))
            put(rect(U, V, px+0.012, py+ph*0.55, px+pw-0.012, py+ph*0.78), (0.10, 0.10, 0.11))
            put(rect(U, V, px+0.012, py+ph*0.22, px+pw*0.62, py+ph*0.44), (0.10, 0.10, 0.11))
        # hazard striping, rare
        if r.random() < 0.22*dens:
            band = rect(U, V, x0+0.02, y0+0.02, x1-0.02, y0+0.075)
            diag = (((U*7.0 + V*9.8) % 1.0) < 0.5).astype(np.float32)
            put(band*diag, (0.44, 0.20, 0.05))
            put(band*(1-diag), (0.055, 0.048, 0.042))
        # roundel by a hatch
        if r.random() < 0.35*dens:
            cx = x0 + 0.10 + r.random()*max(w-0.20, 0.02)
            cy = y0 + 0.10 + r.random()*max(h-0.20, 0.02)
            d = np.sqrt((U-cx)**2 + (V-cy)**2)
            ring = ((d > 0.048) & (d < 0.060)).astype(np.float32)
            pip  = (d < 0.016).astype(np.float32)
            put(np.maximum(ring, pip), (0.66, 0.68, 0.66))
    return ink, cov

def plate_id_maps(U, V, plates, seed):
    res = U.shape[0]
    tone = np.ones((res, res), np.float32)
    warm = np.zeros((res, res), np.float32)
    for pi, (x0, y0, x1, y1, _z) in enumerate(plates):
        r = random.Random(seed*131 + pi*7)
        m = rect(U, V, x0, y0, x1, y1)
        tone = tone*(1-m) + m*(0.86 + r.random()*0.28)
        warm = warm*(1-m) + m*(r.random()-0.5)
    return tone, warm

def blur_wrap(a, sigma):
    if sigma <= 0: return a
    r = max(1, int(sigma*3))
    x = np.arange(-r, r+1, dtype=np.float32)
    k = np.exp(-0.5*(x/sigma)**2); k /= k.sum()
    out = a
    pad = np.concatenate([out[:, -r:], out, out[:, :r]], 1)
    out = np.apply_along_axis(lambda m: np.convolve(m, k, 'valid'), 1, pad)
    pad = np.concatenate([out[-r:, :], out, out[:r, :]], 0)
    out = np.apply_along_axis(lambda m: np.convolve(m, k, 'valid'), 0, pad)
    return out.astype(np.float32)

def normal_from_height(h, texel, sigma=1.4, clampH=0.012, scale=1.0, nzMin=0.16):
    """Filtered tangent-space normal from a baked height field.

       Two knobs, both load-bearing. clampH compresses a deep panel gap into a
       shallow one: a 26 mm slot differentiated over two texels is a normal
       lying flat on the surface, which renders as a black slit that crawls the
       moment the wall tilts. sigma is the prefilter that keeps every slope at
       least a texel wide, which is what a mip chain then has something to
       average."""
    hc = np.clip(h - np.median(h), -clampH, clampH)
    hc = blur_wrap(hc, sigma)
    dx = (np.roll(hc, -1, 1) - np.roll(hc, 1, 1)) / (2*texel)
    dy = (np.roll(hc, -1, 0) - np.roll(hc, 1, 0)) / (2*texel)
    nx = -dx*scale; ny = -dy*scale
    nz = np.ones_like(nx)
    l = np.sqrt(nx*nx + ny*ny + nz*nz)
    nx, ny, nz = nx/l, ny/l, nz/l
    nz = np.maximum(nz, nzMin)
    l = np.sqrt(nx*nx + ny*ny + nz*nz)
    return np.stack([nx/l, ny/l, nz/l], -1).astype(np.float32)

def compose_tile(maps, tag, tile, res, plates, cfg):
    """Baked height + AO -> albedo, ORM and a prefiltered normal map."""
    h   = maps['bk_h_' + tag][..., 0]
    ao  = np.clip(maps['bk_ao_' + tag][..., 0], 0.0, 1.0)
    U, V = grid_uv(res, tile)
    texel = tile / res

    nl = normal_from_height(h, texel, sigma=cfg.get('nrmBlur', 1.4),
                            clampH=cfg.get('clampH', 0.012),
                            scale=cfg.get('nrmAmp', 1.0))
    slope = np.sqrt(np.clip(1.0 - nl[..., 2]**2, 0, 1))

    # A crown is a high spot that is also open to the room: chamfered plate
    # edges, weld beads, rivet heads. That is exactly the set of surfaces a
    # sleeve or a boot rubs the paint off.
    hb = blur_wrap(h, 6.0)
    prom = np.clip((h - hb) / cfg.get('promScale', 0.008), -1, 1)
    open_ = smooth(ao, 0.55, 0.97)
    crown = np.clip(smooth(prom, -0.05, 0.65) * (0.30 + slope*2.0), 0, 1) * open_
    cav = np.clip(ao, 0, 1)

    n1 = pnoise(res, 11, seed=41+len(tag), octaves=4)
    n2 = pnoise(res, 34, seed=77+len(tag), octaves=2)
    n3 = pnoise(res, 4,  seed=13+len(tag), octaves=2)
    # Grime does not sit in a hard-edged occlusion mask; it spreads out of it.
    cavB = blur_wrap(np.clip(ao, 0, 1), cfg.get('dirtBlur', 14.0))
    tone, warm = plate_id_maps(U, V, plates, cfg.get('seed', 3))

    # ---- albedo. Authored near white and tinted by material.color in the
    # game, so the palette stays in one place and everything here is modulation.
    alb = np.ones((res, res, 3), np.float32)
    alb *= (0.96 + (n2-0.5)[..., None]*0.10) * (0.95 + (n1-0.5)[..., None]*0.17)
    alb *= tone[..., None]
    wc = cfg.get('warmCool', 0.14)
    alb *= np.stack([1+warm*wc, np.ones_like(warm), 1-warm*wc*1.2], -1)
    alb *= (1.0 - (1.0-cav)*cfg.get('cavDark', 0.80))[..., None]
    dirt = np.clip(smooth(n3, 0.30, 0.86)*0.55 + (1-cavB)*1.5 + (1-cav)*0.45, 0, 1) \
         * cfg.get('grime', 0.8)
    alb = alb*(1-(dirt*0.46)[..., None]) + alb*np.array([0.58,0.52,0.44],np.float32)*(dirt*0.46)[..., None]
    ink, mcov = stencil_marks(U, V, plates, cfg.get('seed', 3), cfg.get('mark', 1.0))
    mcov = mcov * (1 - crown*0.75) * smooth(cav, 0.45, 0.95) * (0.72 + 0.28*n1)
    alb = alb*(1-mcov[..., None]) + ink*mcov[..., None]
    wear = np.clip(crown * cfg.get('wear', 0.9) * (0.30 + smooth(n1, 0.30, 0.85)*1.0), 0, 1)
    et = np.array(cfg.get('edgeTint', [0.70, 0.72, 0.74]), np.float32)
    alb = alb*(1-wear[..., None]*0.80) + et*wear[..., None]*0.80
    alb = np.clip(alb, 0.02, 1.0)

    # ---- ORM: R = ambient occlusion, G = roughness, B = metalness
    rlo, rhi = cfg.get('roughLo', 0.62), cfg.get('roughHi', 0.98)
    t = np.clip(0.45 + (n2-0.5)*0.70 + (tone-1.0)*1.0 + (1-cav)*0.55 - crown*0.60, 0, 1)
    rough = rlo + (rhi-rlo)*t
    rough = rough*(1-mcov*0.5) + cfg.get('markRough', 0.72)*mcov*0.5
    metal = np.clip(wear*cfg.get('bare', 0.55), 0, 1)
    orm = np.stack([np.clip(cav**cfg.get('aoPow', 1.0), 0, 1),
                    np.clip(rough, 0, 1), metal], -1).astype(np.float32)

    nmap = (nl*0.5 + 0.5).astype(np.float32)
    return alb, orm, nmap

def smooth(x, a, b):
    t = np.clip((x-a)/(b-a), 0, 1)
    return t*t*(3-2*t)

def rgba(a):
    res = a.shape[0]
    out = np.ones((res, res, 4), np.float32)
    out[..., :3] = a
    return out
