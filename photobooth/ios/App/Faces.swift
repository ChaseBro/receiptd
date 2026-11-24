// On-device face boxes (Vision), standing in for the web booth's BlazeFace:
// counts set the default copies (one per face) and boxes meter the tone map.

import Vision
import BoothCore

/// Per frame: face boxes in that frame's pixels (top-left origin).
func detectFaces(_ frames: [CGImage]) async -> [[Box]] {
    await withTaskGroup(of: (Int, [Box]).self) { g in
        for (i, f) in frames.enumerated() {
            g.addTask {
                let req = VNDetectFaceRectanglesRequest()
                try? VNImageRequestHandler(cgImage: f, options: [:]).perform([req])
                let w = Double(f.width), h = Double(f.height)
                let boxes = (req.results ?? []).filter { $0.confidence >= 0.6 }.map { o -> Box in
                    let r = o.boundingBox   // normalized, bottom-left origin
                    return Box(x: r.minX * w, y: (1 - r.maxY) * h, w: r.width * w, h: r.height * h)
                }
                return (i, boxes)
            }
        }
        var out = [[Box]](repeating: [], count: frames.count)
        for await (i, b) in g { out[i] = b }
        return out
    }
}

/// Face boxes after a ↻ fix of `deg` clockwise on a w×h frame.
func rotateBoxes(_ boxes: [Box], _ w: Double, _ h: Double, _ deg: Int) -> [Box] {
    switch ((deg % 360) + 360) % 360 {
    case 90: return boxes.map { Box(x: h - $0.y - $0.h, y: $0.x, w: $0.h, h: $0.w) }
    case 180: return boxes.map { Box(x: w - $0.x - $0.w, y: h - $0.y - $0.h, w: $0.w, h: $0.h) }
    case 270: return boxes.map { Box(x: $0.y, y: w - $0.x - $0.w, w: $0.h, h: $0.w) }
    default: return boxes
    }
}
