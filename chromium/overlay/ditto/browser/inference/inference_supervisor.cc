// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "ditto/browser/inference/inference_supervisor.h"

#include <utility>

#include "base/at_exit.h"
#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/logging.h"
#include "base/path_service.h"
#include "base/process/launch.h"
#include "base/process/process_handle.h"
#include "base/rand_util.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/task/thread_pool.h"
#include "build/build_config.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/net/system_network_context_manager.h"
#include "chrome/common/chrome_paths.h"
#include "net/base/ip_endpoint.h"
#include "net/base/net_errors.h"
#include "net/base/url_util.h"
#include "net/socket/tcp_server_socket.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/cpp/simple_url_loader_stream_consumer.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/gurl.h"

#if BUILDFLAG(IS_MAC)
#include "base/apple/bundle_locations.h"
#endif

namespace ditto {

namespace {

constexpr base::TimeDelta kIdleShutdown = base::Minutes(10);
// Idle models are put to sleep (weights released) after this long.
constexpr int kModelSleepSeconds = 300;
constexpr size_t kMaxResponseBytes = 8 * 1024 * 1024;
constexpr char kRuntimeName[] = "ditto-inference";

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("ditto_local_inference", R"(
      semantics {
        sender: "Ditto local inference"
        description:
          "Requests from the browser to the Ditto model runtime that runs on "
          "this computer (llama-server on a loopback port). Model downloads "
          "are made by that runtime, from Hugging Face, when the user picks "
          "a model in the agent panel."
        trigger: "The user runs the Ditto agent or manages models."
        data: "Prompts, page text and decision questions; never leaves the "
              "device."
        destination: LOCAL
      }
      policy {
        cookies_allowed: NO
        setting: "Ditto agent panel > Models > Disable all models."
        policy_exception_justification: "Loopback only."
      })");

base::FilePath RuntimeExecutable() {
#if BUILDFLAG(IS_MAC)
  // Ditto.app/Contents/Frameworks/Ditto Framework.framework/Helpers/
  return base::apple::FrameworkBundlePath()
      .Append("Helpers")
      .Append(kRuntimeName);
#else
  base::FilePath dir;
  base::PathService::Get(base::DIR_EXE, &dir);
  return dir.Append(kRuntimeName);
#endif
}

// Binds an ephemeral loopback port to learn a free one. The runtime binds it
// right after; a collision just fails the launch, and the next use retries.
int PickFreePort() {
  net::TCPServerSocket socket(nullptr, net::NetLogSource());
  if (socket.Listen(net::IPEndPoint(net::IPAddress::IPv4Localhost(), 0),
                    /*backlog=*/1, /*ipv6_only=*/std::nullopt) != net::OK) {
    return 0;
  }
  net::IPEndPoint address;
  return socket.GetLocalAddress(&address) == net::OK ? address.port() : 0;
}

// Ends a runtime left behind by a crashed browser, so it cannot hold RAM
// indefinitely. Only kills the process if it still is our runtime.
void KillStaleRuntime(const base::FilePath& pid_file) {
  std::string contents;
  int pid = 0;
  if (!base::ReadFileToString(pid_file, &contents) ||
      !base::StringToInt(base::TrimWhitespaceASCII(contents, base::TRIM_ALL),
                         &pid) ||
      pid <= 0) {
    return;
  }
  base::Process stale = base::Process::Open(pid);
  if (stale.IsValid() &&
      base::GetProcessExecutablePath(stale.Handle()).BaseName().value() ==
          kRuntimeName) {
    stale.Terminate(0, /*wait=*/true);
  }
  base::DeleteFile(pid_file);
}

std::optional<std::pair<base::Process, int>> LaunchRuntime(
    base::FilePath models_dir,
    std::string preset_ini,
    std::string api_key,
    size_t memory_margin_mb) {
  const base::FilePath pid_file = models_dir.Append("runtime.pid");
  KillStaleRuntime(pid_file);

  const base::FilePath executable = RuntimeExecutable();
  if (!base::PathExists(executable)) {
    LOG(ERROR) << "Ditto runtime missing at " << executable;
    return std::nullopt;
  }
  if (!base::CreateDirectory(models_dir)) {
    return std::nullopt;
  }
  const base::FilePath preset = models_dir.Append("preset.ini");
  if (!base::WriteFile(preset, preset_ini)) {
    return std::nullopt;
  }
  const int port = PickFreePort();
  if (!port) {
    return std::nullopt;
  }

  base::CommandLine command(executable);
  command.AppendSwitchASCII("host", "127.0.0.1");
  command.AppendSwitchASCII("port", base::NumberToString(port));
  command.AppendSwitchASCII("api-key", api_key);
  command.AppendSwitchPath("models-preset", preset);
  // One responder and one decider resident; LRU beyond that.
  command.AppendSwitchASCII("models-max", "2");
  command.AppendSwitchASCII("models-memory-margin",
                            base::NumberToString(memory_margin_mb));
  command.AppendSwitchASCII("sleep-idle-seconds",
                            base::NumberToString(kModelSleepSeconds));
  command.AppendSwitch("no-webui");

  base::LaunchOptions options;
  // Downloads and the router's cache live in the profile, not ~/Library.
  options.environment["LLAMA_CACHE"] = models_dir.value();
#if BUILDFLAG(IS_POSIX)
  // Own process group: a browser crash does not take signals meant for it.
  options.new_process_group = true;
#endif
  base::Process process = base::LaunchProcess(command, options);
  if (!process.IsValid()) {
    return std::nullopt;
  }
  base::WriteFile(pid_file, base::NumberToString(process.Pid()));
  return std::make_pair(std::move(process), port);
}

}  // namespace

// Feeds a streamed response to the caller chunk by chunk and owns the loader
// until the response ends.
class InferenceSupervisor::StreamConsumer
    : public network::SimpleURLLoaderStreamConsumer {
 public:
  StreamConsumer(std::unique_ptr<network::SimpleURLLoader> loader,
                 ChunkCallback on_chunk,
                 FetchCallback on_complete)
      : loader_(std::move(loader)),
        on_chunk_(std::move(on_chunk)),
        on_complete_(std::move(on_complete)) {}

  void Start(network::mojom::URLLoaderFactory* factory) {
    loader_->DownloadAsStream(factory, this);
  }

  // network::SimpleURLLoaderStreamConsumer:
  void OnDataReceived(std::string_view data, base::OnceClosure resume) override {
    on_chunk_.Run(data);
    std::move(resume).Run();
  }

  void OnComplete(bool success) override {
    Response response;
    if (loader_->ResponseInfo() && loader_->ResponseInfo()->headers) {
      response.status = loader_->ResponseInfo()->headers->response_code();
    }
    if (!success && !response.status) {
      response.body = net::ErrorToString(loader_->NetError());
    }
    FetchCallback done = std::move(on_complete_);
    delete this;
    std::move(done).Run(std::move(response));
  }

  void OnRetry(base::OnceClosure start_retry) override { NOTREACHED(); }

 private:
  ~StreamConsumer() override = default;

  std::unique_ptr<network::SimpleURLLoader> loader_;
  ChunkCallback on_chunk_;
  FetchCallback on_complete_;
};

// static
InferenceSupervisor* InferenceSupervisor::GetInstance() {
  static base::NoDestructor<InferenceSupervisor> instance;
  return instance.get();
}

InferenceSupervisor::InferenceSupervisor() {
  memory_pressure_registration_.emplace(
      base::MemoryPressureListenerTag::kDittoInferenceSupervisor, this);
  // The runtime must not outlive the browser.
  base::AtExitManager::RegisterTask(base::BindOnce(
      [](base::WeakPtr<InferenceSupervisor> self) {
        if (self) {
          self->Stop();
        }
      },
      weak_factory_.GetWeakPtr()));
}

InferenceSupervisor::~InferenceSupervisor() = default;

base::FilePath InferenceSupervisor::ModelsDir() const {
  base::FilePath user_data;
  base::PathService::Get(chrome::DIR_USER_DATA, &user_data);
  return user_data.Append("Ditto Models");
}

void InferenceSupervisor::EnsureStarted(const std::string& preset_ini,
                                        size_t memory_margin_mb,
                                        base::OnceCallback<void(bool)> done) {
  if (process_.IsValid()) {
    std::move(done).Run(true);
    return;
  }
  pending_starts_.push_back(std::move(done));
  if (starting_) {
    return;
  }
  starting_ = true;
  api_key_ = base::HexEncode(base::RandBytesAsVector(24));
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE,
      {base::MayBlock(), base::TaskPriority::USER_BLOCKING,
       base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN},
      base::BindOnce(&LaunchRuntime, ModelsDir(), preset_ini, api_key_,
                     memory_margin_mb),
      base::BindOnce(&InferenceSupervisor::OnLaunched,
                     weak_factory_.GetWeakPtr()));
}

void InferenceSupervisor::OnLaunched(
    std::optional<std::pair<base::Process, int>> launched) {
  starting_ = false;
  const bool ok = launched.has_value();
  if (ok) {
    process_ = std::move(launched->first);
    port_ = launched->second;
    MaybeScheduleIdleShutdown();
  }
  for (auto& callback : std::exchange(pending_starts_, {})) {
    std::move(callback).Run(ok);
  }
}

void InferenceSupervisor::Stop() {
  idle_timer_.Stop();
  if (!process_.IsValid()) {
    return;
  }
  // SIGTERM: the router stops its model instances and exits.
  process_.Terminate(0, /*wait=*/false);
  process_ = base::Process();
  port_ = 0;
  api_key_.clear();
  base::ThreadPool::PostTask(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::BEST_EFFORT},
      base::GetDeleteFileCallback(ModelsDir().Append("runtime.pid")));
}

void InferenceSupervisor::AddClient(Observer* observer) {
  clients_.AddObserver(observer);
  idle_timer_.Stop();
}

void InferenceSupervisor::RemoveClient(Observer* observer) {
  clients_.RemoveObserver(observer);
  MaybeScheduleIdleShutdown();
}

void InferenceSupervisor::MaybeScheduleIdleShutdown() {
  if (clients_.empty() && process_.IsValid()) {
    idle_timer_.Start(FROM_HERE, kIdleShutdown,
                      base::BindOnce(&InferenceSupervisor::Stop,
                                     base::Unretained(this)));
  }
}

void InferenceSupervisor::OnMemoryPressure(base::MemoryPressureLevel level) {
  if (!process_.IsValid() ||
      level == base::MEMORY_PRESSURE_LEVEL_NONE) {
    return;
  }
  if (clients_.empty()) {
    // Nobody is using the agent: give all of its memory back.
    if (level == base::MEMORY_PRESSURE_LEVEL_CRITICAL) {
      Stop();
    }
    return;
  }
  for (Observer& client : clients_) {
    client.OnRuntimeMemoryPressure(level);
  }
}

void InferenceSupervisor::SetStrandsEndpoint(const std::string& url) {
  // Only loopback sidecars: page text must not leave the machine.
  GURL gurl(url);
  if (gurl.SchemeIsHTTPOrHTTPS() && net::IsLocalhost(gurl)) {
    strands_endpoint_ = gurl.spec();
  }
}

std::optional<std::string> InferenceSupervisor::BaseUrl(Target target) const {
  if (target == Target::kStrandsSidecar) {
    return std::string(base::TrimString(strands_endpoint_, "/",
                                        base::TRIM_TRAILING));
  }
  if (!process_.IsValid()) {
    return std::nullopt;
  }
  return "http://127.0.0.1:" + base::NumberToString(port_);
}

void InferenceSupervisor::Fetch(Target target,
                                const std::string& method,
                                const std::string& path,
                                const std::string& body,
                                FetchCallback callback) {
  std::optional<std::string> base_url = BaseUrl(target);
  if (!base_url || !path.starts_with('/')) {
    std::move(callback).Run({0, "runtime not running"});
    return;
  }
  auto request = std::make_unique<network::ResourceRequest>();
  request->url = GURL(*base_url + path);
  request->method = method;
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  if (target == Target::kRuntime) {
    request->headers.SetHeader("Authorization", "Bearer " + api_key_);
  }
  auto loader =
      network::SimpleURLLoader::Create(std::move(request), kTrafficAnnotation);
  // Errors carry useful JSON bodies.
  loader->SetAllowHttpErrorResults(true);
  if (!body.empty()) {
    loader->AttachStringForUpload(body, "application/json");
  }
  network::SimpleURLLoader* raw = loader.get();
  raw->DownloadToString(
      g_browser_process->system_network_context_manager()
          ->GetURLLoaderFactory(),
      base::BindOnce(
          [](std::unique_ptr<network::SimpleURLLoader> loader,
             FetchCallback callback, std::optional<std::string> body) {
            Response response;
            if (loader->ResponseInfo() && loader->ResponseInfo()->headers) {
              response.status =
                  loader->ResponseInfo()->headers->response_code();
            }
            response.body = body ? std::move(*body)
                                 : net::ErrorToString(loader->NetError());
            std::move(callback).Run(std::move(response));
          },
          std::move(loader), std::move(callback)),
      kMaxResponseBytes);
}

void InferenceSupervisor::FetchStream(Target target,
                                      const std::string& path,
                                      const std::string& body,
                                      ChunkCallback on_chunk,
                                      FetchCallback on_complete) {
  std::optional<std::string> base_url = BaseUrl(target);
  if (!base_url || !path.starts_with('/')) {
    std::move(on_complete).Run({0, "runtime not running"});
    return;
  }
  auto request = std::make_unique<network::ResourceRequest>();
  request->url = GURL(*base_url + path);
  request->method = "POST";
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  request->headers.SetHeader("Accept", "text/event-stream");
  if (target == Target::kRuntime) {
    request->headers.SetHeader("Authorization", "Bearer " + api_key_);
  }
  auto loader =
      network::SimpleURLLoader::Create(std::move(request), kTrafficAnnotation);
  loader->SetAllowHttpErrorResults(true);
  loader->AttachStringForUpload(body, "application/json");
  // Deletes itself in OnComplete().
  auto* consumer = new StreamConsumer(std::move(loader), std::move(on_chunk),
                                      std::move(on_complete));
  consumer->Start(g_browser_process->system_network_context_manager()
                      ->GetURLLoaderFactory());
}

}  // namespace ditto
