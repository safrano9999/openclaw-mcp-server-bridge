#!/usr/bin/env python3
"""Apply injected agent/bearer pairs after config generation, before the gateway."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


PLUGIN = "openclaw-mcp-server-bridge"
PREFIX = "OPENCLAW_MCP_BRIDGE_"
PAIR_KEY = re.compile(r"^OPENCLAW_MCP_BRIDGE_(?:AGENT|BEARER)(_[0-9]+)?$")
TOKEN = re.compile(r"[A-Za-z0-9_-]{43,128}")
FLAGS = {"OPENCLAW_MCP_BRIDGE_DIRECT": "direct", "OPENCLAW_MCP_BRIDGE_DIRECT_FIFO": "directFifo"}


def selected_pairs(environ, config):
    suffixes = {match.group(1) or "" for key in environ if (match := PAIR_KEY.fullmatch(key))}
    known = set(config.get("agents", {}).get("entries", {}))
    known.update(agent["id"] for agent in config.get("agents", {}).get("list", []))
    credentials = {}
    for suffix in sorted(suffixes, key=lambda s: (int(s[1:]) if s else -1, s)):
        name = environ.get(f"{PREFIX}AGENT{suffix}", "").strip()
        token = environ.get(f"{PREFIX}BEARER{suffix}", "").strip()
        if not name or not token or name not in known:
            print(f"MCP bridge: skipped pair {suffix or 'default'} (unknown agent or incomplete pair)")
            continue
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", name) or not TOKEN.fullmatch(token):
            raise ValueError(f"MCP bridge: invalid agent or bearer in pair {suffix or 'default'}")
        if name in credentials or token in credentials.values():
            raise ValueError("MCP bridge: agent IDs and bearers must be unique")
        credentials[name] = token
    if len(credentials) > 64:
        raise ValueError("MCP bridge: at most 64 agent/bearer pairs are supported")
    return list(credentials), credentials


def configure(environ=os.environ, runner=subprocess.run):
    # An absent variable leaves independently managed bare-metal config intact.
    has_pairs = any(PAIR_KEY.fullmatch(key) for key in environ)
    if not has_pairs and not any(key in environ for key in FLAGS):
        return False
    state = environ.get("OPENCLAW_STATE_DIR") or environ.get("OPENCLAW_HOME")
    default = Path(state) if state else Path(environ.get("HOME", "/root")) / ".openclaw"
    path = Path(environ.get("OPENCLAW_CONFIG") or environ.get("OPENCLAW_CONFIG_PATH") or default / "openclaw.json").expanduser().resolve()
    config = json.loads(path.read_text())
    ids, credentials = selected_pairs(environ, config)
    entry = config.get("plugins", {}).get("entries", {}).get(PLUGIN)
    if entry is None:
        if ids:
            raise ValueError("MCP bridge must be installed and registered before initialization")
        return False
    previous = entry.get("config", {})
    updated = {**previous}
    if has_pairs:
        updated.update(agentIds=ids, credentials=credentials)
    for key, field in FLAGS.items():
        if key in environ:
            value = environ[key].strip().lower()
            if value not in ("true", "false", "1", "0"):
                raise ValueError(f"{key} must be true or false")
            updated[field] = value in ("true", "1")
    if previous == updated:
        return False
    # A private batch file keeps bearer values out of command-line arguments.
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as batch:
        json.dump([{"path": f"plugins.entries.{PLUGIN}.config", "value": updated}], batch)
        batch.flush()
        runner(["openclaw", "config", "set", "--batch-file", batch.name], check=True,
               env={**environ, "OPENCLAW_CONFIG": str(path), "OPENCLAW_CONFIG_PATH": str(path)})
    print(f"MCP bridge initialized: {len(ids)} selected agent(s)")
    return True


if __name__ == "__main__":
    configure()
