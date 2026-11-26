// Decode the strips render.mjs wrote with Apple Vision (VNDetectBarcodesRequest,
// the detector behind the iOS camera's QR scanning) after phone-photo-like
// degradations, and print the pass rate per variant.
//
//   swiftc -O tools/qr-size/decode.swift -o tools/qr-size/out/decode && tools/qr-size/out/decode tools/qr-size/out
//
// Each strip is decoded as
//   source:  bits  = the exact 1-bit bitmap the booth prints
//            print = a simulated thermal print (dot gain, smear, head heat)
//   blur σ (in printer dots, before scaling) × scale (1 = one pixel per dot)
//   + "faded": ink at 35 % grey, paper at 88 % (old / cheap thermal paper)
//   + "tilted": 8° rotation + mild perspective (paper not square to the phone)
import Foundation
import CoreImage
import Vision
import ImageIO

struct Entry: Decodable { let name, variant, theme, url: String; let qrSide: Int }
let dir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "tools/qr-size/out")
let manifest = try JSONDecoder().decode([Entry].self, from: Data(contentsOf: dir.appendingPathComponent("manifest.json")))
let ctx = CIContext(options: [.workingColorSpace: NSNull()])

struct Cond: Hashable { let src: String; let blur: Double; let scale: Double; let extra: String
  var label: String { "\(src) σ\(blur) ×\(scale)\(extra.isEmpty ? "" : " " + extra)" } }
var conds: [Cond] = []
for src in ["bits", "print"] {
  for blur in [0.0, 1.0, 1.5] { for scale in [1.0, 0.75, 0.5, 0.4, 0.33] { conds.append(Cond(src: src, blur: blur, scale: scale, extra: "")) } }
  conds.append(Cond(src: src, blur: 1.0, scale: 0.5, extra: "faded"))
  conds.append(Cond(src: src, blur: 1.0, scale: 0.5, extra: "tilted"))
  conds.append(Cond(src: src, blur: 1.0, scale: 0.5, extra: "faded+tilted"))
}

func degrade(_ img: CIImage, _ c: Cond) -> CIImage {
  var im = img.clampedToExtent()
  if c.blur > 0 { im = im.applyingGaussianBlur(sigma: c.blur) }
  im = im.cropped(to: img.extent)
  if c.extra.contains("faded") {   // v' = 0.35·(1-v)… : ink 0.35 → paper 0.88
    im = im.applyingFilter("CIColorMatrix", parameters: [
      "inputRVector": CIVector(x: 0.53, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: 0.53, z: 0, w: 0),
      "inputBVector": CIVector(x: 0, y: 0, z: 0.53, w: 0), "inputBiasVector": CIVector(x: 0.35, y: 0.35, z: 0.35, w: 0)])
  }
  if c.scale != 1 { im = im.applyingFilter("CILanczosScaleTransform", parameters: [kCIInputScaleKey: c.scale, kCIInputAspectRatioKey: 1.0]) }
  if c.extra.contains("tilted") {
    let e = im.extent
    im = im.transformed(by: CGAffineTransform(rotationAngle: 8 * .pi / 180))
    let r = im.extent
    im = im.applyingFilter("CIPerspectiveTransform", parameters: [
      "inputTopLeft": CIVector(x: r.minX + e.width * 0.04, y: r.maxY), "inputTopRight": CIVector(x: r.maxX - e.width * 0.04, y: r.maxY),
      "inputBottomLeft": CIVector(x: r.minX, y: r.minY), "inputBottomRight": CIVector(x: r.maxX, y: r.minY)])
    im = im.composited(over: CIImage(color: .white).cropped(to: im.extent))
  }
  return im
}

func decode(_ im: CIImage) -> [String] {
  guard let cg = ctx.createCGImage(im, from: im.extent.integral) else { return [] }
  let req = VNDetectBarcodesRequest(); req.symbologies = [.qr]
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  return (req.results ?? []).compactMap { $0.payloadStringValue }
}

var pass: [String: [Cond: Int]] = [:], total: [String: Int] = [:], fails: [String: [String]] = [:]
let variants = manifest.reduce(into: [String]()) { if !$0.contains($1.variant) { $0.append($1.variant) } }
for e in manifest {
  total[e.variant, default: 0] += 1
  for src in ["bits", "print"] {
    let url = dir.appendingPathComponent("\(e.name).\(src).png")
    guard let base = CIImage(contentsOf: url) else { fatalError("can't read \(url.path)") }
    for c in conds where c.src == src {
      let ok = decode(degrade(base, c)).contains(e.url)
      if ok { pass[e.variant, default: [:]][c, default: 0] += 1 }
      else { fails[e.variant, default: []].append("\(e.name) \(c.label)") }
    }
  }
}
let mm = Dictionary(manifest.map { ($0.variant, $0.qrSide) }, uniquingKeysWith: { a, _ in a })
print("cond".padding(toLength: 28, withPad: " ", startingAt: 0) + variants.map { $0.padding(toLength: 9, withPad: " ", startingAt: 0) }.joined())
print("QR side (mm)".padding(toLength: 28, withPad: " ", startingAt: 0) + variants.map { String(format: "%-9.1f", Double(mm[$0]!) * 25.4 / 203) }.joined())
for c in conds {
  var line = c.label.padding(toLength: 28, withPad: " ", startingAt: 0)
  for v in variants { line += "\(pass[v]?[c] ?? 0)/\(total[v]!)".padding(toLength: 9, withPad: " ", startingAt: 0) }
  print(line)
}
if CommandLine.arguments.contains("-v") { for v in variants { for f in fails[v] ?? [] { print("FAIL", f) } } }
