// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "ditto/browser/ui/webui/ditto_agent_ui.h"

#include <utility>

#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/common/url_constants.h"
#include "ditto/browser/resources/grit/ditto_agent_resources.h"
#include "ditto/browser/resources/grit/ditto_agent_resources_map.h"
#include "ditto/browser/ui/webui/ditto_agent_page_handler.h"
#include "ui/webui/webui_util.h"

namespace ditto {

DittoAgentUIConfig::DittoAgentUIConfig()
    : DefaultWebUIConfig(content::kChromeUIScheme, kDittoAgentHost) {}

DittoAgentUI::DittoAgentUI(content::WebUI* web_ui)
    : ui::MojoWebUIController(web_ui) {
  content::WebUIDataSource* source = content::WebUIDataSource::CreateAndAdd(
      Profile::FromWebUI(web_ui), kDittoAgentHost);
  webui::SetupWebUIDataSource(source, kDittoAgentResources,
                              IDR_DITTO_AGENT_DITTO_AGENT_HTML);
}

DittoAgentUI::~DittoAgentUI() = default;

void DittoAgentUI::BindInterface(
    mojo::PendingReceiver<mojom::PageHandlerFactory> receiver) {
  factory_receiver_.reset();
  factory_receiver_.Bind(std::move(receiver));
}

void DittoAgentUI::CreatePageHandler(
    mojo::PendingRemote<mojom::Page> page,
    mojo::PendingReceiver<mojom::PageHandler> receiver) {
  page_handler_ = std::make_unique<DittoAgentPageHandler>(
      web_ui()->GetWebContents(), std::move(page), std::move(receiver));
}

WEB_UI_CONTROLLER_TYPE_IMPL(DittoAgentUI)

}  // namespace ditto
