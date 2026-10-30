// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef DITTO_BROWSER_UI_VIEWS_SIDE_PANEL_DITTO_AGENT_SIDE_PANEL_H_
#define DITTO_BROWSER_UI_VIEWS_SIDE_PANEL_DITTO_AGENT_SIDE_PANEL_H_

class BrowserWindowInterface;
class SidePanelRegistry;

namespace ditto {

// Registers the agent as a window-wide side panel entry (left side by
// default, see side_panel_prefs.cc). Called from
// SidePanelHelper::PopulateGlobalEntries.
void RegisterAgentSidePanel(BrowserWindowInterface* browser,
                            SidePanelRegistry* registry);

// Opens the agent panel in `browser`'s window.
void ShowAgentSidePanel(BrowserWindowInterface* browser);

}  // namespace ditto

#endif  // DITTO_BROWSER_UI_VIEWS_SIDE_PANEL_DITTO_AGENT_SIDE_PANEL_H_
