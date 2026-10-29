#!/usr/bin/env python3
"""Add live-photo.auto + full-frame-rate-playback-intent metadata keys to .mov
files so iOS treats them as auto-playing Live Photos (like camera-shot ones)."""

import sys
import threading
from pathlib import Path

import AVFoundation
from Foundation import NSNumber, NSURL

EXTRA = [
    ("com.apple.quicktime.live-photo.auto", NSNumber.numberWithUnsignedChar_(1)),
    ("com.apple.quicktime.full-frame-rate-playback-intent", NSNumber.numberWithInt_(1)),
]


def make_item(key, value):
    it = AVFoundation.AVMutableMetadataItem.metadataItem()
    it.setKeySpace_(AVFoundation.AVMetadataKeySpaceQuickTimeMetadata)
    it.setKey_(key)
    it.setValue_(value)
    return it


def process(path: Path):
    in_url = NSURL.fileURLWithPath_(str(path))
    tmp = path.with_suffix(".tmp.mov")
    out_url = NSURL.fileURLWithPath_(str(tmp))
    asset = AVFoundation.AVURLAsset.URLAssetWithURL_options_(in_url, None)

    items = [i.mutableCopy() for i in asset.metadata()]
    have = {str(i.key()) for i in items}
    for k, v in EXTRA:
        if k not in have:
            items.append(make_item(k, v))

    sess = AVFoundation.AVAssetExportSession.exportSessionWithAsset_presetName_(
        asset, AVFoundation.AVAssetExportPresetPassthrough)
    sess.setOutputURL_(out_url)
    sess.setOutputFileType_(AVFoundation.AVFileTypeQuickTimeMovie)
    sess.setMetadata_(items)

    done = threading.Event()
    sess.exportAsynchronouslyWithCompletionHandler_(done.set)
    done.wait(60)
    if sess.status() != AVFoundation.AVAssetExportSessionStatusCompleted:
        raise RuntimeError(f"export failed: {sess.error()}")
    tmp.replace(path)
    print(f"ok  {path.name}")


for p in sys.argv[1:]:
    process(Path(p))
