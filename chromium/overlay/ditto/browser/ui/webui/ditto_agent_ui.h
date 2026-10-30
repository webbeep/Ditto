// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef DITTO_BROWSER_UI_WEBUI_DITTO_AGENT_UI_H_
#define DITTO_BROWSER_UI_WEBUI_DITTO_AGENT_UI_H_

#include <memory>

#include "content/public/browser/webui_config.h"
#include "ditto/browser/ui/webui/ditto_agent.mojom.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "ui/webui/mojo_web_ui_controller.h"

namespace ditto {

inline constexpr char kDittoAgentHost[] = "ditto-agent";

class DittoAgentPageHandler;
class DittoAgentUI;

class DittoAgentUIConfig : public content::DefaultWebUIConfig<DittoAgentUI> {
 public:
  DittoAgentUIConfig();
};

// chrome://ditto-agent: the agent chat, model manager and settings.
class DittoAgentUI : public ui::MojoWebUIController,
                     public mojom::PageHandlerFactory {
 public:
  explicit DittoAgentUI(content::WebUI* web_ui);
  DittoAgentUI(const DittoAgentUI&) = delete;
  DittoAgentUI& operator=(const DittoAgentUI&) = delete;
  ~DittoAgentUI() override;

  void BindInterface(mojo::PendingReceiver<mojom::PageHandlerFactory> receiver);

 private:
  // mojom::PageHandlerFactory:
  void CreatePageHandler(
      mojo::PendingRemote<mojom::Page> page,
      mojo::PendingReceiver<mojom::PageHandler> receiver) override;

  std::unique_ptr<DittoAgentPageHandler> page_handler_;
  mojo::Receiver<mojom::PageHandlerFactory> factory_receiver_{this};

  WEB_UI_CONTROLLER_TYPE_DECL();
};

}  // namespace ditto

#endif  // DITTO_BROWSER_UI_WEBUI_DITTO_AGENT_UI_H_
