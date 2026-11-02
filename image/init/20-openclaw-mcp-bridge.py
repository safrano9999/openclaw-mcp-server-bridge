#!/usr/bin/env python3
"""Inject the shared bridge credential and preferences after OpenClaw configuration."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

PLUGIN = "openclaw-mcp-server-bridge"
FIELDS = {"OPENCLAW_MCP_BRIDGE_BEARER": "bearer", "OPENCLAW_DEFAULT_CHANNEL": "defaultChannel"}
FLAGS = {"OPENCLAW_MCP_BRIDGE_DIRECT": "direct", "OPENCLAW_MCP_BRIDGE_DIRECT_FIFO": "directFifo"}

def configure(environ=os.environ, runner=subprocess.run):
    state = environ.get("OPENCLAW_STATE_DIR") or environ.get("OPENCLAW_HOME")
    root = Path(state) if state else Path(environ.get("HOME", "/root")) / ".openclaw"
    path = Path(environ.get("OPENCLAW_CONFIG") or environ.get("OPENCLAW_CONFIG_PATH") or root / "openclaw.json").expanduser().resolve()
    config = json.loads(path.read_text())
    entry = config.get("plugins", {}).get("entries", {}).get(PLUGIN)
    if entry is None:
        raise ValueError("MCP bridge must be installed before initialization")
    previous = entry.get("config", {})
    # One-time removal of the obsolete per-agent credential configuration.
    updated = {key: value for key, value in previous.items() if key not in {"agentIds", "credentials"}}
    for variable, field in FIELDS.items():
        if variable in environ:
            value = environ[variable].strip()
            pattern = r"[A-Za-z0-9_-]{43,128}" if field == "bearer" else r"[a-z0-9][a-z0-9_-]{0,63}"
            if value and not re.fullmatch(pattern, value):
                raise ValueError(f"Invalid {variable}")
            updated[field] = value
    if previous.get("credentials") and not updated.get("bearer"):
        raise ValueError("Inject OPENCLAW_MCP_BRIDGE_BEARER before migrating per-agent credentials")
    for variable, field in FLAGS.items():
        if variable in environ:
            value = environ[variable].strip().lower()
            if value not in {"true", "false", "1", "0"}:
                raise ValueError(f"{variable} must be true or false")
            updated[field] = value in {"true", "1"}
    if previous == updated:
        return False
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as batch:
        json.dump([{"path": f"plugins.entries.{PLUGIN}.config", "value": updated}], batch)
        batch.flush()
        runner(["openclaw", "config", "set", "--batch-file", batch.name], check=True,
               env={**environ, "OPENCLAW_CONFIG": str(path), "OPENCLAW_CONFIG_PATH": str(path)})
    print("MCP bridge initialized with shared authentication and OpenClaw routing defaults")
    return True

if __name__ == "__main__":
    configure()
