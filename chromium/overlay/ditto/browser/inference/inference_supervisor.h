// Copyright 2026 The Ditto Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef DITTO_BROWSER_INFERENCE_INFERENCE_SUPERVISOR_H_
#define DITTO_BROWSER_INFERENCE_INFERENCE_SUPERVISOR_H_

#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/memory_pressure_listener.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/observer_list.h"
#include "base/process/process.h"
#include "base/timer/timer.h"

namespace network {
class SimpleURLLoader;
}

namespace ditto {

// Owns the local model runtime: the bundled llama-server, run in router mode
// so it can download, load, swap and unload models on demand.
//
// RAM policy:
//  - nothing runs until the agent is first used, and nothing runs at all
//    while every model is disabled;
//  - the router keeps at most two models resident and unloads LRU models to
//    leave `memory margin` free; idle models are put to sleep;
//  - on memory pressure, observers (the agent UI) unload the responder
//    first; with no UI open, the whole runtime is stopped;
//  - the runtime stops after kIdleShutdown without any client.
//
// The runtime listens on a random loopback port and requires a per-launch
// API key that never leaves the browser process, so web pages cannot use it.
class InferenceSupervisor : public base::MemoryPressureListener {
 public:
  class Observer : public base::CheckedObserver {
   public:
    virtual void OnRuntimeMemoryPressure(
        base::MemoryPressureLevel level) = 0;
  };

  struct Response {
    int status = 0;
    std::string body;
  };
  using FetchCallback = base::OnceCallback<void(Response)>;
  using ChunkCallback = base::RepeatingCallback<void(std::string_view)>;

  enum class Target { kRuntime, kStrandsSidecar };

  static InferenceSupervisor* GetInstance();

  InferenceSupervisor(const InferenceSupervisor&) = delete;
  InferenceSupervisor& operator=(const InferenceSupervisor&) = delete;

  // Starts the runtime if needed. `preset_ini` is the router preset generated
  // by the agent's model catalog (@ditto/agent routerPresetIni()).
  void EnsureStarted(const std::string& preset_ini,
                     size_t memory_margin_mb,
                     base::OnceCallback<void(bool)> done);
  void Stop();
  bool is_running() const { return process_.IsValid(); }

  // Clients keep the runtime alive; it stops kIdleShutdown after the last
  // one goes away.
  void AddClient(Observer* observer);
  void RemoveClient(Observer* observer);

  void SetStrandsEndpoint(const std::string& url);

  // HTTP to the runtime (or the strands sidecar). `path` must start with '/'.
  void Fetch(Target target,
             const std::string& method,
             const std::string& path,
             const std::string& body,
             FetchCallback callback);
  // POST with a server-sent-events reply, delivered in raw chunks.
  void FetchStream(Target target,
                   const std::string& path,
                   const std::string& body,
                   ChunkCallback on_chunk,
                   FetchCallback on_complete);

 private:
  friend class base::NoDestructor<InferenceSupervisor>;
  class StreamConsumer;

  InferenceSupervisor();
  ~InferenceSupervisor() override;

  // base::MemoryPressureListener:
  void OnMemoryPressure(base::MemoryPressureLevel level) override;

  base::FilePath ModelsDir() const;
  void OnLaunched(std::optional<std::pair<base::Process, int>> launched);
  void MaybeScheduleIdleShutdown();
  std::optional<std::string> BaseUrl(Target target) const;

  base::Process process_;
  int port_ = 0;
  std::string api_key_;
  std::string strands_endpoint_ = "http://127.0.0.1:8737";
  bool starting_ = false;
  std::vector<base::OnceCallback<void(bool)>> pending_starts_;

  base::ObserverList<Observer> clients_;
  base::OneShotTimer idle_timer_;
  std::optional<base::MemoryPressureListenerRegistration>
      memory_pressure_registration_;

  base::WeakPtrFactory<InferenceSupervisor> weak_factory_{this};
};

}  // namespace ditto

#endif  // DITTO_BROWSER_INFERENCE_INFERENCE_SUPERVISOR_H_
