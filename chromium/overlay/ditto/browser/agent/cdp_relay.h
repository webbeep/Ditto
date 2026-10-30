// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef DITTO_BROWSER_AGENT_CDP_RELAY_H_
#define DITTO_BROWSER_AGENT_CDP_RELAY_H_

#include <string>

#include "base/containers/flat_map.h"
#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "content/public/browser/devtools_agent_host_client.h"

namespace content {
class DevToolsAgentHost;
class WebContents;
}  // namespace content

namespace ditto {

// Lets the agent drive one tab through the Chrome DevTools Protocol, from
// inside the browser process (no --remote-debugging-port is ever opened).
// The client is untrusted: it cannot attach to chrome:// pages, read or
// write local files, or use unsafe CDP domains.
class CdpRelay : public content::DevToolsAgentHostClient {
 public:
  using ResultCallback =
      base::OnceCallback<void(bool ok, const std::string& result_json)>;

  CdpRelay(content::WebContents* contents, base::OnceClosure on_detached);
  CdpRelay(const CdpRelay&) = delete;
  CdpRelay& operator=(const CdpRelay&) = delete;
  ~CdpRelay() override;

  bool attached() const { return !!host_; }
  void Send(const std::string& method,
            const std::string& params_json,
            ResultCallback callback);

  // content::DevToolsAgentHostClient:
  void DispatchProtocolMessage(content::DevToolsAgentHost* host,
                               base::span<const uint8_t> message) override;
  void AgentHostClosed(content::DevToolsAgentHost* host) override;
  bool MayAttachToURL(const GURL& url, bool is_webui) override;
  bool MayReadLocalFiles() override;
  bool MayWriteLocalFiles() override;
  bool AllowUnsafeOperations() override;
  std::string GetTypeForMetrics() override;

 private:
  void Detach();

  scoped_refptr<content::DevToolsAgentHost> host_;
  base::OnceClosure on_detached_;
  int next_id_ = 1;
  base::flat_map<int, ResultCallback> pending_;
};

}  // namespace ditto

#endif  // DITTO_BROWSER_AGENT_CDP_RELAY_H_
