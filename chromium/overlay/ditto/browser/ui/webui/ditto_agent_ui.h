// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef DITTO_BROWSER_UI_WEBUI_DITTO_AGENT_UI_H_
#define DITTO_BROWSER_UI_WEBUI_DITTO_AGENT_UI_H_

#include <memory>
#include <string_view>

#include "base/memory/raw_ptr.h"
#include "chrome/browser/ui/webui/top_chrome/top_chrome_web_ui_controller.h"
#include "chrome/browser/ui/webui/top_chrome/top_chrome_webui_config.h"
#include "content/public/browser/webui_config.h"
#include "ditto/browser/ui/webui/ditto_agent.mojom.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "ui/webui/mojo_web_ui_controller.h"

namespace ditto {

// chrome://ditto-agent: the new tab page (one command bar, recent chats).
inline constexpr char kDittoHomeHost[] = "ditto-agent";
inline constexpr char kDittoHomeUrl[] = "chrome://ditto-agent/";
// chrome://ditto-agent.top-chrome: the agent, in the side panel.
inline constexpr char kDittoAgentPanelHost[] = "ditto-agent.top-chrome";
inline constexpr char kDittoAgentPanelUrl[] = "chrome://ditto-agent.top-chrome/";

class DittoAgentPageHandler;
class DittoHomeUI;
class DittoAgentPanelUI;

// Both pages use the same bindings; the page handler serves either.
class DittoPageHandlerHost : public mojom::PageHandlerFactory {
 public:
  explicit DittoPageHandlerHost(content::WebUI* web_ui);
  ~DittoPageHandlerHost() override;

  void Bind(mojo::PendingReceiver<mojom::PageHandlerFactory> receiver);

 private:
  // mojom::PageHandlerFactory:
  void CreatePageHandler(
      mojo::PendingRemote<mojom::Page> page,
      mojo::PendingReceiver<mojom::PageHandler> receiver) override;

  raw_ptr<content::WebUI> web_ui_;
  std::unique_ptr<DittoAgentPageHandler> page_handler_;
  mojo::Receiver<mojom::PageHandlerFactory> receiver_{this};
};

class DittoHomeUIConfig : public content::DefaultWebUIConfig<DittoHomeUI> {
 public:
  DittoHomeUIConfig();
};

class DittoHomeUI : public ui::MojoWebUIController {
 public:
  explicit DittoHomeUI(content::WebUI* web_ui);
  DittoHomeUI(const DittoHomeUI&) = delete;
  DittoHomeUI& operator=(const DittoHomeUI&) = delete;
  ~DittoHomeUI() override;

  void BindInterface(mojo::PendingReceiver<mojom::PageHandlerFactory> receiver);

 private:
  DittoPageHandlerHost host_;

  WEB_UI_CONTROLLER_TYPE_DECL();
};

class DittoAgentPanelUIConfig
    : public DefaultTopChromeWebUIConfig<DittoAgentPanelUI> {
 public:
  DittoAgentPanelUIConfig();
};

class DittoAgentPanelUI : public TopChromeWebUIController {
 public:
  explicit DittoAgentPanelUI(content::WebUI* web_ui);
  DittoAgentPanelUI(const DittoAgentPanelUI&) = delete;
  DittoAgentPanelUI& operator=(const DittoAgentPanelUI&) = delete;
  ~DittoAgentPanelUI() override;

  void BindInterface(mojo::PendingReceiver<mojom::PageHandlerFactory> receiver);

  static constexpr std::string_view GetWebUIName() { return "DittoAgent"; }

 private:
  DittoPageHandlerHost host_;

  WEB_UI_CONTROLLER_TYPE_DECL();
};

}  // namespace ditto

#endif  // DITTO_BROWSER_UI_WEBUI_DITTO_AGENT_UI_H_
