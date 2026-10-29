import AVFoundation
import CoreMedia

// usage: fix_livephoto <in.mov> <out.mov> [still_seconds]
let inURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outURL = URL(fileURLWithPath: CommandLine.arguments[2])
let stillSec = CommandLine.arguments.count > 3 ? Double(CommandLine.arguments[3])! : 1.5
try? FileManager.default.removeItem(at: outURL)

let asset = AVURLAsset(url: inURL)
guard let vtrack = asset.tracks(withMediaType: .video).first else {
    fatalError("no video track")
}

func qtItem(_ key: String, _ value: NSCopying & NSObjectProtocol, _ dt: String) -> AVMutableMetadataItem {
    let i = AVMutableMetadataItem()
    i.keySpace = .quickTimeMetadata
    i.key = key as NSString
    i.value = value
    i.dataType = dt
    return i
}

// file-level metadata: keep existing, add the live photo key set from a real capture
var metadata = asset.metadata.compactMap { $0.mutableCopy() as? AVMutableMetadataItem }
let existing = Set(metadata.compactMap { $0.key as? String })
let wanted: [(String, NSCopying & NSObjectProtocol, String)] = [
    ("com.apple.quicktime.live-photo.auto", NSNumber(value: UInt8(1)), kCMMetadataBaseDataType_UInt8 as String),
    ("com.apple.quicktime.live-photo.vitality-score", NSNumber(value: Float(1.0)), kCMMetadataBaseDataType_Float32 as String),
    ("com.apple.quicktime.live-photo.vitality-scoring-version", NSNumber(value: 4), kCMMetadataBaseDataType_SInt64 as String),
    ("com.apple.quicktime.full-frame-rate-playback-intent", NSNumber(value: 1), kCMMetadataBaseDataType_SInt64 as String),
]
for (k, v, dt) in wanted where !existing.contains(k) {
    metadata.append(qtItem(k, v, dt))
}

// timed metadata track format: still-image-time, SInt8 payload
let spec: [String: Any] = [
    kCMMetadataFormatDescriptionMetadataSpecificationKey_Identifier as String: "mdta/com.apple.quicktime.still-image-time",
    kCMMetadataFormatDescriptionMetadataSpecificationKey_DataType as String: kCMMetadataBaseDataType_SInt8 as String,
]
var metaDesc: CMFormatDescription?
let rc = CMMetadataFormatDescriptionCreateWithMetadataSpecifications(
    allocator: kCFAllocatorDefault, metadataType: kCMMetadataFormatType_Boxed,
    metadataSpecifications: [spec] as CFArray, formatDescriptionOut: &metaDesc)
guard rc == noErr, let metaDesc else { fatalError("metadata format desc failed: \(rc)") }

let reader = try AVAssetReader(asset: asset)
let rOut = AVAssetReaderTrackOutput(track: vtrack, outputSettings: nil)
reader.add(rOut)

let writer = try AVAssetWriter(outputURL: outURL, fileType: .mov)
let wIn = AVAssetWriterInput(mediaType: .video, outputSettings: nil,
                           sourceFormatHint: (vtrack.formatDescriptions.first as! CMFormatDescription))
wIn.transform = vtrack.preferredTransform
writer.add(wIn)

let metaIn = AVAssetWriterInput(mediaType: .metadata, outputSettings: nil, sourceFormatHint: metaDesc)
let adaptor = AVAssetWriterInputMetadataAdaptor(assetWriterInput: metaIn)
writer.add(metaIn)

writer.metadata = metadata

guard reader.startReading() else { fatalError("reader: \(reader.error?.localizedDescription ?? "")") }
guard writer.startWriting() else { fatalError("writer: \(writer.error?.localizedDescription ?? "")") }
writer.startSession(atSourceTime: .zero)

// still-image-time sample: payload -1, PTS marks the key frame
let si = AVMutableMetadataItem()
si.keySpace = .quickTimeMetadata
si.key = "com.apple.quicktime.still-image-time" as NSString
si.value = NSNumber(value: Int8(-1))
si.dataType = kCMMetadataBaseDataType_SInt8 as String
let stillTime = CMTime(seconds: stillSec, preferredTimescale: 600)
adaptor.append(AVTimedMetadataGroup(items: [si],
    timeRange: CMTimeRange(start: stillTime, duration: CMTime(seconds: 1.0, preferredTimescale: 600))))

while let buf = rOut.copyNextSampleBuffer() {
    while !wIn.isReadyForMoreMediaData { usleep(1000) }
    wIn.append(buf)
}
wIn.markAsFinished()
metaIn.markAsFinished()

let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
guard writer.status == .completed else {
    fatalError("export failed: \(writer.error?.localizedDescription ?? "unknown")")
}
print("ok \(outURL.lastPathComponent)")
