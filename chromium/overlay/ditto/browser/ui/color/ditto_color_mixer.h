// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef DITTO_BROWSER_UI_COLOR_DITTO_COLOR_MIXER_H_
#define DITTO_BROWSER_UI_COLOR_DITTO_COLOR_MIXER_H_

namespace ui {
class ColorProvider;
struct ColorProviderKey;
}  // namespace ui

namespace ditto {

// Ditto's browser palette: neutral zinc surfaces, the window frame and
// toolbar as one sidebar-coloured shell around a white (or near-black) page,
// no separators. Runs after Chromium's own mixers; a theme the user installs
// and high-contrast mode still win.
void AddDittoColorMixer(ui::ColorProvider* provider,
                        const ui::ColorProviderKey& key);

}  // namespace ditto

#endif  // DITTO_BROWSER_UI_COLOR_DITTO_COLOR_MIXER_H_
