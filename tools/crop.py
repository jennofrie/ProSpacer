#!/usr/bin/env python3
"""1:1 crops and quick statistics on a shot. Scratch tool for the landed work.

  python3 tools/crop.py in.png out.png X Y W H [--scale N]
  python3 tools/crop.py --stats in.png [X Y W H]
  python3 tools/crop.py --row in.png Y            # one scanline, as a profile
"""
import sys
import numpy as np
from PIL import Image


def stats(path, box=None):
    im = Image.open(path).convert('RGB')
    a = np.asarray(im).astype(np.float64)
    if box:
        x, y, w, h = box
        a = a[y:y + h, x:x + w]
    lum = a @ [0.2126, 0.7152, 0.0722]
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    print(f'{path}  {a.shape[1]}x{a.shape[0]}')
    print(f'  mean {lum.mean():7.2f}  median {np.median(lum):7.2f}  std {lum.std():6.2f}')
    print(f'  p01 {np.percentile(lum,1):6.1f}  p50 {np.percentile(lum,50):6.1f} '
          f' p99 {np.percentile(lum,99):6.1f}  max {lum.max():6.1f}')
    print(f'  clip>250 {100*(mx>250).mean():6.3f}%   black<8 {100*(mx<8).mean():6.3f}%')
    print(f'  sat mean {sat.mean():.3f}  std {sat.std():.3f}')
    print(f'  per-channel std  R{a[...,0].std():6.2f} G{a[...,1].std():6.2f} B{a[...,2].std():6.2f}')
    # local (high-frequency) contrast: std of a 3x3 laplacian-ish residual
    k = lum[1:-1, 1:-1]
    blur = (lum[:-2, 1:-1] + lum[2:, 1:-1] + lum[1:-1, :-2] + lum[1:-1, 2:]) * 0.25
    print(f'  local detail (|hf|) mean {np.abs(k-blur).mean():.3f}')


def crop(src, dst, x, y, w, h, scale=1):
    im = Image.open(src).convert('RGB').crop((x, y, x + w, y + h))
    if scale != 1:
        im = im.resize((w * scale, h * scale), Image.NEAREST)
    im.save(dst)
    print(dst, im.size)


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[0] == '--stats':
        box = tuple(int(v) for v in a[2:6]) if len(a) > 2 else None
        stats(a[1], box)
    elif a[0] == '--row':
        im = np.asarray(Image.open(a[1]).convert('RGB')).astype(int)
        y = int(a[2])
        row = im[y]
        step = max(1, row.shape[0] // 60)
        print(' '.join(f'{row[i,0]},{row[i,1]},{row[i,2]}' for i in range(0, row.shape[0], step)))
    else:
        sc = 1
        if '--scale' in a:
            i = a.index('--scale'); sc = int(a[i + 1]); a = a[:i]
        crop(a[0], a[1], int(a[2]), int(a[3]), int(a[4]), int(a[5]), sc)
