import SwiftUI

// MARK: - Kettle-damper mark (the rotated "Q" in BB◉law)
//
// Ported from the design system's BBQlawBrand.jsx DamperMark: a Weber-style
// charcoal-kettle damper — a disc with four punched holes + a slide tab — drawn
// in a 120×120 space and rotated -45° so the tab reads as the Q's descender.
// Even-odd fill punches the holes; default fill is the ember gradient.
struct DamperMark: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        // Disc: outer circle centered (60,56) r44.
        p.addEllipse(in: CGRect(x: 16, y: 12, width: 88, height: 88))
        // Four damper holes (r9.5) — punched out via even-odd fill.
        for c in [CGPoint(x: 45, y: 41), CGPoint(x: 75, y: 41),
                  CGPoint(x: 45, y: 71), CGPoint(x: 75, y: 71)] {
            p.addEllipse(in: CGRect(x: c.x - 9.5, y: c.y - 9.5, width: 19, height: 19))
        }
        // Slide tab.
        var tab = Path()
        tab.move(to: CGPoint(x: 52, y: 92))
        tab.addLine(to: CGPoint(x: 68, y: 92))
        tab.addLine(to: CGPoint(x: 72, y: 112))
        tab.addQuadCurve(to: CGPoint(x: 69, y: 115), control: CGPoint(x: 72, y: 115))
        tab.addLine(to: CGPoint(x: 51, y: 115))
        tab.addQuadCurve(to: CGPoint(x: 48, y: 112), control: CGPoint(x: 48, y: 115))
        tab.closeSubpath()
        p.addPath(tab)

        // Rotate -45° about (60,60).
        let rot = CGAffineTransform(translationX: 60, y: 60)
            .rotated(by: -.pi / 4)
            .translatedBy(x: -60, y: -60)
        // Scale the 120-unit art to fit `rect`, centered.
        let s = min(rect.width, rect.height) / 120
        let offX = rect.minX + (rect.width - 120 * s) / 2
        let offY = rect.minY + (rect.height - 120 * s) / 2
        let fit = CGAffineTransform(translationX: offX, y: offY).scaledBy(x: s, y: s)
        return p.applying(rot).applying(fit)
    }
}

struct DamperMarkView: View {
    var size: CGFloat = 40
    var mono: Bool = false
    var color: Color = BBQ.ember

    var body: some View {
        Group {
            if mono {
                DamperMark().fill(color, style: FillStyle(eoFill: true))
            } else {
                DamperMark().fill(
                    LinearGradient(
                        colors: [Color(hex: 0xF7B23E), Color(hex: 0xE3611F), Color(hex: 0xC2410C)],
                        startPoint: .init(x: 0.1, y: 0.05),
                        endPoint: .init(x: 0.9, y: 1.0)
                    ),
                    style: FillStyle(eoFill: true)
                )
            }
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Wordmark lockup: BB[◉]law (the mark IS the Q; "law" runs ember → "BB-claw")
struct Logo: View {
    var size: CGFloat = 21
    var mono: Bool = false

    var body: some View {
        HStack(spacing: 0) {
            Text("BB")
                .foregroundStyle(mono ? BBQ.fg1 : BBQ.fg1)
            DamperMarkView(size: size * 1.06, mono: mono, color: BBQ.fg1)
                .padding(.horizontal, -size * 0.05)
            Text("law")
                .foregroundStyle(mono ? BBQ.fg1 : BBQ.ember)
        }
        .font(BBQ.display(size, weight: .heavy))
        .tracking(-0.03 * size)
    }
}

#Preview {
    VStack(spacing: 24) {
        Logo(size: 28)
        DamperMarkView(size: 72)
        Logo(size: 21, mono: true)
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(BBQ.bg)
}
