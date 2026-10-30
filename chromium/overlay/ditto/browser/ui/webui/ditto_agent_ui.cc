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

namespace {

// The panel and the home page are built from the same resources; only the
// page each host serves by default differs.
void AddDataSource(content::WebUI* web_ui, std::string_view host, int default_resource) {
  content::WebUIDataSource* source = content::WebUIDataSource::CreateAndAdd(
      Profile::FromWebUI(web_ui), std::string(host));
  webui::SetupWebUIDataSource(source, kDittoAgentResources, default_resource);
}

}  // namespace

DittoPageHandlerHost::DittoPageHandlerHost(content::WebUI* web_ui)
    : web_ui_(web_ui) {}

DittoPageHandlerHost::~DittoPageHandlerHost() = default;

void DittoPageHandlerHost::Bind(
    mojo::PendingReceiver<mojom::PageHandlerFactory> receiver) {
  receiver_.reset();
  receiver_.Bind(std::move(receiver));
}

void DittoPageHandlerHost::CreatePageHandler(
    mojo::PendingRemote<mojom::Page> page,
    mojo::PendingReceiver<mojom::PageHandler> receiver) {
  page_handler_ = std::make_unique<DittoAgentPageHandler>(
      web_ui_->GetWebContents(), std::move(page), std::move(receiver));
}

DittoHomeUIConfig::DittoHomeUIConfig()
    : DefaultWebUIConfig(content::kChromeUIScheme, kDittoHomeHost) {}

DittoHomeUI::DittoHomeUI(content::WebUI* web_ui)
    : ui::MojoWebUIController(web_ui), host_(web_ui) {
  AddDataSource(web_ui, kDittoHomeHost, IDR_DITTO_AGENT_HOME_HTML);
}

DittoHomeUI::~DittoHomeUI() = default;

void DittoHomeUI::BindInterface(
    mojo::PendingReceiver<mojom::PageHandlerFactory> receiver) {
  host_.Bind(std::move(receiver));
}

WEB_UI_CONTROLLER_TYPE_IMPL(DittoHomeUI)

DittoAgentPanelUIConfig::DittoAgentPanelUIConfig()
    : DefaultTopChromeWebUIConfig(content::kChromeUIScheme, kDittoAgentPanelHost) {}

DittoAgentPanelUI::DittoAgentPanelUI(content::WebUI* web_ui)
    : TopChromeWebUIController(web_ui), host_(web_ui) {
  AddDataSource(web_ui, kDittoAgentPanelHost, IDR_DITTO_AGENT_DITTO_AGENT_HTML);
}

DittoAgentPanelUI::~DittoAgentPanelUI() = default;

void DittoAgentPanelUI::BindInterface(
    mojo::PendingReceiver<mojom::PageHandlerFactory> receiver) {
  host_.Bind(std::move(receiver));
}

WEB_UI_CONTROLLER_TYPE_IMPL(DittoAgentPanelUI)

}  // namespace ditto
