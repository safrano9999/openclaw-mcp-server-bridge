#!/usr/bin/env python3
"""Apply the injected agent CSV after configuration generation, before the gateway."""
import json
import os
from pathlib import Path
import re
import subprocess


PLUGIN = "openclaw-mcp-server-bridge"
VARIABLE = "OPENCLAW_MCP_BRIDGE_AGENTS"


def selected_agents(value, config):
    ids = list(dict.fromkeys(part.strip() for part in value.split(",") if part.strip()))
    if len(ids) > 64 or any(not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", name) for name in ids):
        raise ValueError(f"{VARIABLE} must contain valid agent IDs")
    known = set(config.get("agents", {}).get("entries", {}))
    known.update(agent["id"] for agent in config.get("agents", {}).get("list", []))
    if any(name not in known for name in ids):
        raise ValueError(f"{VARIABLE} contains an unknown agent")
    return ids


def configure(environ=os.environ, runner=subprocess.run):
    # An absent variable leaves independently managed bare-metal config intact.
    if VARIABLE not in environ:
        return False
    state = environ.get("OPENCLAW_STATE_DIR") or environ.get("OPENCLAW_HOME")
    default = Path(state) if state else Path(environ.get("HOME", "/root")) / ".openclaw"
    path = Path(environ.get("OPENCLAW_CONFIG") or environ.get("OPENCLAW_CONFIG_PATH") or default / "openclaw.json").expanduser().resolve()
    config = json.loads(path.read_text())
    ids = selected_agents(environ[VARIABLE], config)
    entry = config.get("plugins", {}).get("entries", {}).get(PLUGIN)
    if entry is None:
        if ids:
            raise ValueError("MCP bridge must be installed and registered before initialization")
        return False
    if entry.get("config", {}).get("agentIds", []) == ids:
        return False
    runner(["openclaw", "config", "set", f"plugins.entries.{PLUGIN}.config.agentIds",
            json.dumps(ids), "--strict-json"], check=True,
           env={**environ, "OPENCLAW_CONFIG": str(path), "OPENCLAW_CONFIG_PATH": str(path)})
    print(f"MCP bridge initialized: {len(ids)} selected agent(s)")
    return True


if __name__ == "__main__":
    configure()
