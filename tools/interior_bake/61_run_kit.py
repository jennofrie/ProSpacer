import time
T0=time.time()
wipe()
masters, occ = build_assembly()
unwrap_and_pack(masters, res=4096)
im = bake_kit_ao(masters, occ, res=4096, dist=0.50, samples=128)
a = img_np(im)[..., 0]
# Lift the floor: an occlusion map is a modulation, not a shadow. Anything that
# reaches zero here paints a black line the lighting can never recover.
lo = 0.34
a2 = np.clip(lo + (1.0-lo)*np.clip(a, 0, 1)**0.85, 0, 1)
m = (a > 0.001)          # leave the unpacked gutter at 1.0 so nothing bleeds dark
a2 = np.where(m, a2, 1.0)
im.pixels.foreach_set(np.ascontiguousarray(
    np.stack([a2, a2, a2, np.ones_like(a2)], -1), np.float32).ravel())
im.update()
print('ao raw', [round(float(np.percentile(a[m], p)),3) for p in (1,10,50,90)])
st = bpy.context.scene.render.image_settings
st.file_format='PNG'; st.color_mode='RGB'; st.color_depth='8'
im.file_format='PNG'; im.save(filepath=SP + '/tx_kit_ao.png')
# ...and the file the game actually loads. This step was missing: the bake
# wrote a PNG into BAKE_TMP and stopped, so `models/kit_ao.webp` was whatever
# a previous hand-run had left there and every rebake since silently shipped a
# stale occlusion atlas against fresh geometry.
_wp = os.path.join(OUT, 'kit_ao.webp')
st.file_format='WEBP'; st.quality=90
im.file_format='WEBP'; im.save(filepath=_wp)
print('ao webp', os.path.getsize(_wp))
# ---- move the masters back to canonical origin and export
for ob in bpy.data.objects:
    if ob not in masters.values():
        bpy.data.objects.remove(ob, do_unlink=True)
for k, ob in masters.items():
    ob.location = (0,0,0); ob.rotation_euler = (0,0,0); ob.scale=(1,1,1)
    ob.name = k
    select_only([ob], ob)
    bpy.ops.object.shade_auto_smooth(angle=math.radians(37))
select_only(list(masters.values()), list(masters.values())[0])
path = os.path.join(OUT, 'interior_kit.glb')
# Draco. The kit is pure geometry -- no images ride in the GLB at all -- and
# uncompressed float32 position/normal/uv is most of a 16 MB first load on a
# browser game. Quantisation is the whole tuning: 14 bits of position over a
# 16 m cabin is 1 mm, which is a tenth of the smallest chamfer in the kit, and
# 10 bits of normal is well inside what shade_auto_smooth is doing anyway.
# The decoder is served from public/draco/ and bound in interiorAssets.js.
bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
                          export_apply=True, export_yup=False, export_texcoords=True,
                          export_normals=True, export_materials='EXPORT',
                          export_image_format='NONE', export_tangents=False,
                          export_extras=False, export_cameras=False, export_lights=False,
                          export_draco_mesh_compression_enable=True,
                          export_draco_mesh_compression_level=6,
                          export_draco_position_quantization=14,
                          export_draco_normal_quantization=10,
                          export_draco_texcoord_quantization=12)
print(dict(glb=os.path.getsize(path), t=round(time.time()-T0,1),
           names=sorted(masters.keys())))
