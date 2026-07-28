#!/usr/bin/env python3
"""
Rebuild every baked asset the ship interior uses, through the BlenderMCP socket.

    open Blender, sidebar (N) -> BlenderMCP -> Connect to Claude, then:

        python3 tools/bake_interior.py            # everything
        python3 tools/bake_interior.py tiles      # just the tiling maps
        python3 tools/bake_interior.py kit        # just the kit meshes + AO
        python3 tools/bake_interior.py soft       # the woven liner (no Blender)

Writes into public/models/:

    panel_*.webp   2.0 m tile of hull plating   (albedo / normal / ORM)
    deck_*.webp    1.5 m tile of deck plate
    soft_*.webp    0.35 m tile of woven liner
    kit_ao.webp    2048 atlas of ray-traced occlusion for the kit meshes
    interior_kit.glb

Why any of this exists: the cabin used to be surfaced by a procedural model
evaluated per fragment, and it aliased at full strength, because MSAA resolves
triangle coverage rather than shading and a procedural field has no mip chain
to prefilter it. See the header of src/ship/interiorMaterials.js.

Three things about the pipeline are worth knowing before changing it.

  * The tiling normal maps are derived from a *height field* baked by ray
    tracing — an emission shader whose colour is the shading point's world Z —
    and not from Blender's tangent-space NORMAL bake. A flat cage casts its
    rays straight down, and a vertical panel-gap wall has no cross-section for
    a downward ray, so a normal bake off a plane records nothing at all for it:
    the first attempt came back with rivets (which are tapered) and no seams,
    no welds, no louvres and no hatch. Height plus a controlled prefilter gives
    both the seams and a slope at least a texel wide, which is what a mip chain
    can then average instead of alias.

  * The hi-poly tile is emitted as a 3x3 array and only the centre tile is
    baked, so occlusion at the tile border sees its neighbours and the result
    is seamless with no cross-fade anywhere.

  * The occlusion bake samples the hemisphere *along the normal*, so the kit's
    hull skin has to be wound facing into the room. Wound the other way it
    bakes as a surface facing open space — unoccluded everywhere, which is the
    exact opposite of the point.

Blender is driven in the *game's* axes — X right, Y up, Z aft — and the glTF is
written with export_yup=False, so the numbers in tools/interior_bake and the
numbers in src/ship/Interior.js are the same numbers.
"""
import json
import os
import socket
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, 'interior_bake')
OUTDIR = os.path.join(ROOT, 'public', 'models')
TMP = os.environ.get('BAKE_TMP', '/tmp')


def send(cmd, params=None, timeout=1800.0):
    s = socket.socket()
    s.settimeout(timeout)
    s.connect(('localhost', 9876))
    s.sendall(json.dumps({'type': cmd, 'params': params or {}}).encode())
    buf = b''
    while True:
        chunk = s.recv(1 << 20)
        if not chunk:
            break
        buf += chunk
        try:
            return json.loads(buf.decode())
        except json.JSONDecodeError:
            continue
    return json.loads(buf.decode())


def part(*names):
    """Concatenate Blender-side modules into one script. The socket execs each
       call in a fresh namespace, so nothing persists between calls and the
       whole dependency chain has to be sent every time."""
    head = ('RES = 2048\nimport os\n'
            'os.environ.setdefault("BAKE_OUT", %r)\n'
            'os.environ.setdefault("BAKE_TMP", %r)\n' % (OUTDIR, TMP))
    return head + ''.join(open(os.path.join(SRC, n)).read() for n in names)


def run(code):
    r = send('execute_code', {'code': code})
    if r.get('status') != 'success':
        raise SystemExit('blender: ' + str(r))
    print(r['result']['result'][-600:].strip())


def encode(specs):
    """Blender's WebP writer silently ignores the quality argument and always
       writes lossless, so the maps come out of Blender as PNG and are encoded
       here. The whole set is about a megabyte."""
    from PIL import Image
    for name, q in specs:
        im = Image.open(os.path.join(TMP, 'tx_%s.png' % name)).convert('RGB')
        dst = os.path.join(OUTDIR, name + '.webp')
        im.save(dst, 'WEBP', quality=q, method=6)
        print('%-16s %5d  %6.0f KB' % (name, im.size[0], os.path.getsize(dst) / 1024))


def do_tiles():
    run(part('00_lib.py', '10_tile_geo.py', '20_tile_bake.py',
             '30_compose.py', '60_run_tiles.py'))
    encode([('panel_albedo', 92), ('panel_orm', 92), ('panel_normal', 95),
            ('deck_albedo', 92), ('deck_orm', 92), ('deck_normal', 95)])


def do_kit():
    run(part('00_lib.py', '40_kit.py', '41_kit_props.py', '42_cockpit.py',
             '50_assemble.py', '61_run_kit.py'))
    encode([('kit_ao', 88)])


def do_soft():
    """The woven liner and upholstery. Pure numpy: a plain weave is exactly
       periodic by construction, so there is nothing for a ray tracer to
       contribute and a 512 tile generated here is both seamless and instant."""
    import numpy as np
    from PIL import Image
    RES, TILE = 512, 0.35

    def pnoise(res, freq, seed=0, octaves=4):
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
            tot += amp; amp *= 0.5; f *= 2
        return out / tot

    u = (np.arange(RES, dtype=np.float32) + 0.5) / RES
    U, V = np.meshgrid(u, u)
    N, TAU = 26.0, 2 * np.pi
    # Warp and weft alternate over and under along the diagonal. A perfect
    # square lattice is the one thing that never reads as cloth — it reads as
    # wire mesh, which is what the first pass at the pilot's seat became.
    k = 0.5 + 0.5 * np.sin(np.pi * (U * N + V * N))
    h = (k * np.cos(TAU * U * N) + (1 - k) * np.cos(TAU * V * N * 0.86)) * 0.5
    seam = np.minimum(np.abs(((U * 4) % 1.0) - 0.5), np.abs(((V * 4) % 1.0) - 0.5))
    h -= np.exp(-(seam * 22.0) ** 2) * 1.5
    h += (pnoise(RES, 5, 7, 3) - 0.5) * 0.35

    TEX = TILE / RES
    hs = h * 0.0016                                   # thread relief, metres
    dx = (np.roll(hs, -1, 1) - np.roll(hs, 1, 1)) / (2 * TEX)
    dy = (np.roll(hs, -1, 0) - np.roll(hs, 1, 0)) / (2 * TEX)
    nx, ny = -dx, -dy
    l = np.sqrt(nx * nx + ny * ny + 1)
    nrm = np.stack([nx / l, ny / l, 1 / l], -1) * 0.5 + 0.5

    hn = (h - h.min()) / (np.ptp(h) + 1e-6)
    ao = np.clip(0.42 + 0.58 * hn ** 0.8, 0, 1)
    grain = pnoise(RES, 17, 3, 3)
    alb = np.clip((0.80 + 0.20 * hn)[..., None] * (0.90 + 0.20 * grain)[..., None]
                  * np.array([1.0, 0.985, 0.965], np.float32), 0, 1)
    alb *= (0.55 + 0.45 * ao)[..., None]
    rough = np.clip(0.86 + 0.14 * (1 - hn) - 0.05 * grain, 0, 1)
    orm = np.stack([ao, rough, np.zeros_like(ao)], -1)

    for a, name, q in ((alb, 'soft_albedo', 92), (orm, 'soft_orm', 92),
                       (nrm, 'soft_normal', 95)):
        p = os.path.join(OUTDIR, name + '.webp')
        Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype('uint8')).save(
            p, 'WEBP', quality=q, method=6)
        print('%-16s %5d  %6.0f KB' % (name, RES, os.path.getsize(p) / 1024))


if __name__ == '__main__':
    what = sys.argv[1] if len(sys.argv) > 1 else 'all'
    os.makedirs(OUTDIR, exist_ok=True)
    if what in ('all', 'soft'):
        do_soft()
    if what in ('all', 'tiles'):
        do_tiles()
    if what in ('all', 'kit'):
        do_kit()
