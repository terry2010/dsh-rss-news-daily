#!/usr/bin/env python3
"""Convert JPG+MP4 pairs downloaded from Xiaohongshu into iOS Live Photo pairs.

Each output pair shares one basename (xxx.jpg + xxx.mov) and a matching
ContentIdentifier UUID, so Photos / AirDrop recognizes them as Live Photos.

Usage: .venv/bin/python make_live_photos.py [src_dir] [out_dir]
"""

import shutil
import subprocess
import sys
from pathlib import Path

from makelive import is_live_photo_pair, make_live_photo

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "xhs_live_6ab69042")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else SRC / "livephotos")
OUT.mkdir(parents=True, exist_ok=True)

pairs = sorted(
    (mp4.with_suffix(".jpg"), mp4) for mp4 in SRC.glob("*.mp4")
)

for jpg, mp4 in pairs:
    if not jpg.exists():
        print(f"skip {mp4.name}: no matching jpg")
        continue
    out_jpg = OUT / jpg.name
    out_mov = OUT / (mp4.stem + ".mov")
    shutil.copy2(jpg, out_jpg)
    # mp4 -> QuickTime .mov container (stream copy, no re-encode)
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(mp4), "-c", "copy",
         "-movflags", "+faststart", str(out_mov)],
        check=True,
    )
    asset_id = make_live_photo(out_jpg, out_mov)
    ok = is_live_photo_pair(out_jpg, out_mov)
    print(f"{out_jpg.name} + {out_mov.name}  uuid={asset_id}  pair_ok={ok}")

print(f"\nDone -> {OUT}")
