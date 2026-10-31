import AppKit
import SwiftUI

// Ditto's look: a soft neutral shell around the page, one accent (indigo)
// reserved for the agent, continuous corners, quick springy motion.
enum Theme {
  static let shell = dynamic(light: 0xECECEE, dark: 0x161618)
  static let card = dynamic(light: 0xFFFFFF, dark: 0x0C0C0E)
  static let raised = dynamic(light: 0xFFFFFF, dark: 0x232326)
  static let hover = dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.06)
  static let border = dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.08)
  static let text = dynamic(light: 0x18181B, dark: 0xF4F4F5)
  static let secondary = dynamic(light: 0x71717A, dark: 0xA1A1AA)
  static let accent = Color(red: 0x63 / 255, green: 0x66 / 255, blue: 0xF1 / 255)
  static let accent2 = Color(red: 0xA8 / 255, green: 0x55 / 255, blue: 0xF7 / 255)

  static let radius: CGFloat = 10
  static let spring = Animation.spring(response: 0.32, dampingFraction: 0.86)
  static let quick = Animation.easeOut(duration: 0.14)

  private static func dynamic(light: Int, dark: Int, alpha: CGFloat = 1) -> Color {
    Color(nsColor: NSColor(name: nil) { appearance in
      let hex = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
      return NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
                     green: CGFloat((hex >> 8) & 0xFF) / 255,
                     blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    })
  }
}

// A card: page-coloured, continuous corners, a hairline and a soft shadow.
struct CardStyle: ViewModifier {
  func body(content: Content) -> some View {
    content
      .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
        .strokeBorder(Theme.border, lineWidth: 0.5))
      .shadow(color: .black.opacity(0.07), radius: 10, y: 2)
  }
}

extension View {
  func card() -> some View { modifier(CardStyle()) }
}
