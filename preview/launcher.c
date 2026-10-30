// Ditto preview launcher: the main executable of Ditto.app.
//
// The preview build ships an official open-source Chromium build with the
// Ditto agent as a built-in extension. This launcher runs first; it
//  1. registers the native messaging host that starts the local model
//     runtime on demand (the agent extension talks to it),
//  2. on first run, turns on Ditto's defaults (vertical tabs, Memory Saver),
//  3. execs Chromium with the agent extension and Ditto's feature flags.
// exec keeps the same process, so macOS treats the browser as Ditto.app
// (Dock, "open with", default browser).

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

#define EXTENSION_ID "gmnabdkkiapgiceenfljnbpgblepapmo"
#define HOST_NAME "app.ditto.runtime"

static void die(const char* what) {
  fprintf(stderr, "Ditto launcher: %s: %s\n", what, strerror(errno));
  exit(1);
}

static void join(char* out, size_t size, const char* a, const char* b) {
  if (snprintf(out, size, "%s/%s", a, b) >= (int)size) {
    fprintf(stderr, "Ditto launcher: path too long\n");
    exit(1);
  }
}

static void dirname_in_place(char* path) {
  char* slash = strrchr(path, '/');
  if (slash && slash != path) {
    *slash = '\0';
  }
}

// mkdir -p
static void make_dirs(const char* path) {
  char buffer[PATH_MAX];
  snprintf(buffer, sizeof(buffer), "%s", path);
  for (char* p = buffer + 1; *p; ++p) {
    if (*p == '/') {
      *p = '\0';
      mkdir(buffer, 0755);
      *p = '/';
    }
  }
  if (mkdir(buffer, 0755) != 0 && errno != EEXIST) {
    die(path);
  }
}

static void write_file(const char* path, const char* contents) {
  FILE* file = fopen(path, "w");
  if (!file) {
    die(path);
  }
  fputs(contents, file);
  fclose(file);
}

static int exists(const char* path) {
  struct stat info;
  return stat(path, &info) == 0;
}

// The executable's own path, symlinks resolved.
static void self_path(char* out) {
  char raw[PATH_MAX];
#if defined(__APPLE__)
  uint32_t size = sizeof(raw);
  if (_NSGetExecutablePath(raw, &size) != 0) {
    die("executable path");
  }
#else
  ssize_t length = readlink("/proc/self/exe", raw, sizeof(raw) - 1);
  if (length < 0) {
    die("executable path");
  }
  raw[length] = '\0';
#endif
  if (!realpath(raw, out)) {
    die("realpath");
  }
}

// The profile directory Chromium will use: --user-data-dir if given, else
// the default for CrProductDirName=Ditto (set in Info.plist).
static void user_data_dir(int argc, char** argv, char* out) {
  const char prefix[] = "--user-data-dir=";
  for (int i = 1; i < argc; ++i) {
    if (strncmp(argv[i], prefix, sizeof(prefix) - 1) == 0) {
      snprintf(out, PATH_MAX, "%s", argv[i] + sizeof(prefix) - 1);
      return;
    }
  }
  const char* home = getenv("HOME");
  if (!home) {
    errno = ENOENT;
    die("HOME");
  }
#if defined(__APPLE__)
  snprintf(out, PATH_MAX, "%s/Library/Application Support/Ditto", home);
#else
  snprintf(out, PATH_MAX, "%s/.config/ditto", home);
#endif
}

// Copies `in` into `out` as the inside of a JSON string.
static void json_escape(char* out, size_t size, const char* in) {
  size_t n = 0;
  for (; *in && n + 2 < size; ++in) {
    if (*in == '"' || *in == '\\') {
      out[n++] = '\\';
    }
    out[n++] = *in;
  }
  out[n] = '\0';
}

// Chromium only runs native hosts listed in <user data>/NativeMessagingHosts.
// Rewritten every launch so moving the app keeps it working.
static void register_host(const char* data_dir, const char* host_path) {
  char dir[PATH_MAX];
  char manifest[PATH_MAX];
  char json[PATH_MAX * 3];
  char escaped[PATH_MAX * 2];
  json_escape(escaped, sizeof(escaped), host_path);
  join(dir, sizeof(dir), data_dir, "NativeMessagingHosts");
  make_dirs(dir);
  join(manifest, sizeof(manifest), dir, HOST_NAME ".json");
  snprintf(json, sizeof(json),
           "{\n"
           "  \"name\": \"" HOST_NAME "\",\n"
           "  \"description\": \"Ditto local model runtime\",\n"
           "  \"path\": \"%s\",\n"
           "  \"type\": \"stdio\",\n"
           "  \"allowed_origins\": [\"chrome-extension://" EXTENSION_ID "/\"]\n"
           "}\n",
           escaped);
  write_file(manifest, json);
}

// First run only: Ditto's defaults. Never touches an existing profile.
static void seed_defaults(const char* data_dir) {
  char path[PATH_MAX];
  char profile[PATH_MAX];
  join(path, sizeof(path), data_dir, "Local State");
  if (!exists(path)) {
    write_file(path,
               "{\"performance_tuning\":{\"high_efficiency_mode\":"
               "{\"enabled\":true,\"state\":2}}}\n");
  }
  join(profile, sizeof(profile), data_dir, "Default");
  join(path, sizeof(path), profile, "Preferences");
  if (!exists(path)) {
    make_dirs(profile);
    write_file(path, "{\"vertical_tabs\":{\"enabled\":true}}\n");
  }
}

int main(int argc, char** argv) {
  char self[PATH_MAX];
  char contents[PATH_MAX];
  char chromium[PATH_MAX];
  char resources[PATH_MAX];
  char extension[PATH_MAX];
  char host[PATH_MAX];
  char data_dir[PATH_MAX];
  char load_extension[PATH_MAX + 32];

  self_path(self);
  snprintf(contents, sizeof(contents), "%s", self);
  dirname_in_place(contents);  // .../Contents/MacOS
  dirname_in_place(contents);  // .../Contents
  join(chromium, sizeof(chromium), contents, "MacOS/Chromium");
  join(resources, sizeof(resources), contents, "Resources/ditto");
  join(extension, sizeof(extension), resources, "extension");
  join(host, sizeof(host), resources, "runtime-host.sh");
  user_data_dir(argc, argv, data_dir);

  make_dirs(data_dir);
  register_host(data_dir, host);
  seed_defaults(data_dir);
  // The host stores models and logs next to the profile.
  setenv("DITTO_DATA_DIR", data_dir, 1);

  snprintf(load_extension, sizeof(load_extension), "--load-extension=%s",
           extension);
  const char* fixed[] = {
      load_extension,
      // The agent drives tabs through chrome.debugger; no infobar for it.
      "--silent-debugger-extension-api",
      // Google's cloud assistant surfaces; Ditto's agent is local.
      "--disable-features=Glic,GlicActor,GlicRollout,LensOverlay",
  };
  const int fixed_count = sizeof(fixed) / sizeof(fixed[0]);
  char** args = calloc((size_t)(argc + fixed_count + 1), sizeof(char*));
  if (!args) {
    die("calloc");
  }
  int n = 0;
  args[n++] = chromium;
  for (int i = 0; i < fixed_count; ++i) {
    args[n++] = (char*)fixed[i];
  }
  for (int i = 1; i < argc; ++i) {
    args[n++] = argv[i];
  }
  args[n] = NULL;

  if (getenv("DITTO_LAUNCHER_PRINT")) {
    for (int i = 0; i < n; ++i) {
      printf("%s\n", args[i]);
    }
    return 0;
  }
  execv(chromium, args);
  die(chromium);
}
