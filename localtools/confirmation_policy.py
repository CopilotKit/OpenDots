"""Read owner confirmation settings on every action, without restarting MCP."""
import json
from pathlib import Path


def confirmations_required(path: Path, default: bool = True) -> bool:
    try:
        policy = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(policy, dict) or set(policy) != {"mode"}:
            return True
        return policy.get("mode") != "unattended"
    except FileNotFoundError:
        return default
    except (OSError, ValueError):
        return True
