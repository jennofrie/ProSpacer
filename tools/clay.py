#!/usr/bin/env python3
"""
Grey-clay turntable of one or more kit pieces, through the BlenderMCP socket.

    python3 tools/clay.py cp_controls               # one piece
    python3 tools/clay.py cp_controls cp_seat       # several, framed together
    python3 tools/clay.py --bevel 0 cp_pedestal     # without the chamfer pass

Writes /tmp/clay_<name>.png for each view and prints the paths.

Why this exists: textures, emissives and a good lighting rig hide box-stacking
completely. Flat grey under one hard key does not. Every asset gets looked at
here *before* it is baked, because baking a bad model only produces a well-lit
bad model. If a silhouette in these renders is a rectangle, or an edge reads as
infinitely sharp, it is not finished.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from bake_interior import part, send, OUTDIR, TMP     # noqa: E402

args = [a for a in sys.argv[1:] if not a.startswith('--')]
flags = {sys.argv[i]: sys.argv[i + 1] for i, a in enumerate(sys.argv)
         if a.startswith('--') and i + 1 < len(sys.argv)}
NAMES = args or ['cp_controls']
BEVEL = float(flags.get('--bevel', 1))
VIEWS = flags.get('--views', 'q3:38:26,front:0:8,side:88:14,top:24:66')

STUB = '''
wipe()
masters, occ = build_assembly()
BEV = %(bevel)f
if BEV > 0:
    for k in ('cp_controls', 'cp_seat', 'cp_pedestal', 'cp_coaming', 'cp_tub'):
        if k in masters:
            weld_bevel(masters[k], width=0.0025 * BEV, segments=2)
keep = [masters[n] for n in %(names)r if n in masters]
for ob in bpy.data.objects:
    if ob.type == 'MESH' and ob not in keep:
        bpy.data.objects.remove(ob, do_unlink=True)
views = [tuple((v.split(':')[0], float(v.split(':')[1]), float(v.split(':')[2])))
         for v in %(views)r.split(',')]
fo = %(focus)r
paths = clay_shots(keep, '/tmp/clay', views, size=1000, samples=44,
                   focus=[float(v) for v in fo.split(',')] if fo else None)
print(dict(faces={o.name: len(o.data.polygons) for o in keep}, paths=paths))
''' % dict(bevel=BEVEL, names=NAMES, views=VIEWS,
           focus=flags.get('--focus', ''))

code = part('00_lib.py', '40_kit.py', '41_kit_props.py', '42_cockpit.py',
            '50_assemble.py', '70_clay.py') + STUB
r = send('execute_code', {'code': code})
if r.get('status') != 'success':
    raise SystemExit('blender: ' + str(r))
print(r['result']['result'][-900:].strip())
