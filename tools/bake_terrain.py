#!/usr/bin/env python3
"""
Bake the ground's tiling PBR sets.

    python3 tools/bake_terrain.py            # all four materials
    python3 tools/bake_terrain.py rock sand  # a subset

Writes into public/models/, one map per material:

    terr_<name>.webp   R = albedo, gamma 2   G,B = tangent normal xy
                       A = mineral index

One image, not three, and that is a decision rather than a saving. The ground
shader has no specular term at all -- it is a wrap-diffuse key plus a sky fill
plus a bounce -- so roughness and metalness have nowhere to go. And the albedo
is authored near-neutral, because the palette lives in the uC* uniforms where
one world can be oxide and the next bone; what a terrain albedo map actually
carries is *tone*, one channel of it. That leaves luminance and two channels of
normal, which is exactly an RGB image, and it means the whole set is one
sampler2DArray and one fetch per sample point instead of three. At three detail
scales and up to three triplanar planes that difference is the entire budget.

**The fourth channel is a mineral index, and it is the reason the ground could
not be more than one colour.** Everything above is a *scalar*, and multiplying a
palette colour by a scalar preserves every hue ratio in it -- so there was
structurally no way to put a pale chip on red sand, whatever the relief did. The
shader's workaround was to derive a mineral axis from the luminance itself,
which cannot work either: the luminance is mostly occlusion, cavity and grit, so
the "mineral" it recovered was a picture of the *shading*, and it went to
exactly the mean the moment the tile minified. Measured, the near ground ran a
saturation standard deviation of 0.061-0.10 against 0.226-0.321 for reference
photography of the same subject.

A is a genuine per-block, per-clast, per-plate mineral identity -- the `tone`
field each generator already computes, which is uncorrelated with the relief by
construction, plus the low-frequency stain -- and the shader rotates the palette
about it. Two notes on the encoding:

  * **It lives in [0.5, 1.0], not [0, 1].** The loader decodes through a 2D
    canvas, and canvas 2D stores premultiplied: an alpha of a means the colour
    channels survive a round trip through `round(c*a)/a`, so at a = 0.02 a
    normal channel comes back fifty levels out. Half the range costs one bit of
    a channel that carries a slow modulation and nothing else, and bounds the
    damage to the other three at one level -- inside the two the normal is
    already quantised to.
  * It is normalised to a mean of 0.5 (i.e. 0.75 stored) so that a minified tile
    lands on the palette's own colour and the fade to distance is invisible,
    exactly as the luminance channel does.

    rock    fractured bedrock -- polygonal blocks, bedding, spall
    sand    fine regolith -- irregular ripple trains, granules, scour
    scree   a packed bed of angular clasts, five size classes
    crust   desiccation polygons -- raised plate edges, deep cracks

Why this exists at all: the ground was surfaced entirely by noise evaluated per
fragment. A procedural field has no mip chain, so nothing prefilters it -- the
high frequencies cannot survive minification and what is left over the whole
foreground is one low-frequency term being asked to carry an area it has no
bandwidth for. That reads, precisely, as regular ripples. Baked maps are both
sharper (they can carry an octave the fragment stage could never afford) and
cheaper (they delete the shader work), which is the same trade the ship interior
made when it went 569k triangles to 68.8k and 87 fps to 120.

Three things about the method, inherited from tools/bake_interior.py.

  * **The normal comes from a height field, not from a tangent-space bake off a
    flat cage.** A downward ray has no cross-section for a vertical wall, so a
    NORMAL bake off a plane records nothing at all for a fracture face. Here the
    height field is *authored* in numpy, so it is exact, and the normal is a
    filtered central difference of it.

  * **Seamlessness comes from periodicity, not from a fade.** Every field below
    is built from periodic primitives -- a wrapped Worley lattice and a wrapped
    value-noise fbm -- so the tile is exactly continuous with itself. The
    occlusion bake would still see a cliff at the border, so the hi-poly is
    emitted with a quarter-metre of wrapped margin on every side and only the
    centre is baked.

  * **Occlusion is ray traced.** It is the one quantity numpy cannot fake: what
    makes a bed of stones read as stones is the contact darkening where two of
    them touch, and that is a visibility integral over real geometry.

Run headless on purpose. The BlenderMCP socket drives whatever instance is
already open, and that instance belongs to whoever is using it; a bake changes
the render engine, the sample count and the bake settings for the whole scene.
This spawns its own process instead and touches nobody.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUTDIR = os.path.join(ROOT, 'public', 'models')
TMP = os.environ.get('BAKE_TMP', '/tmp/terrain_bake')
BLENDER = os.environ.get(
    'BLENDER', '/Applications/Blender.app/Contents/MacOS/Blender')

# ---------------------------------------------------------------- tile spec
#
# One tile is two metres square. The game samples the same set at three scales
# -- roughly 0.55 m, 4.3 m and 31 m -- so a feature authored at 30 cm here is a
# 8 cm clast under your boots, a 65 cm block on a bank and a five-metre buttress
# on a mountain face. Authoring one set that has to work over that whole range
# is why the fields below are fractal rather than a single scale of thing.
TILE = 2.0
FIELD = 1024          # the height field, and what the normal is differenced at
OUT = 512             # what ships
MARGIN = 0.28         # wrapped surround so the occlusion bake sees neighbours
AO_RES = 1024         # baked, then boxed down to OUT

MATS = ('rock', 'sand', 'scree', 'crust')


# ==========================================================================
#  driver side (system python3): spawn Blender, then encode
# ==========================================================================
def drive(which):
    os.makedirs(OUTDIR, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)
    cmd = [BLENDER, '--background', '--factory-startup', '--python', __file__,
           '--', 'BAKE'] + list(which)
    env = dict(os.environ, BAKE_TMP=TMP)
    r = subprocess.run(cmd, env=env, capture_output=True, text=True)
    tail = (r.stdout or '')[-4000:]
    print(tail)
    if r.returncode != 0:
        print(r.stderr[-4000:])
        raise SystemExit('blender failed')
    encode(which)


def encode(which):
    """Blender's WebP writer ignores the quality argument and always writes
       lossless, so the maps come out as PNG and are encoded here.

       **Lossless, and it is not a luxury.** WebP's lossy path is YUV with
       chroma decimation, which couples the three channels -- and two of these
       three are a normal map. Measured on the rock tile: quality 100 lossy
       still moved a channel by up to 124/255 and 6.6 rms, which rakes as
       blocky facets the moment the sun is low. Quantising x and y to seven bits
       first costs 0.4 degrees of tilt, which nothing can see, and buys back
       most of what lossless costs."""
    from PIL import Image
    import numpy as np
    total = 0
    for name in which:
        src = os.path.join(TMP, 'terr_%s.png' % name)
        dst = os.path.join(OUTDIR, 'terr_%s.webp' % name)
        a = np.asarray(Image.open(src).convert('RGBA')).copy()
        a[..., 1:3] = (a[..., 1:3] & 0xFE) | 1        # 7 bits for the normal
        Image.fromarray(a, 'RGBA').save(
            dst, 'WEBP', lossless=True, quality=80, method=6, exact=True)
        kb = os.path.getsize(dst) / 1024
        total += kb
        print('%-18s %5d  %7.0f KB' % (os.path.basename(dst), a.shape[0], kb))
    print('%-18s        %7.0f KB total' % ('', total))


# ==========================================================================
#  Blender side
# ==========================================================================
def blender_main(which):
    import bpy
    import numpy as np

    tmp = os.environ.get('BAKE_TMP', TMP)
    os.makedirs(tmp, exist_ok=True)

    # ---------------------------------------------------- periodic primitives
    def pnoise(res, freq, seed=0, octaves=4, gain=0.5):
        """Wrapped value-noise fbm. Period is exactly res, so it tiles."""
        rng = np.random.default_rng(seed)
        out = np.zeros((res, res), np.float32)
        amp, tot, f = 1.0, 0.0, int(freq)
        for _ in range(octaves):
            g = rng.random((f, f)).astype(np.float32)
            t = np.arange(res, dtype=np.float32) * f / res
            i0 = np.floor(t).astype(int) % f
            i1 = (i0 + 1) % f
            fr = t - np.floor(t)
            fr = fr * fr * (3 - 2 * fr)
            a = g[np.ix_(i0, i0)]; b = g[np.ix_(i0, i1)]
            c = g[np.ix_(i1, i0)]; d = g[np.ix_(i1, i1)]
            fx = fr[None, :]; fy = fr[:, None]
            out += amp * ((a * (1 - fx) + b * fx) * (1 - fy)
                          + (c * (1 - fx) + d * fx) * fy)
            tot += amp; amp *= gain; f *= 2
        return (out / tot).astype(np.float32)

    def pworley(res, cells, seed, jitter=0.9, nattr=3):
        """Wrapped Worley. Returns (f1, f2, attrs) with distances in *cell*
           units and attrs a stack of per-cell uniform randoms carried by
           whichever cell owns f1 -- a block's height, its tone, its dip.

           The neighbour search is over the unwrapped index, and the seed's
           offset is looked up modulo the lattice, which is what makes the field
           periodic without a special case at the border."""
        rng = np.random.default_rng(seed)
        off = 0.5 + (rng.random((cells, cells, 2)).astype(np.float32) - 0.5) * jitter
        at = rng.random((nattr, cells, cells)).astype(np.float32)
        t = (np.arange(res, dtype=np.float32) + 0.5) / res * cells
        Y = t[:, None]; X = t[None, :]
        ciy = np.floor(Y).astype(np.int32); cix = np.floor(X).astype(np.int32)
        f1 = np.full((res, res), 1e9, np.float32)
        f2 = np.full((res, res), 1e9, np.float32)
        oa = np.zeros((nattr, res, res), np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                iy = (ciy + dy) % cells
                ix = (cix + dx) % cells
                sy = (ciy + dy) + off[iy, ix, 0]
                sx = (cix + dx) + off[iy, ix, 1]
                d = np.sqrt((Y - sy) ** 2 + (X - sx) ** 2)
                closer = d < f1
                f2 = np.where(d < f2, np.where(closer, f1, d), f2)
                for k in range(nattr):
                    oa[k] = np.where(closer, at[k][iy, ix], oa[k])
                f1 = np.where(closer, d, f1)
        return f1, f2, oa

    def sm(x, a, b):
        t = np.clip((x - a) / (b - a), 0, 1)
        return (t * t * (3 - 2 * t)).astype(np.float32)

    def blur_wrap(a, sigma):
        if sigma <= 0:
            return a
        r = max(1, int(sigma * 3))
        x = np.arange(-r, r + 1, dtype=np.float32)
        k = np.exp(-0.5 * (x / sigma) ** 2); k /= k.sum()
        out = a
        for ax in (1, 0):
            pad = np.concatenate(
                [np.take(out, range(-r, 0), axis=ax), out,
                 np.take(out, range(0, r), axis=ax)], axis=ax)
            out = np.apply_along_axis(lambda m: np.convolve(m, k, 'valid'), ax, pad)
        return out.astype(np.float32)

    def boxdown(a, n):
        """Average-pool by an integer factor. Prefiltering the supersampled bake
           rather than point-sampling it is the whole reason to bake at 2x."""
        f = a.shape[0] // n
        if f <= 1:
            return a
        s = a.reshape(n, f, n, f) if a.ndim == 2 else a.reshape(n, f, n, f, a.shape[-1])
        return s.mean(axis=(1, 3)).astype(np.float32)

    # ------------------------------------------------------- the four fields
    #
    # Every one of these returns metres of relief above the tile's datum, on a
    # FIELD x FIELD periodic grid, plus a bag of masks the albedo wants. None of
    # them is a single scale of thing: the same map is stretched sixty to one
    # between the fine and the macro sample, so anything that lives at exactly
    # one frequency shows up as a repeating motif at whichever scale it lands.

    def f_rock(seed=7):
        R, S = FIELD, TILE
        # Fracture blocks. A rock face is not bumpy, it is *broken*: flat-ish
        # planes meeting along hard lines. Worley's f2-f1 is that line, and the
        # per-cell attribute is the plane each block sits on.
        f1, f2, at = pworley(R, 6, seed, jitter=0.98)
        cw = S / 6.0                                   # a cell in metres
        edge = (f2 - f1) * cw
        crack = 1.0 - sm(edge, 0.0, 0.030)
        step = (at[0] - 0.5) * 0.034                   # +-17 mm per block
        # each block dips its own way, so the faces catch the key differently
        yy = (np.arange(R, dtype=np.float32) + 0.5) / R * S
        Yp = yy[:, None]; Xp = yy[None, :]
        dipa = at[1] * 6.28318
        step = step + (np.cos(dipa) * (Xp - S * 0.5) + np.sin(dipa) * (Yp - S * 0.5)) \
            * (at[2] - 0.5) * 0.055
        h = step - crack * 0.020

        # Bedding. Laminations running along one strike, thickness varying bed
        # by bed, which is what puts horizontal breaks across a face.
        #
        # The strike has to be a *lattice* direction or the tile does not wrap:
        # a bench taken on cos(a)x + sin(a)y is a staircase that climbs across
        # the tile and lands 11 cm out of register with itself at the border.
        # Integer wave numbers make the phase periodic by construction, and the
        # per-bed random is indexed modulo the bed count, which is the one
        # residue both wraps preserve.
        kx, ky, nbeds = 2.0, 5.0, 7
        s = ((kx * Xp + ky * Yp) / S) * nbeds + (at[0] - 0.5) * 1.3
        rb = np.random.default_rng(seed + 71).random(nbeds).astype(np.float32)
        bi = np.mod(np.floor(s), nbeds).astype(np.int32)
        fs = np.mod(s, 1.0)
        # a bed is a plateau with a riser; thickness and relief vary bed to bed
        led = sm(fs, 0.10, 0.30 + 0.34 * rb[bi]) - sm(fs, 0.74, 0.96)
        h += (led - 0.4) * 0.0105 * (0.35 + 0.65 * at[1]) * (0.4 + 1.2 * rb[bi])

        # A finer fracture set, and spall on the faces.
        f1b, f2b, atb = pworley(R, 17, seed + 11, jitter=0.92)
        h += (atb[0] - 0.5) * 0.0075
        h -= (1.0 - sm((f2b - f1b) * S / 17.0, 0.0, 0.012)) * 0.006
        h += (pnoise(R, 20, seed + 3, 5) - 0.5) * 0.0105
        h += (pnoise(R, 96, seed + 4, 3) - 0.5) * 0.0028

        # Chips shed off the edges, lying in the grooves.
        f1c, _f2c, atc = pworley(R, 46, seed + 21, 1.0)
        chip = np.clip(1.0 - f1c / 0.42, 0, 1) ** 0.7 * 0.0055
        h += chip * (atc[0] > 0.62) * (crack * 0.8 + 0.2)

        h -= h.mean()
        return h, dict(tone=at[0], grit=pnoise(R, 60, seed + 9, 3),
                       crack=crack, bare=sm(np.abs(step) * 30.0, 0.1, 0.9))

    def f_sand(seed=19):
        R, S = FIELD, TILE
        yy = (np.arange(R, dtype=np.float32) + 0.5) / R * S
        Yp = yy[:, None]; Xp = yy[None, :]
        # Ripple trains. The failure mode this replaces was a *sine*: one
        # wavelength, one direction, phase-warped, painted over the whole
        # foreground. Real ripples fork, die out, cross a second set at an angle
        # and are asymmetric across the wind. All four, and none of them costs
        # anything once it is a texture.
        wa = 0.30
        warp = (pnoise(R, 3, seed, 4) - 0.5) * 2.0 + (pnoise(R, 9, seed + 1, 3) - 0.5) * 0.7
        n1 = 11.0
        ph = ((np.cos(wa) * Xp + np.sin(wa) * Yp) / S) * n1 + warp * 1.35
        p = np.mod(ph, 1.0)
        # gentle stoss, sharp brink, short steep lee
        prof = np.where(p < 0.72, (p / 0.72) ** 1.6, 1.0 - sm((p - 0.72) / 0.28, 0.0, 1.0))
        amp = 0.35 + 0.65 * sm(pnoise(R, 5, seed + 2, 3), 0.30, 0.72)
        h = (prof - 0.45) * 0.0135 * amp

        wb = 1.25
        warp2 = (pnoise(R, 4, seed + 5, 3) - 0.5) * 1.6
        n2 = 17.0
        ph2 = ((np.cos(wb) * Xp + np.sin(wb) * Yp) / S) * n2 + warp2 * 1.1
        p2 = np.mod(ph2, 1.0)
        h += ((np.where(p2 < 0.7, (p2 / 0.7) ** 1.5, 1.0 - (p2 - 0.7) / 0.3)) - 0.45) \
            * 0.0050 * (1.0 - amp * 0.6)

        # Coarse granules left on the surface where the fines blew out, and a
        # scatter of deeper scour pits.
        f1, _f2, at = pworley(R, 52, seed + 7, 1.0)
        gr = np.clip(1.0 - f1 / 0.34, 0, 1) ** 0.6
        gran = gr * (at[0] > 0.55) * 0.0042
        h += gran
        f1p, _f2p, atp = pworley(R, 7, seed + 13, 1.0)
        pit = np.clip(1.0 - f1p / 0.55, 0, 1) ** 1.4 * (atp[0] > 0.72)
        h -= pit * 0.0075
        h += (pnoise(R, 34, seed + 8, 4) - 0.5) * 0.0034
        h += (pnoise(R, 150, seed + 9, 3) - 0.5) * 0.0021

        # Chips and pale grit lying on the surface. These are mostly *albedo* --
        # a millimetre of relief and a forty per cent tonal step -- because that
        # is what they are in life, and because a reviewer measuring this ground
        # against a real frame found "zero albedo variation, the colour is
        # literally constant, only the shading changes". A surface whose tone
        # tracks its own normal exactly is a clay render.
        tone = np.full((R, R), 0.5, np.float32)
        tone += (pnoise(R, 6, seed + 11, 3) - 0.5) * 0.9
        for cells, dens, tv, rr in ((23, 0.16, -0.42, 0.30), (37, 0.22, 0.40, 0.26),
                                    (61, 0.30, -0.26, 0.24)):
            f1c, _f2c, atc = pworley(R, cells, seed + 41 * len(str(cells)), 1.0)
            m = (np.clip(1.0 - f1c / rr, 0, 1) ** 0.4) * (atc[0] < dens)
            tone = tone * (1 - m) + (0.5 + tv * (0.6 + 0.8 * atc[1])) * m
            h += m * 0.0011 * np.sign(tv)
        h -= h.mean()
        return h, dict(tone=tone,
                       grit=pnoise(R, 110, seed + 12, 3),
                       crack=np.zeros_like(h),
                       bare=np.clip(gran * 300.0, 0, 1))

    def f_scree(seed=31):
        R, S = FIELD, TILE
        yy = (np.arange(R, dtype=np.float32) + 0.5) / R * S
        Yp = yy[:, None]; Xp = yy[None, :]
        h = (pnoise(R, 26, seed, 4) - 0.5) * 0.0034 + (pnoise(R, 120, seed + 1, 3) - 0.5) * 0.0013
        tone = np.full((R, R), 0.5, np.float32)
        top = np.zeros((R, R), np.float32)
        # Five size classes, largest first, each a max() against what is already
        # there. max() is the whole trick: where two clasts overlap it leaves a
        # crease rather than a sum, and a crease with ray-traced occlusion in it
        # is what makes a bed of stones read as stones instead of as lumps.
        CLASS = ((4, 0.185, 0.052, 0.30), (7, 0.120, 0.036, 0.40),
                 (11, 0.078, 0.023, 0.46), (18, 0.048, 0.014, 0.52),
                 (29, 0.030, 0.0085, 0.58))
        for k, (cells, rad, hgt, dens) in enumerate(CLASS):
            f1, _f2, at = pworley(R, cells, seed + 17 * k, jitter=1.0)
            dm = f1 * (S / cells)                       # metres from the seed
            # angular, not round: a lobed radius, and a shoulder rather than a dome
            ang = np.arctan2(Yp - np.round(Yp / (S / cells)) * (S / cells),
                             Xp - np.round(Xp / (S / cells)) * (S / cells))
            lobe = 0.80 + 0.20 * np.cos(3.0 * ang + at[2] * 6.283)
            r = rad * (0.55 + 0.85 * at[1]) * lobe
            z = np.clip(1.0 - (dm / np.maximum(r, 1e-4)) ** 2.6, 0, 1) ** 0.55
            z = z * hgt * (0.6 + 0.8 * at[1])
            live = (at[0] < dens).astype(np.float32)
            z = z * live
            take = z > top
            tone = np.where(take, 0.30 + 0.70 * at[2], tone)
            top = np.maximum(top, z)
        h = np.maximum(h, top - 0.004)
        h += (pnoise(R, 220, seed + 5, 2) - 0.5) * 0.0008
        h -= h.mean()
        return h, dict(tone=tone, grit=pnoise(R, 130, seed + 6, 3),
                       crack=np.zeros_like(h), bare=sm(top, 0.002, 0.012))

    def f_crust(seed=53):
        R, S = FIELD, TILE
        # Desiccation polygons. The one piece of ground detail with a hard edge
        # in it -- everything else on a plain is rounded, which is why a floor
        # without this reads as upholstery.
        f1, f2, at = pworley(R, 5, seed, jitter=0.78)
        cw = S / 5.0
        e = (f2 - f1) * cw
        crack = 1.0 - sm(e, 0.0, 0.024)
        # the plate lifts as it approaches the crack, and curls at the corner
        curl = sm(e, 0.16, 0.020)
        h = (at[0] - 0.5) * 0.0055 + curl * 0.0125 - crack * 0.026
        # a dished centre, so a plate is not a flat chip
        h -= np.clip(1.0 - f1 / 0.45, 0, 1) ** 2 * 0.0035

        f1b, f2b, atb = pworley(R, 13, seed + 3, 0.88)
        eb = (f2b - f1b) * (S / 13.0)
        h += sm(eb, 0.10, 0.012) * 0.0038 - (1.0 - sm(eb, 0.0, 0.009)) * 0.0085
        h += (at[1] - 0.5) * 0.0018
        h += (pnoise(R, 44, seed + 4, 4) - 0.5) * 0.0026
        h += (pnoise(R, 165, seed + 5, 3) - 0.5) * 0.0012
        # grains dusted over the plates
        f1c, _f2c, atc = pworley(R, 64, seed + 9, 1.0)
        h += np.clip(1.0 - f1c / 0.36, 0, 1) ** 0.7 * (atc[0] > 0.70) * 0.0021
        h -= h.mean()
        return h, dict(tone=at[0], grit=pnoise(R, 100, seed + 7, 3),
                       crack=crack, bare=curl)

    FIELDS = dict(rock=f_rock, sand=f_sand, scree=f_scree, crust=f_crust)

    # ------------------------------------------------------------- bake rig
    def clear():
        for c in (bpy.data.objects, bpy.data.meshes, bpy.data.materials,
                  bpy.data.images, bpy.data.textures):
            for x in list(c):
                try:
                    c.remove(x, do_unlink=True)
                except Exception:
                    pass

    def grid_mesh(name, h, extent, n):
        """A displaced grid, built straight out of numpy. from_pydata on 1.6M
           quads takes minutes; foreach_set takes a tenth of a second."""
        t = np.linspace(-extent * 0.5, extent * 0.5, n + 1, dtype=np.float32)
        X, Y = np.meshgrid(t, t, indexing='xy')
        co = np.stack([X, Y, h], -1).reshape(-1, 3).astype(np.float32)
        i = np.arange(n, dtype=np.int32)
        a = (i[:, None] * (n + 1) + i[None, :]).ravel()
        quads = np.stack([a, a + 1, a + n + 2, a + n + 1], -1).astype(np.int32)
        me = bpy.data.meshes.new(name)
        me.vertices.add(co.shape[0])
        me.vertices.foreach_set('co', co.ravel())
        nq = quads.shape[0]
        me.loops.add(nq * 4)
        me.loops.foreach_set('vertex_index', quads.ravel())
        me.polygons.add(nq)
        me.polygons.foreach_set('loop_start', (np.arange(nq, dtype=np.int32) * 4))
        try:
            me.polygons.foreach_set('loop_total', np.full(nq, 4, np.int32))
        except Exception:
            pass                       # 4.1+ derives it from loop_start
        me.update(calc_edges=True)
        me.validate()
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob

    def flat_plane(name, size):
        bm_co = np.array([[-size / 2, -size / 2, 0], [size / 2, -size / 2, 0],
                          [size / 2, size / 2, 0], [-size / 2, size / 2, 0]], np.float32)
        me = bpy.data.meshes.new(name)
        me.vertices.add(4)
        me.vertices.foreach_set('co', bm_co.ravel())
        me.loops.add(4)
        me.loops.foreach_set('vertex_index', np.array([0, 1, 2, 3], np.int32))
        me.polygons.add(1)
        me.polygons.foreach_set('loop_start', np.array([0], np.int32))
        me.update(calc_edges=True)
        uv = me.uv_layers.new(name='UVMap')
        uv.data.foreach_set('uv', np.array([0, 0, 1, 0, 1, 1, 0, 1], np.float32))
        me.validate()
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob

    def ao_material(dist):
        m = bpy.data.materials.new('aoM'); m.use_nodes = True
        nt = m.node_tree; nt.nodes.clear()
        ao = nt.nodes.new('ShaderNodeAmbientOcclusion')
        ao.samples = 32
        ao.only_local = True
        ao.inputs['Distance'].default_value = dist
        em = nt.nodes.new('ShaderNodeEmission')
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(ao.outputs['AO'], em.inputs['Color'])
        nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
        return m

    def bake_ao(h, ao_dist, samples=80):
        """Ray-traced occlusion of the centre tile, with a wrapped surround so
           the border sees the neighbours it will actually have."""
        clear()
        sc = bpy.context.scene
        sc.render.engine = 'CYCLES'
        try:
            cp = bpy.context.preferences.addons['cycles'].preferences
            cp.compute_device_type = 'METAL'
            cp.get_devices()
            for d in cp.devices:
                d.use = (d.type == 'METAL')
            sc.cycles.device = 'GPU'
        except Exception as e:
            print('  (cpu cycles:', e, ')')
        sc.cycles.samples = samples
        sc.cycles.use_denoising = False

        ext = TILE + 2 * MARGIN
        n = int(round(FIELD * ext / TILE))
        # wrapped resample of the height onto the extended grid
        idx = (np.arange(n + 1, dtype=np.float32) / n * ext - MARGIN) / TILE * FIELD
        ii = np.mod(np.round(idx).astype(np.int32), FIELD)
        hx = h[np.ix_(ii, ii)].astype(np.float32)

        hi = grid_mesh('hi', hx, ext, n)
        hi.data.materials.append(ao_material(ao_dist))
        lo = flat_plane('lo', TILE)
        lomat = bpy.data.materials.new('lomat'); lomat.use_nodes = True
        lo.data.materials.append(lomat)
        im = bpy.data.images.new('bk_ao', AO_RES, AO_RES, alpha=False, float_buffer=True)
        im.colorspace_settings.name = 'Non-Color'
        tn = lomat.node_tree.nodes.new('ShaderNodeTexImage')
        tn.image = im
        lomat.node_tree.nodes.active = tn

        bk = sc.render.bake
        bk.use_selected_to_active = True
        bk.cage_extrusion = 0.14
        bk.max_ray_distance = 0.30
        bk.margin = 0
        bk.use_clear = True

        bpy.ops.object.select_all(action='DESELECT')
        hi.select_set(True); lo.select_set(True)
        bpy.context.view_layer.objects.active = lo
        bpy.ops.object.bake(type='EMIT')

        a = np.empty(len(im.pixels), np.float32)
        im.pixels.foreach_get(a)
        return a.reshape(AO_RES, AO_RES, 4)[..., 0].copy()

    # ------------------------------------------------------------- compose
    def normal_from_height(h, texel, sigma, amp):
        """A filtered central difference. sigma keeps every slope at least a
           texel wide, which is what a mip chain then has something to average
           instead of alias -- an unfiltered one-texel cliff is the same
           unrepresentable frequency the procedural shader had."""
        hc = blur_wrap(h, sigma)
        dx = (np.roll(hc, -1, 1) - np.roll(hc, 1, 1)) / (2 * texel)
        dy = (np.roll(hc, -1, 0) - np.roll(hc, 1, 0)) / (2 * texel)
        nx = -dx * amp; ny = -dy * amp
        l = np.sqrt(nx * nx + ny * ny + 1.0)
        return (nx / l).astype(np.float32), (ny / l).astype(np.float32)

    CFG = {
        'rock':  dict(sigma=1.1, amp=0.62, aoDist=0.11, cav=14.0,
                      cavK=0.55, aoK=0.62, toneK=0.26, stainK=0.34, base=0.80,
                      minK=1.05),
        'sand':  dict(sigma=1.25, amp=1.60, aoDist=0.055, cav=9.0,
                      cavK=0.30, aoK=0.40, toneK=0.62, stainK=0.30, base=0.90,
                      minK=1.00),
        'scree': dict(sigma=1.0, amp=0.70, aoDist=0.085, cav=11.0,
                      cavK=0.60, aoK=0.70, toneK=0.58, stainK=0.34, base=0.82,
                      minK=1.30),
        'crust': dict(sigma=1.1, amp=0.85, aoDist=0.075, cav=10.0,
                      cavK=0.55, aoK=0.60, toneK=0.22, stainK=0.26, base=0.86,
                      minK=0.95),
    }

    def save_png(arr, path):
        """Blender's own PNG writer, because it is the one image encoder that is
           definitely present in a --factory-startup process."""
        h, w, nc = arr.shape
        nm = os.path.basename(path)
        old = bpy.data.images.get(nm)
        if old:
            bpy.data.images.remove(old)
        im = bpy.data.images.new(nm, w, h, alpha=(nc > 3), float_buffer=False)
        im.colorspace_settings.name = 'Non-Color'
        rgba = np.ones((h, w, 4), np.float32)
        rgba[..., :nc] = np.clip(arr, 0, 1)
        # Blender's pixel buffer is bottom-up; the game's sampler is not, and a
        # normal map flipped in v has its green channel pointing the wrong way.
        im.pixels.foreach_set(np.ascontiguousarray(rgba[::-1], np.float32).ravel())
        im.file_format = 'PNG'
        im.save(filepath=path)
        bpy.data.images.remove(im)

    for name in which:
        print('=== %s' % name)
        h, masks = FIELDS[name]()
        cfg = CFG[name]
        texel = TILE / FIELD

        ao_hi = bake_ao(h, cfg['aoDist'])
        ao = boxdown(np.clip(ao_hi, 0, 1), OUT)

        nx, ny = normal_from_height(h, texel, cfg['sigma'], cfg['amp'])
        nx = boxdown(nx, OUT); ny = boxdown(ny, OUT)
        l = np.sqrt(np.clip(1.0 - nx * nx - ny * ny, 1e-4, 1.0))
        nl = np.sqrt(nx * nx + ny * ny + l * l)
        nx, ny = nx / nl, ny / nl

        rng = max(np.percentile(h, 99.5) - np.percentile(h, 0.5), 1e-5)

        # Cavity: the high-frequency part of the occlusion. The ray trace runs
        # against a mesh at half the field's resolution and cannot resolve the
        # tightest creases; the height can, and the two multiply.
        cav = np.clip(0.5 + (h - blur_wrap(h, cfg['cav'])) / (rng * 1.6), 0, 1)
        cav = boxdown(cav, OUT)

        tone = boxdown(masks['tone'], OUT)
        grit = boxdown(masks['grit'], OUT)
        bare = boxdown(masks['bare'], OUT)

        # ---- albedo, as one channel. Near-neutral and carrying modulation
        # only: the palette lives in the uC* uniforms, where it is one place to
        # change instead of four texture files, and a texture with a hue of its
        # own would fight every world it is drawn on. Measured against
        # reference, the ground was running a saturation of 0.61 where a real
        # frame runs 0.25 -- a neutral map plus a desaturation in the shader is
        # the whole of that fix.
        #
        # Half of what is here has nothing to do with the relief, and that is
        # the point. A reviewer comparing this ground against a real frame put
        # it exactly: "zero albedo variation -- the colour is literally
        # constant, only the shading changes", which is what makes a surface
        # read as clay however much geometry is under it. `tone` is per block
        # and per clast, `stain` is a mineral wash that runs across the relief
        # rather than with it, and neither is visible in the normal at all.
        a = np.full((OUT, OUT), cfg['base'], np.float32)
        a *= 1.0 + (tone - 0.5) * cfg['toneK']
        a *= 1.0 + (grit - 0.5) * 0.22
        a *= 1.0 + (boxdown(pnoise(FIELD, 7, 31, 4), OUT) - 0.5) * cfg['stainK']
        a *= 1.0 + (boxdown(pnoise(FIELD, 23, 57, 3), OUT) - 0.5) * cfg['stainK'] * 0.6
        a *= 1.0 - (1.0 - ao) * cfg['aoK']
        a *= 1.0 - (1.0 - cav) * cfg['cavK']
        a *= 1.0 - bare * 0.10
        # Normalised so every set has the same mean, which is what lets the
        # shader treat the channel as a pure multiplier: 0.5 stored, doubled on
        # decode, so a map is a modulation about 1.0 and swapping one material
        # for another does not change the ground's exposure.
        a = np.clip(a * (0.5 / a.mean()), 0.02, 1.0)
        # gamma 2, so the shader decodes with one multiply rather than a pow and
        # the darks still get their bits
        lum = np.sqrt(a)

        # ---- the mineral index, and what has to be true of it.
        #
        # It is *not* a second copy of the albedo. The whole reason it exists is
        # that the luminance is dominated by occlusion and cavity -- by the
        # shading -- so a hue derived from it paints the creases a different
        # colour from the faces and calls that geology. What a mineral index is
        # is which stone this texel is made of, and every generator above
        # already knows: `tone` is per fracture block for rock, per clast for
        # scree, per plate for crust and per chip for sand, and none of them
        # touches the height field.
        #
        # Two stains on top of it at 29 cm and 9 cm, and they are the same two
        # fields that modulate the albedo -- deliberately, because a mineral
        # wash *does* darken the ground it stains, and the pair reading together
        # is what makes it a wash rather than two unrelated fields.
        m = 0.5 + (tone - 0.5) * cfg.get('minK', 1.0)
        m += (boxdown(pnoise(FIELD, 7, 31, 4), OUT) - 0.5) * 0.62
        m += (boxdown(pnoise(FIELD, 23, 57, 3), OUT) - 0.5) * 0.34
        m += (grit - 0.5) * 0.18
        # Standardised rather than merely scaled: what the shader wants is a
        # *rotation*, so the channel has to have a known spread as well as a
        # known mean, and the four sets have to agree about it or a world's
        # chroma changes when one material takes over from another.
        m = 0.5 + (m - m.mean()) * (0.235 / max(float(m.std()), 1e-4))
        m = np.clip(m, 0.0, 1.0)
        # Into the top half of the range. See the note at the top: the loader
        # decodes through a premultiplied canvas and a small alpha costs the
        # other three channels their low bits.
        alpha = 0.5 + m * 0.5

        pk = np.stack([lum, nx * 0.5 + 0.5, ny * 0.5 + 0.5, alpha], -1)
        save_png(np.clip(pk, 0, 1), os.path.join(tmp, 'terr_%s.png' % name))
        print('  relief %.1f mm p0.5-p99.5, ao mean %.3f, slope rms %.3f, '
              'tone sd %.3f, mineral sd %.3f'
              % (rng * 1000, float(ao.mean()),
                 float(np.sqrt((nx ** 2 + ny ** 2).mean())), float(a.std()),
                 float(m.std())))


if __name__ == '__main__':
    argv = sys.argv
    if '--' in argv and 'BAKE' in argv:
        args = argv[argv.index('--') + 1:]
        blender_main([a for a in args[1:]] or list(MATS))
    else:
        want = [a for a in argv[1:] if not a.startswith('-')] or list(MATS)
        bad = [w for w in want if w not in MATS]
        if bad:
            raise SystemExit('unknown material(s): %s' % bad)
        drive(want)
