// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "ditto/browser/ui/webui/ditto_agent_page_handler.h"

#include <utility>

#include "base/strings/utf_string_conversions.h"
#include "base/system/sys_info.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/ui/browser_tabstrip.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/webui/webui_embedding_context.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/web_contents.h"
#include "ditto/browser/agent/cdp_relay.h"
#include "url/gurl.h"
#include "url/url_constants.h"

namespace ditto {

namespace {

InferenceSupervisor::Target ToTarget(mojom::Target target) {
  return target == mojom::Target::kStrandsSidecar
             ? InferenceSupervisor::Target::kStrandsSidecar
             : InferenceSupervisor::Target::kRuntime;
}

mojom::HttpResponsePtr ToMojo(InferenceSupervisor::Response response) {
  return mojom::HttpResponse::New(response.status, std::move(response.body));
}

}  // namespace

DittoAgentPageHandler::DittoAgentPageHandler(
    content::WebContents* web_contents,
    mojo::PendingRemote<mojom::Page> page,
    mojo::PendingReceiver<mojom::PageHandler> receiver)
    : web_contents_(web_contents),
      page_(std::move(page)),
      receiver_(this, std::move(receiver)) {
  InferenceSupervisor::GetInstance()->AddClient(this);
}

DittoAgentPageHandler::~DittoAgentPageHandler() {
  InferenceSupervisor::GetInstance()->RemoveClient(this);
}

void DittoAgentPageHandler::StartRuntime(const std::string& preset_ini,
                                         uint32_t memory_margin_mb,
                                         StartRuntimeCallback callback) {
  InferenceSupervisor::GetInstance()->EnsureStarted(
      preset_ini, memory_margin_mb, std::move(callback));
}

void DittoAgentPageHandler::StopRuntime() {
  InferenceSupervisor::GetInstance()->Stop();
}

void DittoAgentPageHandler::SetStrandsEndpoint(const std::string& url) {
  InferenceSupervisor::GetInstance()->SetStrandsEndpoint(url);
}

void DittoAgentPageHandler::GetSystemMemory(GetSystemMemoryCallback callback) {
  std::move(callback).Run(
      base::SysInfo::AmountOfTotalPhysicalMemory().InMiB(),
      base::SysInfo::AmountOfAvailablePhysicalMemory().InMiB());
}

void DittoAgentPageHandler::Fetch(mojom::Target target,
                                  const std::string& method,
                                  const std::string& path,
                                  const std::string& body,
                                  FetchCallback callback) {
  if (method != "GET" && method != "POST" && method != "DELETE") {
    std::move(callback).Run(mojom::HttpResponse::New(0, "bad method"));
    return;
  }
  InferenceSupervisor::GetInstance()->Fetch(
      ToTarget(target), method, path, body,
      base::BindOnce(&ToMojo).Then(std::move(callback)));
}

void DittoAgentPageHandler::FetchStream(mojom::Target target,
                                        const std::string& path,
                                        const std::string& body,
                                        int32_t stream_id,
                                        FetchStreamCallback callback) {
  InferenceSupervisor::GetInstance()->FetchStream(
      ToTarget(target), path, body,
      base::BindRepeating(
          [](base::WeakPtr<DittoAgentPageHandler> self, int32_t stream_id,
             std::string_view chunk) {
            if (self) {
              self->page_->OnStreamChunk(stream_id, std::string(chunk));
            }
          },
          weak_factory_.GetWeakPtr(), stream_id),
      base::BindOnce(&ToMojo).Then(std::move(callback)));
}

void DittoAgentPageHandler::AttachToActiveTab(
    AttachToActiveTabCallback callback) {
  relay_.reset();
  BrowserWindowInterface* window =
      webui::GetBrowserWindowInterface(web_contents_);
  tabs::TabInterface* tab = window ? window->GetActiveTabInterface() : nullptr;
  content::WebContents* target = tab ? tab->GetContents() : nullptr;
  if (window && (!target || target == web_contents_.get())) {
    // The agent UI is the active tab: give the agent its own tab beside it.
    target = chrome::AddAndReturnTabAt(window, GURL(url::kAboutBlankURL),
                                       /*index=*/-1, /*foreground=*/false);
  }
  if (!target) {
    std::move(callback).Run(mojom::TabTarget::New(false, "", ""));
    return;
  }
  relay_ = std::make_unique<CdpRelay>(
      target, base::BindOnce(&DittoAgentPageHandler::OnTabDetached,
                             weak_factory_.GetWeakPtr()));
  if (!relay_->attached()) {
    relay_.reset();
    std::move(callback).Run(mojom::TabTarget::New(false, "", ""));
    return;
  }
  std::move(callback).Run(mojom::TabTarget::New(
      true, target->GetLastCommittedURL().spec(),
      base::UTF16ToUTF8(target->GetTitle())));
}

void DittoAgentPageHandler::DetachFromTab() {
  relay_.reset();
}

void DittoAgentPageHandler::SendCdp(const std::string& method,
                                    const std::string& params_json,
                                    SendCdpCallback callback) {
  if (!relay_) {
    std::move(callback).Run(false, R"({"message":"not attached"})");
    return;
  }
  relay_->Send(method, params_json, std::move(callback));
}

void DittoAgentPageHandler::OnRuntimeMemoryPressure(
    base::MemoryPressureLevel level) {
  page_->OnMemoryPressure(level == base::MEMORY_PRESSURE_LEVEL_CRITICAL);
}

void DittoAgentPageHandler::OnTabDetached() {
  // Posted: the relay is mid-callback when this runs.
  base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(
      FROM_HERE, std::move(relay_));
  page_->OnTabDetached();
}

}  // namespace ditto
