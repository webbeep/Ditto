// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "ditto/browser/ui/webui/ditto_agent_page_handler.h"

#include <algorithm>
#include <map>
#include <set>
#include <utility>
#include <vector>

#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "base/task/thread_pool.h"
#include "base/strings/utf_string_conversions.h"
#include "base/system/sys_info.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/bookmarks/bookmark_model_factory.h"
#include "chrome/browser/history/history_service_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/search_engines/template_url_service_factory.h"
#include "chrome/browser/ui/browser_tabstrip.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/webui/webui_embedding_context.h"
#include "components/bookmarks/browser/bookmark_model.h"
#include "components/bookmarks/browser/bookmark_utils.h"
#include "components/history/core/browser/history_service.h"
#include "components/history/core/browser/history_types.h"
#include "components/keyed_service/core/service_access_type.h"
#include "components/search_engines/template_url.h"
#include "components/search_engines/template_url_service.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/web_contents.h"
#include "ditto/browser/agent/cdp_relay.h"
#include "ditto/browser/ui/views/side_panel/ditto_agent_side_panel.h"
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

// Chats live in the profile; one sequence keeps reads and writes in order.
scoped_refptr<base::SequencedTaskRunner> ChatsTaskRunner() {
  static base::NoDestructor<scoped_refptr<base::SequencedTaskRunner>> runner(
      base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN}));
  return *runner;
}

// Ditto's files in the profile: chats.json, memory.json.
base::FilePath DittoFile(content::WebContents* contents,
                         base::FilePath::StringViewType name) {
  return Profile::FromBrowserContext(contents->GetBrowserContext())
      ->GetPath()
      .Append(FILE_PATH_LITERAL("Ditto"))
      .Append(name);
}

void ReadDittoFile(base::FilePath path,
                   base::OnceCallback<void(const std::string&)> done) {
  ChatsTaskRunner()->PostTaskAndReplyWithResult(
      FROM_HERE,
      base::BindOnce(
          [](base::FilePath path) {
            std::string json;
            base::ReadFileToString(path, &json);
            return json;
          },
          std::move(path)),
      std::move(done));
}

void WriteDittoFile(base::FilePath path, std::string json) {
  ChatsTaskRunner()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](base::FilePath path, std::string json) {
                       base::CreateDirectory(path.DirName());
                       // Atomic: a crash never leaves half a file.
                       base::ImportantFileWriter::WriteFileAtomically(path, json);
                     },
                     std::move(path), std::move(json)));
}

double ToUnixMs(base::Time time) {
  return time.InMillisecondsFSinceUnixEpoch();
}

// A question or chat the home page handed to the panel of its window, until
// the panel takes it.
struct HandOff {
  std::string query;
  std::string chat_id;
};

std::map<const BrowserWindowInterface*, HandOff>& PendingHandOffs() {
  static base::NoDestructor<std::map<const BrowserWindowInterface*, HandOff>>
      pending;
  return *pending;
}

std::vector<DittoAgentPageHandler*>& LiveHandlers() {
  static base::NoDestructor<std::vector<DittoAgentPageHandler*>> handlers;
  return *handlers;
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
  LiveHandlers().push_back(this);
}

DittoAgentPageHandler::~DittoAgentPageHandler() {
  InferenceSupervisor::GetInstance()->RemoveClient(this);
  std::erase(LiveHandlers(), this);
}

BrowserWindowInterface* DittoAgentPageHandler::Window() const {
  return webui::GetBrowserWindowInterface(web_contents_);
}

void DittoAgentPageHandler::LoadChats(LoadChatsCallback callback) {
  ReadDittoFile(DittoFile(web_contents_, FILE_PATH_LITERAL("chats.json")),
                std::move(callback));
}

void DittoAgentPageHandler::SaveChats(const std::string& json) {
  WriteDittoFile(DittoFile(web_contents_, FILE_PATH_LITERAL("chats.json")),
                 json);
}

void DittoAgentPageHandler::LoadMemory(LoadMemoryCallback callback) {
  ReadDittoFile(DittoFile(web_contents_, FILE_PATH_LITERAL("memory.json")),
                std::move(callback));
}

void DittoAgentPageHandler::SaveMemory(const std::string& json) {
  WriteDittoFile(DittoFile(web_contents_, FILE_PATH_LITERAL("memory.json")),
                 json);
}

void DittoAgentPageHandler::SearchUserPages(const std::string& query,
                                            int32_t max_results,
                                            SearchUserPagesCallback callback) {
  const size_t max = static_cast<size_t>(std::clamp(max_results, 1, 50));
  Profile* profile =
      Profile::FromBrowserContext(web_contents_->GetBrowserContext());
  std::vector<mojom::SavedPagePtr> pages;
  std::set<GURL> seen;
  const std::u16string text = base::UTF8ToUTF16(query);

  bookmarks::BookmarkModel* model =
      BookmarkModelFactory::GetForBrowserContext(profile);
  if (model && model->loaded() && !text.empty()) {
    bookmarks::QueryFields fields;
    fields.word_phrase_query = std::make_unique<std::u16string>(text);
    for (const bookmarks::BookmarkNode* node :
         bookmarks::GetBookmarksMatchingProperties(model, fields, max)) {
      if (node->url().SchemeIsHTTPOrHTTPS() && seen.insert(node->url()).second) {
        pages.push_back(mojom::SavedPage::New(
            node->url().spec(), base::UTF16ToUTF8(node->GetTitle()),
            ToUnixMs(node->date_added()), /*bookmark=*/true));
      }
    }
  }

  history::HistoryService* history = HistoryServiceFactory::GetForProfile(
      profile, ServiceAccessType::EXPLICIT_ACCESS);
  if (!history) {
    std::move(callback).Run(std::move(pages));
    return;
  }
  history::QueryOptions options;
  options.max_count = static_cast<int>(max);
  options.begin_time = base::Time::Now() - base::Days(90);
  options.duplicate_policy = history::QueryOptions::REMOVE_ALL_DUPLICATES;
  history->QueryHistory(
      text, options,
      base::BindOnce(
          [](std::vector<mojom::SavedPagePtr> pages, std::set<GURL> seen,
             size_t max, SearchUserPagesCallback callback,
             history::QueryResults results) {
            for (const history::URLResult& result : results) {
              if (pages.size() >= 2 * max) {
                break;
              }
              if (result.url().SchemeIsHTTPOrHTTPS() &&
                  seen.insert(result.url()).second) {
                pages.push_back(mojom::SavedPage::New(
                    result.url().spec(), base::UTF16ToUTF8(result.title()),
                    ToUnixMs(result.visit_time()), /*bookmark=*/false));
              }
            }
            std::move(callback).Run(std::move(pages));
          },
          std::move(pages), std::move(seen), max, std::move(callback)),
      &history_tracker_);
}

void DittoAgentPageHandler::ShowAgentPanel(const std::string& query,
                                           const std::string& chat_id) {
  BrowserWindowInterface* window = Window();
  if (!window) {
    return;
  }
  PendingHandOffs()[window] = {query, chat_id};
  ShowAgentSidePanel(window);
  // A panel already open in this window takes it now; a new one takes it
  // when it loads.
  for (DittoAgentPageHandler* handler : LiveHandlers()) {
    if (handler != this && handler->Window() == window) {
      handler->page_->OnHandOff();
    }
  }
}

void DittoAgentPageHandler::TakeHandOff(TakeHandOffCallback callback) {
  auto& pending = PendingHandOffs();
  auto it = pending.find(Window());
  if (it == pending.end()) {
    std::move(callback).Run("", "");
    return;
  }
  HandOff hand_off = std::move(it->second);
  pending.erase(it);
  std::move(callback).Run(hand_off.query, hand_off.chat_id);
}

void DittoAgentPageHandler::ImportFromChrome(
    ImportFromChromeCallback callback) {
  ReadChromeProfile(base::BindOnce(&DittoAgentPageHandler::OnChromeProfileRead,
                                   weak_factory_.GetWeakPtr(),
                                   std::move(callback)));
}

void DittoAgentPageHandler::OnChromeProfileRead(
    ImportFromChromeCallback callback,
    ChromeProfile chrome) {
  bookmarks::BookmarkModel* model = BookmarkModelFactory::GetForBrowserContext(
      web_contents_->GetBrowserContext());
  const bool found = chrome.bookmark_roots.has_value();
  int added = 0;
  if (found && model && model->loaded()) {
    added = AddChromeBookmarks(model, *chrome.bookmark_roots);
  }
  std::move(callback).Run(found, added, chrome.email);
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

void DittoAgentPageHandler::GetSearchUrl(GetSearchUrlCallback callback) {
  TemplateURLService* service = TemplateURLServiceFactory::GetForProfile(
      Profile::FromBrowserContext(web_contents_->GetBrowserContext()));
  const TemplateURL* engine =
      service ? service->GetDefaultSearchProvider() : nullptr;
  if (!engine) {
    std::move(callback).Run("");
    return;
  }
  // Expand the engine's template with a marker, then hand the agent a plain
  // `%s` template.
  static constexpr char kMarker[] = "DITTOSEARCHTERMS";
  std::string url = engine->url_ref().ReplaceSearchTerms(
      TemplateURLRef::SearchTermsArgs(base::ASCIIToUTF16(kMarker)),
      service->search_terms_data());
  if (!GURL(url).SchemeIsHTTPOrHTTPS() || url.find(kMarker) == std::string::npos) {
    std::move(callback).Run("");
    return;
  }
  base::ReplaceFirstSubstringAfterOffset(&url, 0, kMarker, "%s");
  std::move(callback).Run(url);
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
