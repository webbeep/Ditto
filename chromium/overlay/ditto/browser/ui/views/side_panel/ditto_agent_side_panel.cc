// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "ditto/browser/ui/views/side_panel/ditto_agent_side_panel.h"

#include <memory>

#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/side_panel/side_panel_entry.h"
#include "chrome/browser/ui/side_panel/side_panel_registry.h"
#include "chrome/browser/ui/side_panel/side_panel_ui.h"
#include "chrome/browser/ui/views/side_panel/side_panel_web_ui_view.h"
#include "chrome/browser/ui/webui/top_chrome/webui_contents_wrapper.h"
#include "chrome/grit/generated_resources.h"
#include "ditto/browser/ui/webui/ditto_agent_ui.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "url/gurl.h"

using SidePanelWebUIViewT_DittoAgentPanelUI =
    SidePanelWebUIViewT<ditto::DittoAgentPanelUI>;
BEGIN_TEMPLATE_METADATA(SidePanelWebUIViewT_DittoAgentPanelUI,
                        SidePanelWebUIViewT)
END_METADATA

namespace ditto {

namespace {

std::unique_ptr<views::View> CreateAgentView(Profile* profile,
                                             SidePanelEntryScope& scope) {
  return std::make_unique<SidePanelWebUIViewT<DittoAgentPanelUI>>(
      scope, /*on_show_cb=*/base::RepeatingClosure(),
      /*close_cb=*/base::RepeatingClosure(),
      std::make_unique<WebUIContentsWrapperT<DittoAgentPanelUI>>(
          GURL(kDittoAgentPanelUrl), profile, IDS_DITTO_AGENT_TITLE,
          /*esc_closes_ui=*/false));
}

}  // namespace

void RegisterAgentSidePanel(BrowserWindowInterface* browser,
                            SidePanelRegistry* registry) {
  registry->Register(std::make_unique<SidePanelEntry>(
      SidePanelEntry::Key(SidePanelEntry::Id::kDittoAgent),
      base::BindRepeating(&CreateAgentView, browser->GetProfile()),
      /*default_content_width_callback=*/base::NullCallback()));
}

void ShowAgentSidePanel(BrowserWindowInterface* browser) {
  if (SidePanelUI* side_panel = SidePanelUI::From(browser)) {
    side_panel->Show(SidePanelEntry::Id::kDittoAgent);
  }
}

}  // namespace ditto
