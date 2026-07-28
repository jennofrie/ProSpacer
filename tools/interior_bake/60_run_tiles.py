import time
SP = os.environ.get("BAKE_TMP", "/tmp")
T0 = time.time(); log = {}
st = bpy.context.scene.render.image_settings

def emit(tag, alb, orm, nmap, res, q=(74, 76, 90)):
    a = np_img(rgba(alb), tag+'_albedo', srgb=True)
    o = np_img(rgba(orm), tag+'_orm', srgb=False)
    n = np_img(rgba(nmap), tag+'_normal', srgb=False)
    st.file_format='PNG'; st.color_mode='RGB'; st.color_depth='8'
    out = []
    for im in (a, o, n):
        p = SP+'/tx_'+im.name+'.png'
        im.file_format = 'PNG'
        im.save(filepath=p)
        out.append(p)
    return out

# ---------------------------------------------------------------- panel, 2.0 m
wipe()
hi = build_panel_hi()
apply_bevel(hi, width=0.0055, segments=2)
maps, lo = bake_maps(hi, PANEL_TILE, 2048, ao_dist=0.16, tag='panel',
                     extrusion=0.05, ray=0.12, samples=48)
log['panel'] = emit('panel', *compose_tile(maps, 'panel', PANEL_TILE, 2048, PANEL_PLATES, dict(
    seed=3, warmCool=0.13, grime=0.9, mark=1.0, wear=0.85, cavDark=0.80,
    aoPow=1.1, nrmAmp=1.0, nrmBlur=1.6, clampH=0.010, promScale=0.007, dirtBlur=16.0,
    roughLo=0.58, roughHi=0.99, bare=0.6, edgeTint=[0.72,0.74,0.77])), 2048)

# ----------------------------------------------------------------- deck, 1.5 m
wipe()
hid = build_deck_hi()
maps, lo = bake_maps(hid, DECK_TILE, 1024, ao_dist=0.09, tag='deck',
                     extrusion=0.04, ray=0.10, samples=48)
log['deck'] = emit('deck', *compose_tile(maps, 'deck', DECK_TILE, 1024, DECK_PLATES, dict(
    seed=11, warmCool=0.08, grime=1.0, mark=0.55, wear=1.0, cavDark=0.72,
    aoPow=1.0, nrmAmp=1.0, nrmBlur=1.1, clampH=0.006, promScale=0.0035, dirtBlur=10.0,
    roughLo=0.52, roughHi=0.97, bare=0.6, edgeTint=[0.66,0.66,0.66])), 1024)
print(dict(log=log, total=round(time.time()-T0,1)))
