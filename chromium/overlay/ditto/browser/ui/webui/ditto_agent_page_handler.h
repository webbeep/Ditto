// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef DITTO_BROWSER_UI_WEBUI_DITTO_AGENT_PAGE_HANDLER_H_
#define DITTO_BROWSER_UI_WEBUI_DITTO_AGENT_PAGE_HANDLER_H_

#include <memory>
#include <string>

#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/task/cancelable_task_tracker.h"
#include "ditto/browser/import/chrome_import.h"
#include "ditto/browser/inference/inference_supervisor.h"
#include "ditto/browser/ui/webui/ditto_agent.mojom.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"

class BrowserWindowInterface;

namespace content {
class WebContents;
}

namespace ditto {

class CdpRelay;

class DittoAgentPageHandler : public mojom::PageHandler,
                              public InferenceSupervisor::Observer {
 public:
  DittoAgentPageHandler(content::WebContents* web_contents,
                        mojo::PendingRemote<mojom::Page> page,
                        mojo::PendingReceiver<mojom::PageHandler> receiver);
  DittoAgentPageHandler(const DittoAgentPageHandler&) = delete;
  DittoAgentPageHandler& operator=(const DittoAgentPageHandler&) = delete;
  ~DittoAgentPageHandler() override;

  // mojom::PageHandler:
  void StartRuntime(const std::string& preset_ini,
                    uint32_t memory_margin_mb,
                    StartRuntimeCallback callback) override;
  void StopRuntime() override;
  void SetStrandsEndpoint(const std::string& url) override;
  void GetSystemMemory(GetSystemMemoryCallback callback) override;
  void GetSearchUrl(GetSearchUrlCallback callback) override;
  void LoadChats(LoadChatsCallback callback) override;
  void SaveChats(const std::string& json) override;
  void ShowAgentPanel(const std::string& query,
                      const std::string& chat_id) override;
  void TakeHandOff(TakeHandOffCallback callback) override;
  void ImportFromChrome(ImportFromChromeCallback callback) override;
  void LoadMemory(LoadMemoryCallback callback) override;
  void SaveMemory(const std::string& json) override;
  void SearchUserPages(const std::string& query,
                       int32_t max_results,
                       SearchUserPagesCallback callback) override;
  void Fetch(mojom::Target target,
             const std::string& method,
             const std::string& path,
             const std::string& body,
             FetchCallback callback) override;
  void FetchStream(mojom::Target target,
                   const std::string& path,
                   const std::string& body,
                   int32_t stream_id,
                   FetchStreamCallback callback) override;
  void AttachToActiveTab(AttachToActiveTabCallback callback) override;
  void DetachFromTab() override;
  void SendCdp(const std::string& method,
               const std::string& params_json,
               SendCdpCallback callback) override;

  // InferenceSupervisor::Observer:
  void OnRuntimeMemoryPressure(base::MemoryPressureLevel level) override;

 private:
  void OnTabDetached();
  void OnChromeProfileRead(ImportFromChromeCallback callback,
                           ChromeProfile chrome);
  // This page's window, for hand-offs between the home page and the panel.
  BrowserWindowInterface* Window() const;

  raw_ptr<content::WebContents> web_contents_;
  mojo::Remote<mojom::Page> page_;
  mojo::Receiver<mojom::PageHandler> receiver_;
  std::unique_ptr<CdpRelay> relay_;

  base::CancelableTaskTracker history_tracker_;
  base::WeakPtrFactory<DittoAgentPageHandler> weak_factory_{this};
};

}  // namespace ditto

#endif  // DITTO_BROWSER_UI_WEBUI_DITTO_AGENT_PAGE_HANDLER_H_
