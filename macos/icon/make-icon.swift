// Draws the Claude Pulse app icon — the buddy bee flying across a sky-blue
// tile — with CoreGraphics, natively at every size macOS asks for, so small
// sizes stay crisp instead of being downscaled from one big bitmap.
//
//   make-icon <out.iconset> [preview.png]      (see ../make-icon.sh)

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Helpers (all geometry is in a 1024×1024 canvas, origin top-left)

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

func ellipse(_ cx: CGFloat, _ cy: CGFloat, _ rx: CGFloat, _ ry: CGFloat, deg: CGFloat = 0) -> CGPath {
    var t = CGAffineTransform(translationX: cx, y: cy).rotated(by: deg * .pi / 180)
    return CGPath(ellipseIn: CGRect(x: -rx, y: -ry, width: rx * 2, height: ry * 2), transform: &t)
}

func circle(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat) -> CGPath { ellipse(cx, cy, r, r) }

func fill(_ ctx: CGContext, _ p: CGPath, _ c: CGColor) {
    ctx.addPath(p); ctx.setFillColor(c); ctx.fillPath()
}

func stroke(_ ctx: CGContext, _ p: CGPath, _ c: CGColor, _ w: CGFloat) {
    ctx.addPath(p); ctx.setStrokeColor(c); ctx.setLineWidth(w)
    ctx.setLineCap(.round); ctx.setLineJoin(.round); ctx.strokePath()
}

func gradientFill(_ ctx: CGContext, _ p: CGPath, _ top: CGColor, _ bottom: CGColor, from: CGFloat, to: CGFloat) {
    let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [top, bottom] as CFArray, locations: [0, 1])!
    ctx.saveGState(); ctx.addPath(p); ctx.clip()
    ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: from), end: CGPoint(x: 0, y: to), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    ctx.restoreGState()
}

let ink = rgb(0x2E2A26)          // outlines, stripes, legs, antennae
let outline = rgb(0x3A2A10)

// MARK: - The icon

func drawIcon(_ ctx: CGContext, scale s: CGFloat) {
    // Shadows live in device space, unaffected by the CTM: scale by hand, and
    // "down" on screen is negative y.
    func shadow(_ dy: CGFloat, _ blur: CGFloat, _ a: CGFloat) {
        ctx.setShadow(offset: CGSize(width: 0, height: -dy * s), blur: blur * s, color: rgb(0x000000, a))
    }

    // Tile: the macOS rounded square with a soft drop shadow.
    let tile = CGPath(roundedRect: CGRect(x: 100, y: 100, width: 824, height: 824),
                      cornerWidth: 185, cornerHeight: 185, transform: nil)
    ctx.saveGState(); shadow(12, 28, 0.30); fill(ctx, tile, rgb(0x5AA9F7)); ctx.restoreGState()
    gradientFill(ctx, tile, rgb(0x9ADBFF), rgb(0x3F8EF2), from: 100, to: 924)

    ctx.saveGState(); ctx.addPath(tile); ctx.clip()
    // A soft sunlit glow behind the bee.
    let glow = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
                          colors: [rgb(0xFFFFFF, 0.55), rgb(0xFFFFFF, 0)] as CFArray, locations: [0, 1])!
    ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 560, y: 470), startRadius: 0,
                           endCenter: CGPoint(x: 560, y: 470), endRadius: 400, options: [])
    // Its flight path: a dotted trail curving up behind the stinger.
    let trail = CGMutablePath()
    trail.move(to: CGPoint(x: 196, y: 842))
    trail.addCurve(to: CGPoint(x: 262, y: 700), control1: CGPoint(x: 262, y: 880), control2: CGPoint(x: 302, y: 786))
    ctx.saveGState(); ctx.setLineDash(phase: 0, lengths: [1, 40])
    stroke(ctx, trail, rgb(0xFFFFFF, 0.9), 20); ctx.restoreGState()
    ctx.restoreGState()

    // The bee, tilted nose-up as if flying, casting one soft shadow.
    ctx.saveGState()
    shadow(16, 26, 0.28)
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    ctx.translateBy(x: 512, y: 560); ctx.rotate(by: -8 * .pi / 180); ctx.translateBy(x: -512, y: -560)
    drawBee(ctx)
    ctx.endTransparencyLayer()
    ctx.restoreGState()

    // A thin highlight along the tile's top edge.
    ctx.saveGState(); ctx.addPath(tile); ctx.clip()
    stroke(ctx, CGPath(roundedRect: CGRect(x: 104, y: 104, width: 816, height: 816), cornerWidth: 181, cornerHeight: 181, transform: nil),
           rgb(0xFFFFFF, 0.25), 6)
    ctx.restoreGState()
}

func drawBee(_ ctx: CGContext) {
    // Legs, tucked under the body.
    for (x, lean) in [(CGFloat(372), CGFloat(8)), (446, 2), (520, -6)] {
        let leg = CGMutablePath()
        leg.move(to: CGPoint(x: x, y: 740)); leg.addLine(to: CGPoint(x: x - lean * 3, y: 812))
        stroke(ctx, leg, ink, 24)
    }

    // Far wing, behind the body.
    let farWing = ellipse(452, 392, 140, 80, deg: -28)
    fill(ctx, farWing, rgb(0xFFFFFF, 0.62)); stroke(ctx, farWing, rgb(0xCFE9FF), 9)

    // Stinger.
    let stinger = CGMutablePath()
    stinger.move(to: CGPoint(x: 232, y: 570)); stinger.addLine(to: CGPoint(x: 156, y: 604)); stinger.addLine(to: CGPoint(x: 236, y: 630))
    stinger.closeSubpath()
    fill(ctx, stinger, ink)

    // Abdomen with its stripes, clipped to the body so they wrap around it.
    let body = ellipse(458, 592, 236, 184)
    gradientFill(ctx, body, rgb(0xFFDB55), rgb(0xF2AE18), from: 410, to: 776)
    ctx.saveGState(); ctx.addPath(body); ctx.clip()
    fill(ctx, ellipse(404, 600, 44, 210, deg: 6), ink)
    fill(ctx, ellipse(292, 600, 38, 210, deg: 6), ink)
    fill(ctx, ellipse(420, 490, 150, 46, deg: -6), rgb(0xFFFFFF, 0.30))     // sheen
    ctx.restoreGState()
    stroke(ctx, body, outline, 16)

    // Near wing, over the body.
    let nearWing = ellipse(566, 380, 160, 92, deg: 18)
    fill(ctx, nearWing, rgb(0xFFFFFF, 0.80)); stroke(ctx, nearWing, rgb(0xCFE9FF), 9)
    stroke(ctx, { let p = CGMutablePath(); p.move(to: CGPoint(x: 470, y: 400)); p.addQuadCurve(to: CGPoint(x: 660, y: 370), control: CGPoint(x: 560, y: 350)); return p }(),
           rgb(0xCFE9FF, 0.9), 7)

    // Antennae, rooted behind the head.
    for (from, ctrl, to, r) in [(CGPoint(x: 668, y: 380), CGPoint(x: 650, y: 290), CGPoint(x: 698, y: 236), CGFloat(20)),
                                (CGPoint(x: 740, y: 388), CGPoint(x: 776, y: 296), CGPoint(x: 826, y: 256), CGFloat(23))] {
        let a = CGMutablePath(); a.move(to: from); a.addQuadCurve(to: to, control: ctrl)
        stroke(ctx, a, ink, 15)
        fill(ctx, circle(to.x, to.y, r), ink)
        fill(ctx, circle(to.x - r * 0.35, to.y - r * 0.35, r * 0.3), rgb(0xFFFFFF, 0.5))
    }

    // Head.
    let head = circle(704, 502, 140)
    gradientFill(ctx, head, rgb(0xFFDF60), rgb(0xF3B11C), from: 362, to: 642)
    ctx.saveGState(); ctx.addPath(head); ctx.clip()
    fill(ctx, ellipse(668, 430, 70, 38, deg: -20), rgb(0xFFFFFF, 0.30))
    ctx.restoreGState()
    stroke(ctx, head, outline, 16)

    // Face: big friendly eyes, a rosy cheek, a smile.
    for (cx, cy, r, px, py, pr) in [(CGFloat(668), CGFloat(484), CGFloat(40), CGFloat(680), CGFloat(490), CGFloat(21)),
                                    (752, 474, 48, 767, 482, 25)] {
        fill(ctx, circle(cx, cy, r), rgb(0xFFFFFF)); stroke(ctx, circle(cx, cy, r), ink, 8)
        fill(ctx, circle(px, py, pr), ink)
        fill(ctx, circle(px + pr * 0.38, py - pr * 0.42, pr * 0.36), rgb(0xFFFFFF))
    }
    fill(ctx, ellipse(784, 548, 26, 16), rgb(0xFF8A7A, 0.65))
    let smile = CGMutablePath()
    smile.move(to: CGPoint(x: 712, y: 556)); smile.addQuadCurve(to: CGPoint(x: 780, y: 556), control: CGPoint(x: 746, y: 592))
    stroke(ctx, smile, ink, 11)
}

// MARK: - Rendering

func render(_ size: Int) -> CGImage {
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let s = CGFloat(size) / 1024
    ctx.translateBy(x: 0, y: CGFloat(size)); ctx.scaleBy(x: s, y: -s)   // 1024 canvas, y down
    ctx.setShouldAntialias(true); ctx.interpolationQuality = .high
    drawIcon(ctx, scale: s)
    return ctx.makeImage()!
}

func writePNG(_ image: CGImage, to path: String) {
    let url = URL(fileURLWithPath: path) as CFURL
    let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(path)") }
}

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: make-icon <out.iconset> [preview.png]"); exit(2) }
let set = args[1]
try FileManager.default.createDirectory(atPath: set, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    writePNG(render(base), to: "\(set)/icon_\(base)x\(base).png")
    writePNG(render(base * 2), to: "\(set)/icon_\(base)x\(base)@2x.png")
}
if args.count >= 3 { writePNG(render(1024), to: args[2]) }
print("wrote \(set)")
