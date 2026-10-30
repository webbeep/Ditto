#!/usr/bin/env python3
"""Talks to the Ditto native messaging host the way Chromium does (CI only).

    host-call.py <runtime-host.sh>   -> prints {"port":..,"key":..}, keeps the
                                        host (and runtime) running until stdin closes
"""
import json
import struct
import subprocess
import sys

host = subprocess.Popen(["bash", sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE)


def call(message):
    data = json.dumps(message, separators=(",", ":")).encode()
    host.stdin.write(struct.pack("=I", len(data)) + data)
    host.stdin.flush()
    size = struct.unpack("=I", host.stdout.read(4))[0]
    return json.loads(host.stdout.read(size))


reply = call({"cmd": "start", "marginMb": 1024})
print(json.dumps(reply), flush=True)
if not reply.get("ok"):
    sys.exit(1)
sys.stdin.read()  # Hold the runtime until our caller closes our input.
host.stdin.close()
host.wait(timeout=30)
