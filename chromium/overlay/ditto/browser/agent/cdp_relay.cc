// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "ditto/browser/agent/cdp_relay.h"

#include <utility>

#include "base/containers/fixed_flat_set.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/strings/string_util.h"
#include "base/values.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"

namespace ditto {

namespace {

// The agent only needs to read the page and act like a user. Everything
// else (Browser.*, Target.*, Storage.*, Network.getCookies, ...) is refused,
// so a prompt-injected page cannot use the agent to reach other tabs,
// cookies or files.
constexpr auto kAllowedMethods = base::MakeFixedFlatSet<std::string_view>({
    "DOM.scrollIntoViewIfNeeded",
    "Input.dispatchKeyEvent",
    "Input.dispatchMouseEvent",
    "Input.insertText",
    "Page.captureScreenshot",
    "Page.getNavigationHistory",
    "Page.navigate",
    "Runtime.evaluate",
});

}  // namespace

CdpRelay::CdpRelay(content::WebContents* contents,
                   base::OnceClosure on_detached)
    : on_detached_(std::move(on_detached)) {
  scoped_refptr<content::DevToolsAgentHost> host =
      content::DevToolsAgentHost::GetOrCreateFor(contents);
  if (host && host->AttachClient(this)) {
    host_ = std::move(host);
  }
}

CdpRelay::~CdpRelay() {
  if (host_) {
    host_->DetachClient(this);
  }
}

void CdpRelay::Send(const std::string& method,
                    const std::string& params_json,
                    ResultCallback callback) {
  if (!host_) {
    std::move(callback).Run(false, R"({"message":"not attached"})");
    return;
  }
  if (!kAllowedMethods.contains(method)) {
    std::move(callback).Run(false, R"({"message":"method not allowed"})");
    return;
  }
  base::DictValue params;
  if (!params_json.empty()) {
    std::optional<base::DictValue> parsed =
        base::JSONReader::ReadDict(params_json, base::JSON_PARSE_RFC);
    if (!parsed) {
      std::move(callback).Run(false, R"({"message":"bad params"})");
      return;
    }
    params = std::move(*parsed);
  }
  // Page.navigate is limited to the web; file:// and chrome:// stay out of
  // the agent's reach.
  if (method == "Page.navigate") {
    const std::string* url = params.FindString("url");
    if (!url || !GURL(*url).SchemeIsHTTPOrHTTPS()) {
      std::move(callback).Run(false, R"({"message":"only http(s) URLs"})");
      return;
    }
  }
  const int id = next_id_++;
  base::DictValue message;
  message.Set("id", id);
  message.Set("method", method);
  message.Set("params", std::move(params));
  std::string json = base::WriteJson(message).value_or("");
  pending_[id] = std::move(callback);
  host_->DispatchProtocolMessage(this, base::as_byte_span(json));
}

void CdpRelay::DispatchProtocolMessage(content::DevToolsAgentHost* host,
                                       base::span<const uint8_t> message) {
  std::optional<base::DictValue> reply = base::JSONReader::ReadDict(
      base::as_string_view(message), base::JSON_PARSE_RFC);
  if (!reply) {
    return;
  }
  std::optional<int> id = reply->FindInt("id");
  if (!id) {
    return;  // An event; the agent polls instead of subscribing.
  }
  auto it = pending_.find(*id);
  if (it == pending_.end()) {
    return;
  }
  ResultCallback callback = std::move(it->second);
  pending_.erase(it);
  if (base::DictValue* error = reply->FindDict("error")) {
    std::move(callback).Run(false, base::WriteJson(*error).value_or("{}"));
    return;
  }
  base::DictValue* result = reply->FindDict("result");
  std::move(callback).Run(
      true, result ? base::WriteJson(*result).value_or("{}") : "{}");
}

void CdpRelay::AgentHostClosed(content::DevToolsAgentHost* host) {
  host_ = nullptr;
  Detach();
}

void CdpRelay::Detach() {
  for (auto& [id, callback] : std::exchange(pending_, {})) {
    std::move(callback).Run(false, R"({"message":"detached"})");
  }
  if (on_detached_) {
    std::move(on_detached_).Run();
  }
}

bool CdpRelay::MayAttachToURL(const GURL& url, bool is_webui) {
  return !is_webui && !url.SchemeIsFile();
}

bool CdpRelay::MayReadLocalFiles() {
  return false;
}

bool CdpRelay::MayWriteLocalFiles() {
  return false;
}

bool CdpRelay::AllowUnsafeOperations() {
  return false;
}

std::string CdpRelay::GetTypeForMetrics() {
  return "DittoAgent";
}

}  // namespace ditto
