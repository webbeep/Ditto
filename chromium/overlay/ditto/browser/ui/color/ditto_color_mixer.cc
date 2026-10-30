// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "ditto/browser/ui/color/ditto_color_mixer.h"

#include "chrome/browser/ui/color/chrome_color_id.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/color/color_id.h"
#include "ui/color/color_mixer.h"
#include "ui/color/color_provider.h"
#include "ui/color/color_provider_key.h"
#include "ui/color/color_recipe.h"

namespace ditto {

namespace {

// The same tokens as the agent panel (resources/ditto_agent.css).
struct Palette {
  SkColor shell;         // Frame, toolbar, tab strip, side panel chrome.
  SkColor shell_idle;    // The shell of a window in the background.
  SkColor page;          // Page-level surfaces: active tab, dialogs, menus.
  SkColor muted;         // Fields and hovered rows.
  SkColor muted_strong;  // Pressed and selected rows.
  SkColor border;
  SkColor text;
  SkColor text_muted;
  SkColor primary;
  SkColor on_primary;
};

constexpr Palette kLight = {
    .shell = SkColorSetRGB(0xF4, 0xF4, 0xF5),
    .shell_idle = SkColorSetRGB(0xFA, 0xFA, 0xFA),
    .page = SkColorSetRGB(0xFF, 0xFF, 0xFF),
    .muted = SkColorSetRGB(0xE9, 0xE9, 0xEB),
    .muted_strong = SkColorSetRGB(0xE4, 0xE4, 0xE7),
    .border = SkColorSetRGB(0xE4, 0xE4, 0xE7),
    .text = SkColorSetRGB(0x09, 0x09, 0x0B),
    .text_muted = SkColorSetRGB(0x71, 0x71, 0x7A),
    .primary = SkColorSetRGB(0x18, 0x18, 0x1B),
    .on_primary = SkColorSetRGB(0xFA, 0xFA, 0xFA),
};

constexpr Palette kDark = {
    .shell = SkColorSetRGB(0x18, 0x18, 0x1B),
    .shell_idle = SkColorSetRGB(0x14, 0x14, 0x16),
    .page = SkColorSetRGB(0x09, 0x09, 0x0B),
    .muted = SkColorSetRGB(0x27, 0x27, 0x2A),
    .muted_strong = SkColorSetRGB(0x3F, 0x3F, 0x46),
    .border = SkColorSetRGB(0x27, 0x27, 0x2A),
    .text = SkColorSetRGB(0xFA, 0xFA, 0xFA),
    .text_muted = SkColorSetRGB(0xA1, 0xA1, 0xAA),
    .primary = SkColorSetRGB(0xFA, 0xFA, 0xFA),
    .on_primary = SkColorSetRGB(0x18, 0x18, 0x1B),
};

}  // namespace

void AddDittoColorMixer(ui::ColorProvider* provider,
                        const ui::ColorProviderKey& key) {
  if (key.custom_theme ||
      key.contrast_mode == ui::ColorProviderKey::ContrastMode::kHigh) {
    return;
  }
  const Palette& p = key.color_mode == ui::ColorProviderKey::ColorMode::kDark
                         ? kDark
                         : kLight;
  ui::ColorMixer& mixer = provider->AddMixer();

  // System tokens: everything Chromium derives (menus, dialogs, bubbles,
  // buttons, focus rings, WebUI pages) follows these.
  mixer[ui::kColorSysPrimary] = {p.primary};
  mixer[ui::kColorSysOnPrimary] = {p.on_primary};
  mixer[ui::kColorSysPrimaryContainer] = {p.muted};
  mixer[ui::kColorSysOnPrimaryContainer] = {p.text};
  mixer[ui::kColorSysTonalContainer] = {p.muted};
  mixer[ui::kColorSysOnTonalContainer] = {p.text};
  mixer[ui::kColorSysBase] = {p.page};
  mixer[ui::kColorSysBaseContainer] = {p.shell};
  mixer[ui::kColorSysBaseContainerElevated] = {p.page};
  mixer[ui::kColorSysSurface] = {p.page};
  mixer[ui::kColorSysSurface1] = {p.page};
  mixer[ui::kColorSysSurface2] = {p.page};
  mixer[ui::kColorSysSurface3] = {p.shell};
  mixer[ui::kColorSysSurface4] = {p.shell};
  mixer[ui::kColorSysSurface5] = {p.shell};
  mixer[ui::kColorSysOnSurface] = {p.text};
  mixer[ui::kColorSysOnSurfaceSecondary] = {p.text_muted};
  mixer[ui::kColorSysOnSurfaceSubtle] = {p.text_muted};
  mixer[ui::kColorSysOnSurfacePrimary] = {p.text};
  mixer[ui::kColorSysDivider] = {p.border};
  mixer[ui::kColorSysTonalOutline] = {p.border};
  mixer[ui::kColorSysNeutralOutline] = {p.border};
  mixer[ui::kColorSysOutline] = {p.border};
  mixer[ui::kColorSysStateFocusRing] = {p.text_muted};
  mixer[ui::kColorSysStateTextHighlight] = {SkColorSetA(p.primary, 0x33)};
  mixer[ui::kColorSysStateOnTextHighlight] = {p.text};
  mixer[ui::kColorSysOmniboxContainer] = {p.muted};

  // The shell: frame, toolbar and tab strip are one surface.
  mixer[ui::kColorSysHeader] = {p.shell};
  mixer[ui::kColorSysHeaderInactive] = {p.shell_idle};
  mixer[ui::kColorSysHeaderContainer] = {p.page};
  mixer[ui::kColorSysHeaderContainerInactive] = {p.page};
  mixer[ui::kColorSysOnHeaderPrimary] = {p.text};
  mixer[ui::kColorSysOnHeaderPrimaryInactive] = {p.text_muted};
  mixer[ui::kColorSysOnHeaderDivider] = {SK_ColorTRANSPARENT};
  mixer[ui::kColorSysOnHeaderDividerInactive] = {SK_ColorTRANSPARENT};
  mixer[ui::kColorSysStateHeaderHover] = {p.muted};
  mixer[ui::kColorSysStateHeaderHoverInactive] = {p.muted};
  mixer[ui::kColorFrameActive] = {p.shell};
  mixer[ui::kColorFrameInactive] = {p.shell_idle};
  mixer[kColorToolbar] = {p.shell};
  mixer[kColorToolbarText] = {p.text};
  mixer[kColorToolbarButtonIcon] = {p.text_muted};
  mixer[kColorToolbarButtonIconHovered] = {p.text};
  mixer[kColorToolbarButtonIconInactive] = {SkColorSetA(p.text_muted, 0x80)};
  mixer[kColorToolbarSeparator] = {SK_ColorTRANSPARENT};
  mixer[kColorToolbarTopSeparatorFrameActive] = {SK_ColorTRANSPARENT};
  mixer[kColorToolbarTopSeparatorFrameInactive] = {SK_ColorTRANSPARENT};
  mixer[kColorToolbarContentAreaSeparator] = {SK_ColorTRANSPARENT};
  mixer[kColorBookmarkBarBackground] = {p.shell};
  mixer[kColorBookmarkBarForeground] = {p.text};

  // Tabs: the active one is a page-coloured card, the rest sit on the shell.
  mixer[kColorTabBackgroundActiveFrameActive] = {p.page};
  mixer[kColorTabBackgroundActiveFrameInactive] = {p.page};
  mixer[kColorTabBackgroundInactiveFrameActive] = {p.shell};
  mixer[kColorTabBackgroundInactiveFrameInactive] = {p.shell_idle};
  mixer[kColorTabBackgroundInactiveHoverFrameActive] = {p.muted};
  mixer[kColorTabBackgroundInactiveHoverFrameInactive] = {p.muted};
  mixer[kColorTabBackgroundSelectedFrameActive] = {p.muted_strong};
  mixer[kColorTabBackgroundSelectedFrameInactive] = {p.muted_strong};
  mixer[kColorTabForegroundActiveFrameActive] = {p.text};
  mixer[kColorTabForegroundActiveFrameInactive] = {p.text};
  mixer[kColorTabForegroundInactiveFrameActive] = {p.text_muted};
  mixer[kColorTabForegroundInactiveFrameInactive] = {p.text_muted};
  mixer[kColorTabDividerFrameActive] = {SK_ColorTRANSPARENT};
  mixer[kColorTabDividerFrameInactive] = {SK_ColorTRANSPARENT};
  mixer[kColorTabStrokeFrameActive] = {SK_ColorTRANSPARENT};
  mixer[kColorTabStrokeFrameInactive] = {SK_ColorTRANSPARENT};
  mixer[kColorVerticalTabStripShadow] = {SK_ColorTRANSPARENT};
  mixer[kColorNewTabButtonForegroundFrameActive] = {p.text_muted};
  mixer[kColorNewTabButtonForegroundFrameInactive] = {p.text_muted};
  mixer[kColorNewTabButtonBackgroundFrameActive] = {SK_ColorTRANSPARENT};
  mixer[kColorNewTabButtonBackgroundFrameInactive] = {SK_ColorTRANSPARENT};

  // Address bar: a quiet field on the shell, a page-coloured dropdown.
  mixer[kColorLocationBarBackground] = {p.muted};
  mixer[kColorLocationBarBackgroundHovered] = {p.muted_strong};
  mixer[kColorLocationBarBorder] = {SK_ColorTRANSPARENT};
  mixer[kColorOmniboxText] = {p.text};
  mixer[kColorOmniboxTextDimmed] = {p.text_muted};
  mixer[kColorOmniboxResultsBackground] = {p.page};
  mixer[kColorOmniboxResultsBackgroundHovered] = {p.shell};
  mixer[kColorOmniboxResultsBackgroundSelected] = {p.muted};
  mixer[kColorOmniboxResultsUrl] = {p.text_muted};
  mixer[kColorOmniboxResultsUrlSelected] = {p.text_muted};
  mixer[kColorOmniboxBubbleOutline] = {p.border};

  // Side panel (the agent): shell header around a page-coloured body.
  mixer[kColorSidePanelBackground] = {p.shell};
  mixer[kColorSidePanelContentBackground] = {p.page};
  mixer[kColorSidePanelContentAreaSeparator] = {SK_ColorTRANSPARENT};
  mixer[kColorSidePanelEntryTitle] = {p.text};
  mixer[kColorSidePanelEntryIcon] = {p.text_muted};
  mixer[kColorSidePanelHeaderButtonIcon] = {p.text_muted};
}

}  // namespace ditto
