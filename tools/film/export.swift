import Foundation
import RollsFilm

// Exports what Inspicio's Film tool needs from the rolls engine, plus reference renders
// to check a JavaScript port against. Usage: export <outdir>

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func writeFloats(_ a: [Float], _ name: String) throws {
    let data = a.withUnsafeBufferPointer { Data(buffer: $0) }
    try data.write(to: out.appendingPathComponent(name))
}

let film = try FilmData.load(named: "portra400")
let paper = try FilmData.load(named: "endura-premier")
let ch = film[curve: "characteristic"]!
let mtf = film[curve: "mtf"]!
let ss = film[curve: "spectral_sensitivity"]!
let fm = ColorTransform.filmMatrix(spectralSensitivity: ss)

func layers(_ p: ColorTransform.DisplayPrimaries) -> [Double] {
    (fm.matrix * ColorTransform.displayToXYZ(p)).normalized(mapping: (1, 1, 1), to: (1, 1, 1)).m
}

func row(_ c: FilmCurve, _ name: String) -> [Float] { c.samples[c.channelIndex(name)!] }

// MTF response per channel, sampled in cycles/mm, tail slope already applied.
var mtfOut: [String: Any] = ["step": 0.25, "max": 400.0]
for name in ["R", "G", "B"] {
    let i = mtf.channelIndex(name)!
    let slope = MTF.tailSlope(mtf, channel: i)
    mtfOut[name] = stride(from: 0.0, through: 400.0, by: 0.25).map {
        MTF.response(mtf, channel: i, cyclesPerMm: $0, slope: slope)
    }
}

let profile = FilmProfile()
let noritsu = PrintProfile.noritsu
let printer = try Printer(paper: paper, profile: noritsu)
let pcurve = paper[curve: "characteristic"]!

var pipelineProfile = FilmProfile()
pipelineProfile.ratingStops = 1.0
let pipeline = try FilmPipeline(film: film, cameraToXYZ: ColorTransform.displayToXYZ(.sRGB),
                                profile: pipelineProfile)
let ref = pipeline.referenceDensities

// ---- Print colour table: print densities (after the paper curve) -> encoded sRGB. ----
// Built by running the real printer with highlight protection off and K = 0, feeding it
// negative densities that land each channel exactly on the wanted print density.
var flatPrint = noritsu
flatPrint.highlightProtection = 0
let lutPrinter = try Printer(paper: paper, profile: flatPrint)
let N = 48
let prow = ["R", "G", "B"].map { row(pcurve, $0) }
let dLo = prow.map { $0.min()! + 0.0005 }
let dHi = prow.map { $0.max()! - 0.0005 }
func inverse(_ c: Int, _ d: Float) -> Float {
    // paper curve: logH -> density, increasing. Find logH by bisection.
    var lo = pcurve.xMin, hi = pcurve.xMax
    for _ in 0..<60 {
        let mid = (lo + hi) / 2
        if pcurve.value(pcurve.channelIndex(["R", "G", "B"][c])!, at: mid) < d { lo = mid } else { hi = mid }
    }
    return (lo + hi) / 2
}
let count = N * N * N
var lattice = [Float](repeating: 0, count: count * 3)
for b in 0..<N { for g in 0..<N { for r in 0..<N {
    let i = ((b * N + g) * N + r) * 3
    for (c, idx) in [r, g, b].enumerated() {
        let d = dLo[c] + (dHi[c] - dLo[c]) * Float(idx) / Float(N - 1)
        lattice[i + c] = -inverse(c, d)   // K = 0, so log H = -D
    }
}}}
let shellPipeline = try FilmPipeline(film: film, cameraToXYZ: ColorTransform.displayToXYZ(.sRGB), profile: .flat)
var shell = shellPipeline.develop(linear: [Float](repeating: 0.18, count: count * 3), width: count, height: 1)
shell.density = lattice
let lut = lutPrinter.print(shell, exposures: [0, 0, 0], encodeForDisplay: true)
var lut16 = [UInt16](repeating: 0, count: lut.count)
for i in 0..<lut.count { lut16[i] = UInt16(max(0, min(1, lut[i])) * 65535 + 0.5) }
try lut16.withUnsafeBufferPointer { Data(buffer: $0) }.write(to: out.appendingPathComponent("print-lut.u16"))

let json: [String: Any] = [
    "stock": film.stock, "paper": "Kodak Endura Premier", "print": noritsu.name,
    "logHReference": FilmPipeline.logHReference, "middleGrey": 0.18, "ratingStops": 1.0,
    "frameWidthMm": profile.frameWidthMillimetres,
    "layers": ["sRGB": layers(.sRGB), "displayP3": layers(.displayP3)],
    "filmMatrix": fm.matrix.m,
    "characteristic": ["xMin": ch.xMin, "xMax": ch.xMax,
                       "R": row(ch, "R"), "G": row(ch, "G"), "B": row(ch, "B")],
    "reference": [ref.r, ref.g, ref.b],
    "mtf": mtfOut,
    "halation": ["strength": profile.halation.strength,
                 "baseThickness": profile.halation.baseThicknessMicrometres,
                 "refractiveIndex": profile.halation.refractiveIndex],
    "grain": ["amplitude": profile.grain.amplitude, "size": profile.grain.sizeMicrometres,
              "exponent": profile.grain.densityExponent, "roughness": profile.grain.roughness],
    "couplers": ["self": profile.couplers.selfInhibition, "cross": profile.couplers.crossInhibition,
                 "radius": profile.couplers.radiusMicrometres, "saturation": profile.couplers.saturation],
    "paperCurve": ["xMin": pcurve.xMin, "xMax": pcurve.xMax,
              "R": prow[0], "G": prow[1], "B": prow[2],
              "midtoneLogH": printer.midtoneLogH],
    "printProfile": ["mix": 0.88, "percentile": 0.48, "exposureStops": noritsu.exposureStops,
                     "highlightProtection": noritsu.highlightProtection],
    "lut": ["size": N, "dLo": dLo, "dHi": dHi],
]
func checkNaN(_ v: Any, _ path: String) {
    if let d = v as? [String: Any] { for (k, x) in d { checkNaN(x, path + "." + k) } }
    else if let a = v as? [Double] { if let i = a.firstIndex(where: { !$0.isFinite }) { print("bad", path, i, a[i]) } }
    else if let a = v as? [Float] { if let i = a.firstIndex(where: { !$0.isFinite }) { print("bad", path, i, a[i]) } }
    else if let x = v as? Double, !x.isFinite { print("bad", path, x) }
    else if let x = v as? Float, !x.isFinite { print("bad", path, x) }
}
checkNaN(json, "")
try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
    .write(to: out.appendingPathComponent("film.json"))

// ---- Reference renders on a synthetic scene ----
let W = 384, H = 256
var scene = [Float](repeating: 0, count: W * H * 3)
func put(_ x: Int, _ y: Int, _ r: Float, _ g: Float, _ b: Float) {
    let i = (y * W + x) * 3; scene[i] = r; scene[i + 1] = g; scene[i + 2] = b
}
for y in 0..<H { for x in 0..<W {
    if y < 128 {
        let v = 0.18 * powf(2, -8 + 12 * Float(x) / Float(W - 1))
        put(x, y, v, v, v)
    } else if x < 256 {
        let patches: [(Float, Float, Float)] = [(0.40, 0.05, 0.04), (0.06, 0.30, 0.06), (0.04, 0.06, 0.40),
                                                (0.45, 0.28, 0.20), (0.15, 0.25, 0.45), (0.08, 0.12, 0.03)]
        let p = patches[min(5, x / 43)]
        let k: Float = y < 192 ? 1 : 0.25
        put(x, y, p.0 * k, p.1 * k, p.2 * k)
    } else {
        let bright = (x >= 316 && x < 324 && y >= 188 && y < 196)
        let v: Float = bright ? 60 : 0.01
        put(x, y, v, v, v)
    }
}}
try writeFloats(scene, "ref-scene.f32")

func render(_ p: FilmProfile, _ tag: String) throws {
    let pl = try FilmPipeline(film: film, cameraToXYZ: ColorTransform.displayToXYZ(.sRGB), profile: p)
    let neg = pl.develop(linear: scene, width: W, height: H, components: 3,
                         baselineExposure: 0, settings: .init(useBaselineExposure: false))
    try writeFloats(neg.density, "ref-\(tag)-neg.f32")
    let k = printer.exposures(for: neg, filmNeutral: pl.referenceDensities)
    let img = printer.print(neg, exposures: k, encodeForDisplay: true)
    try writeFloats(img, "ref-\(tag)-out.f32")
    try JSONSerialization.data(withJSONObject: ["K": k]).write(to: out.appendingPathComponent("ref-\(tag)-k.json"))
}
var full = FilmProfile(); full.ratingStops = 1.0
try render(full, "full")
try render(full.withoutSpatialEffects, "flat")
print("ok")

// A wide frame (4400 px across 36 mm), so MTF and multi-pixel grain cells are exercised.
do {
    let WW = 4400, HH = 160
    var wide = [Float](repeating: 0, count: WW * HH * 3)
    for y in 0..<HH { for x in 0..<WW {
        let i = (y * WW + x) * 3
        let stripes: Float = ((x / 3) % 2 == 0) ? 0.5 : 0.04      // fine bars for MTF
        let v: Float = y < 80 ? stripes : 0.18 * powf(2, -6 + 10 * Float(x) / Float(WW - 1))
        wide[i] = v; wide[i + 1] = v * (y < 80 ? 1 : 0.8); wide[i + 2] = v * (y < 80 ? 1 : 0.6)
    }}
    try writeFloats(wide, "ref-wide-scene.f32")
    let pl = try FilmPipeline(film: film, cameraToXYZ: ColorTransform.displayToXYZ(.sRGB), profile: full)
    let neg = pl.develop(linear: wide, width: WW, height: HH, components: 3,
                         baselineExposure: 0, settings: .init(useBaselineExposure: false))
    try writeFloats(neg.density, "ref-wide-neg.f32")
    let k = printer.exposures(for: neg, filmNeutral: pl.referenceDensities)
    try writeFloats(printer.print(neg, exposures: k, encodeForDisplay: true), "ref-wide-out.f32")
    try JSONSerialization.data(withJSONObject: ["K": k]).write(to: out.appendingPathComponent("ref-wide-k.json"))
    print("wide ok")
}

// A real ProRAW frame, developed by the Darkroom at 1/4 size, plus its decoded linear light.
if CommandLine.arguments.count > 2 {
    let url = URL(fileURLWithPath: CommandLine.arguments[2])
    let dng = try DNGReader(contentsOf: url)
    let img = try dng.decodeLinear(downsample: 4)
    try writeFloats(img.pixels, "ref-dng-linear.f32")
    let photo = try Darkroom.develop(dngAt: url, recipe: .init(downsample: 4))
    try Data(photo.pixels).write(to: out.appendingPathComponent("ref-dng-out.u8"))
    let m = dng.metadata
    try JSONSerialization.data(withJSONObject: [
        "K": photo.exposures, "width": photo.width, "height": photo.height,
        "linearWidth": img.width, "linearHeight": img.height,
        "cameraToXYZ": ColorTransform.cameraToXYZ(m).m, "baselineExposure": m.baselineExposure,
        "orientation": m.orientation, "model": m.cameraModel,
    ]).write(to: out.appendingPathComponent("ref-dng.json"))
    print("dng ok", photo.width, photo.height)
}
