"""LocalTools: a local MCP server for files, vision, object detection and PC control.

Every tool runs on this machine. Vision uses the local Ollama model; detection
uses YOLO on the GPU. Actions that change files or drive the mouse/keyboard ask
the person through a native Windows Yes/No dialog first. The owner can switch
to unattended actions in OpenDots Settings; the policy is read on each action.
LOCALTOOLS_CONFIRM supplies the default when no saved policy exists.

Run:  python server.py            (stdio, for OpenDots / Claude Code)
      python server.py --http     (streamable HTTP on 127.0.0.1:8765, for AJ)
"""

from __future__ import annotations

import base64
import ctypes
import fnmatch
import io
import os
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from confirmation_policy import confirmations_required

# Keep Ultralytics fully offline: no analytics sync or update checks.
os.environ.setdefault("YOLO_OFFLINE", "1")

import functools
import inspect
import json
import subprocess

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

HOME = Path.home()
ROOTS = [
    Path(p).expanduser().resolve()
    for p in os.environ.get("LOCALTOOLS_ROOTS", str(HOME)).split(os.pathsep)
    if p
]
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
VISION_MODEL = os.environ.get("LOCALTOOLS_VISION_MODEL", "qwen3-vl:8b")
YOLO_MODEL = os.environ.get("LOCALTOOLS_YOLO_MODEL", "yolo11n.pt")
CONFIRM = os.environ.get("LOCALTOOLS_CONFIRM", "1") != "0"
CONFIRMATION_POLICY = Path(os.environ.get("LOCALTOOLS_CONFIRMATION_POLICY", Path(__file__).parent.parent / "data" / "confirmation-policy.json")).resolve()
OUTPUT_DIR = Path(
    os.environ.get("LOCALTOOLS_OUTPUT", Path(__file__).parent / "output")
)
MAX_READ = 200_000

mcp = MCPServer(
    "localtools",
    instructions=(
        "Local tools on the owner's Windows PC: files, image understanding, "
        "object detection, screenshots and mouse/keyboard control. Risky "
        "actions show the owner a confirmation dialog; if declined, do not retry "
        "the same action without asking. Paths are limited to allowed roots."
    ),
)


def tool():
    """Register a tool whose failures reach the model as readable messages.

    The MCP SDK hides unexpected exceptions behind "Error executing tool", which
    leaves the model guessing; re-raise them as ToolError with the real reason.
    """

    def register(fn):
        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def wrapper(*args, **kwargs):
                try:
                    return await fn(*args, **kwargs)
                except ToolError:
                    raise
                except Exception as error:
                    raise ToolError(f"{type(error).__name__}: {error}") from error

        else:

            @functools.wraps(fn)
            def wrapper(*args, **kwargs):
                try:
                    return fn(*args, **kwargs)
                except ToolError:
                    raise
                except Exception as error:
                    raise ToolError(f"{type(error).__name__}: {error}") from error

        return mcp.tool()(wrapper)

    return register


# ---------------------------------------------------------------- safety


def confirm(action: str) -> None:
    """Honor the owner's live confirmation mode. Raises if a prompt is declined."""
    if not confirmations_required(CONFIRMATION_POLICY, CONFIRM):
        return
    MB_YESNO, MB_ICONQUESTION, MB_TOPMOST, MB_SETFOREGROUND = 0x4, 0x20, 0x40000, 0x10000
    IDYES = 6
    answer = ctypes.windll.user32.MessageBoxW(
        None,
        f"An AI assistant wants to:\n\n{action}\n\nAllow this?",
        "LocalTools - confirm action",
        MB_YESNO | MB_ICONQUESTION | MB_TOPMOST | MB_SETFOREGROUND,
    )
    if answer != IDYES:
        raise PermissionError(f"The owner declined: {action}")


def safe_path(path: str) -> Path:
    resolved = Path(path).expanduser().resolve()
    if resolved == CONFIRMATION_POLICY:
        raise PermissionError("Confirmation settings are controlled through the OpenDots owner settings.")
    if not any(resolved == root or root in resolved.parents for root in ROOTS):
        raise PermissionError(
            f"{resolved} is outside the allowed roots: {', '.join(map(str, ROOTS))}"
        )
    return resolved


def positive(value: Any, default: Any) -> Any:
    """Models often fill optional numbers with 0 or empty values; use the default."""
    return value if isinstance(value, (int, float)) and value > 0 else default


def describe_entry(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "name": path.name,
        "path": str(path),
        "type": "dir" if path.is_dir() else "file",
        "size": stat.st_size if path.is_file() else None,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
    }


# ---------------------------------------------------------------- files


@tool()
def list_directory(path: str = "~", pattern: str = "*", limit: int = 200) -> dict:
    """List files and folders in a directory, optionally filtered by a glob pattern like '*.png'."""
    folder = safe_path(path or "~")
    pattern = pattern or "*"
    limit = positive(limit, 200)
    entries = [
        describe_entry(p)
        for p in sorted(folder.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        if fnmatch.fnmatch(p.name.lower(), pattern.lower())
    ]
    return {"path": str(folder), "count": len(entries), "entries": entries[:limit]}


@tool()
def find_files(root: str, pattern: str = "*", contains: str = "", limit: int = 100) -> dict:
    """Recursively search under root for files whose name matches a glob pattern, optionally containing text."""
    base = safe_path(root)
    pattern = pattern or "*"
    limit = positive(limit, 100)
    matches: list[dict] = []
    skip = {".git", "node_modules", ".venv", "__pycache__", "AppData"}
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in skip]
        for name in filenames:
            if not fnmatch.fnmatch(name.lower(), pattern.lower()):
                continue
            path = Path(dirpath) / name
            if contains:
                try:
                    if path.stat().st_size > 5_000_000 or contains.lower() not in path.read_text(
                        encoding="utf-8", errors="ignore"
                    ).lower():
                        continue
                except OSError:
                    continue
            matches.append(describe_entry(path))
            if len(matches) >= limit:
                return {"truncated": True, "matches": matches}
    return {"truncated": False, "matches": matches}


@tool()
def read_text_file(path: str, max_chars: int = 20_000) -> dict:
    """Read a text file (code, notes, logs, csv, json...)."""
    file = safe_path(path)
    text = file.read_text(encoding="utf-8", errors="replace")
    limit = min(positive(max_chars, 20_000), MAX_READ)
    return {"path": str(file), "truncated": len(text) > limit, "text": text[:limit]}


@tool()
def write_text_file(path: str, content: str, overwrite: bool = False) -> dict:
    """Create a text file. Overwriting an existing file asks the owner first."""
    file = safe_path(path)
    if file.exists():
        if not overwrite:
            raise FileExistsError(f"{file} exists; pass overwrite=true to replace it.")
        confirm(f"Overwrite file:\n{file}")
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content, encoding="utf-8")
    return {"written": str(file), "chars": len(content)}


@tool()
def make_directory(path: str) -> dict:
    """Create a folder (and any missing parents)."""
    folder = safe_path(path)
    folder.mkdir(parents=True, exist_ok=True)
    return {"created": str(folder)}


@tool()
def copy_path(source: str, destination: str) -> dict:
    """Copy a file or folder. Never overwrites an existing destination."""
    src, dst = safe_path(source), safe_path(destination)
    if dst.exists():
        raise FileExistsError(f"{dst} already exists.")
    if src.is_dir():
        shutil.copytree(src, dst)
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    return {"copied": str(src), "to": str(dst)}


@tool()
def move_paths(moves: list[dict[str, str]]) -> dict:
    """Move or rename files/folders. moves = [{"source": ..., "destination": ...}]. Asks the owner once for the whole batch."""
    pairs = [(safe_path(m["source"]), safe_path(m["destination"])) for m in moves]
    for src, dst in pairs:
        if not src.exists():
            raise FileNotFoundError(str(src))
        if dst.exists():
            raise FileExistsError(f"{dst} already exists.")
    preview = "\n".join(f"{s.name} -> {d}" for s, d in pairs[:15])
    more = f"\n...and {len(pairs) - 15} more" if len(pairs) > 15 else ""
    confirm(f"Move {len(pairs)} item(s):\n{preview}{more}")
    for src, dst in pairs:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
    return {"moved": len(pairs)}


@tool()
def delete_to_recycle_bin(paths: list[str]) -> dict:
    """Send files/folders to the Recycle Bin (recoverable). Asks the owner first."""
    from send2trash import send2trash

    targets = [safe_path(p) for p in paths]
    confirm("Move to Recycle Bin:\n" + "\n".join(str(t) for t in targets[:15]))
    for target in targets:
        send2trash(str(target))
    return {"recycled": [str(t) for t in targets]}


# ---------------------------------------------------------------- screen & vision


def _screenshot(monitor: int = 1):
    import mss
    from PIL import Image

    with mss.mss() as grab:
        shot = grab.grab(grab.monitors[monitor])
        return Image.frombytes("RGB", shot.size, shot.rgb)


def _load_image(path: str):
    from PIL import Image

    if path.lower() in ("screen", "screenshot"):
        return _screenshot()
    return Image.open(safe_path(path)).convert("RGB")


def _save(image, prefix: str) -> str:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUTPUT_DIR / f"{prefix}-{datetime.now():%Y%m%d-%H%M%S}.png"
    image.save(out)
    return str(out)


@tool()
def take_screenshot(monitor: int = 1) -> dict:
    """Capture the screen to a PNG file. Returns its path and size (use describe_image or detect_objects on it)."""
    image = _screenshot(positive(monitor, 1))
    return {"path": _save(image, "screen"), "width": image.width, "height": image.height}


@tool()
def ask_vision(image, question: str, think: bool = False, max_side: int = 1600, model: str | None = None) -> str:
    """Ask a local vision model (default: the vision role) a question about a PIL image."""
    image = image.copy()
    image.thumbnail((max_side, max_side))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    response = httpx.post(
        f"{OLLAMA_URL}/api/chat",
        json={
            "model": model or VISION_MODEL,
            "stream": False,
            "think": think,
            "options": {"temperature": 0},
            "messages": [
                {
                    "role": "user",
                    "content": question,
                    "images": [base64.b64encode(buffer.getvalue()).decode()],
                }
            ],
        },
        timeout=300,
    )
    response.raise_for_status()
    return response.json()["message"]["content"]


@tool()
def describe_image(path: str, question: str = "Describe this image in detail.", think: bool = False) -> dict:
    """Understand an image with the local vision model: describe it, read its text (OCR), answer questions.
    path can be an image file or 'screen' for the current screen.
    Defaults to direct observation without extended reasoning. Set think=True only
    for complex interpretation; this may take longer. Unreadable details are unknown."""
    question = question or "Describe this image in detail."
    answer = ask_vision(_load_image(path or "screen"), question, think=think)
    return {"model": VISION_MODEL, "answer": answer}


_yolo = None


@tool()
def detect_objects(path: str = "screen", confidence: float = 0.35, save_annotated: bool = True) -> dict:
    """Detect and locate objects (people, cars, cups, laptops... 80 COCO classes) with YOLO on the GPU.
    path can be an image file or 'screen'. Returns labels, confidence and pixel boxes."""
    global _yolo
    from ultralytics import YOLO, settings

    if _yolo is None:
        settings.update({"sync": False})
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        _yolo = YOLO(str(Path(__file__).parent / YOLO_MODEL) if (Path(__file__).parent / YOLO_MODEL).exists() else YOLO_MODEL)
    image = _load_image(path or "screen")
    result = _yolo.predict(image, conf=positive(confidence, 0.35), verbose=False)[0]
    objects = [
        {
            "label": result.names[int(box.cls)],
            "confidence": round(float(box.conf), 3),
            "box": [round(v) for v in box.xyxy[0].tolist()],
        }
        for box in result.boxes
    ]
    out: dict[str, Any] = {"count": len(objects), "objects": objects}
    if save_annotated:
        from PIL import Image

        out["annotated"] = _save(Image.fromarray(result.plot()[:, :, ::-1]), "detect")
    return out


# ---------------------------------------------------------------- web (opt-in)


@tool()
def web_search(query: str, max_results: int = 6) -> dict:
    """Search the public web with DuckDuckGo. The query is sent to DuckDuckGo; nothing else leaves the PC."""
    from ddgs import DDGS

    # DuckDuckGo only: ddgs otherwise fans out to several search engines.
    results = DDGS(timeout=20).text(
        query, max_results=min(positive(max_results, 6), 10), backend="duckduckgo"
    )
    return {
        "query": query,
        "results": [
            {"title": r.get("title"), "url": r.get("href"), "snippet": r.get("body")}
            for r in results
        ],
    }


@tool()
def fetch_page(url: str, max_chars: int = 12_000) -> dict:
    """Read a public web page and return its main text."""
    import re
    from html import unescape

    if not url.startswith(("http://", "https://")):
        raise ValueError("Only http(s) URLs can be fetched.")
    response = httpx.get(
        url,
        follow_redirects=True,
        timeout=20,
        headers={"User-Agent": "Mozilla/5.0 (LocalTools reader)"},
    )
    response.raise_for_status()
    html = response.text
    title = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    html = re.sub(r"(?is)<(script|style|noscript|svg|nav|footer|header)[^>]*>.*?</\1>", " ", html)
    text = unescape(re.sub(r"<[^>]+>", " ", html))
    text = re.sub(r"\s+", " ", text).strip()
    return {
        "url": str(response.url),
        "title": unescape(title.group(1).strip()) if title else "",
        "text": text[: min(positive(max_chars, 12_000), 50_000)],
    }


# ---------------------------------------------------------------- PC control


@tool()
def list_windows() -> dict:
    """List visible top-level windows with their titles and positions."""
    import pygetwindow as gw

    return {
        "windows": [
            {"title": w.title, "left": w.left, "top": w.top, "width": w.width, "height": w.height, "active": w.isActive}
            for w in gw.getAllWindows()
            if w.title.strip() and w.visible and w.width > 0
        ]
    }


@tool()
def focus_window(title_contains: str) -> dict:
    """Bring the first window whose title contains the text to the front."""
    import pygetwindow as gw

    matches = [w for w in gw.getAllWindows() if title_contains.lower() in w.title.lower()]
    if not matches:
        raise LookupError(f"No window title contains '{title_contains}'.")
    window = matches[0]
    if window.isMinimized:
        window.restore()
    window.activate()
    return {"focused": window.title}


@tool()
def mouse_click(x: int, y: int, button: str = "left", clicks: int = 1) -> dict:
    """Click at a screen pixel (x, y) in a DESKTOP app. Not for web pages in the Dots' browser: use
    browser_find + browser_click there (screen positions shift and miss). Asks the owner first."""
    import pyautogui

    confirm(f"{button}-click {clicks}x at ({x}, {y})")
    pyautogui.click(x=x, y=y, button=button, clicks=clicks, interval=0.1)
    return {"clicked": [x, y], "button": button, "clicks": clicks}


@tool()
def type_text(text: str) -> dict:
    """Type text into the focused window. Asks the owner first."""
    import pyautogui

    shown = text if len(text) <= 200 else text[:200] + "..."
    confirm(f"Type into the active window:\n\"{shown}\"")
    pyautogui.write(text, interval=0.01) if text.isascii() else _paste(text)
    return {"typed_chars": len(text)}


def _paste(text: str) -> None:
    import pyautogui
    import subprocess

    subprocess.run(["clip"], input=text.encode("utf-16le"), check=True)
    pyautogui.hotkey("ctrl", "v")


@tool()
def press_keys(keys: list[str]) -> dict:
    """Press a key or shortcut together, e.g. ["ctrl","s"], ["alt","tab"], ["enter"]. Asks the owner first."""
    import pyautogui

    confirm(f"Press keys: {' + '.join(keys)}")
    pyautogui.hotkey(*keys)
    return {"pressed": keys}


@tool()
def scroll(amount: int, x: int | None = None, y: int | None = None) -> dict:
    """Scroll the mouse wheel; positive = up, negative = down (about 120 per notch)."""
    import pyautogui

    pyautogui.scroll(amount, x=x, y=y)
    return {"scrolled": amount}


_apps_cache: tuple[float, list[dict]] = (0.0, [])


def _start_apps() -> list[dict]:
    """Installed apps from the Start menu (desktop and Store apps), cached."""
    global _apps_cache
    if time.time() - _apps_cache[0] < 120 and _apps_cache[1]:
        return _apps_cache[1]
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command", "Get-StartApps | ConvertTo-Json -Compress"],
        capture_output=True, text=True, timeout=30,
    ).stdout
    apps = json.loads(out or "[]")
    apps = [apps] if isinstance(apps, dict) else apps
    _apps_cache = (time.time(), [{"name": a["Name"], "id": a["AppID"]} for a in apps])
    return _apps_cache[1]


def _find_app(name: str) -> dict:
    wanted = name.lower().replace(" ", "")
    apps = _start_apps()
    for match in (
        lambda a: a["name"].lower() == name.lower(),
        lambda a: a["name"].lower().replace(" ", "") == wanted,
        lambda a: wanted in a["name"].lower().replace(" ", ""),
    ):
        found = [a for a in apps if match(a)]
        if found:
            return sorted(found, key=lambda a: len(a["name"]))[0]
    raise LookupError(
        f"No installed app matches '{name}'. Use list_apps to see what is installed."
    )


def _launch(app: dict) -> None:
    subprocess.Popen(["explorer.exe", "shell:AppsFolder\\" + app["id"]])


@tool()
def list_apps(query: str = "") -> dict:
    """List installed apps (Start menu), optionally filtered by name, e.g. 'browser', 'chrome', 'steam'."""
    apps = _start_apps()
    q = (query or "").lower()
    names = sorted({a["name"] for a in apps if q in a["name"].lower()})
    return {"count": len(names), "apps": names[:200]}


@tool()
def launch_app(name: str) -> dict:
    """Start an installed app by name (e.g. 'Google Chrome', 'DuckDuckGo', 'Steam', 'Blender'). Asks the owner first."""
    app = _find_app(name)
    confirm(f"Launch app: {app['name']}")
    _launch(app)
    time.sleep(1.5)
    return {"launched": app["name"]}


BROWSERS = {
    "chrome": ("chrome.exe", "Google Chrome"),
    "edge": ("msedge.exe", "Microsoft Edge"),
    "firefox": ("firefox.exe", "Firefox"),
    "brave": ("brave.exe", "Brave"),
    "duckduckgo": (None, "DuckDuckGo"),
}


def _app_path(exe: str) -> str | None:
    import winreg

    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}") as key:
                return winreg.QueryValue(key, None)
        except OSError:
            continue
    return None


def _default_browser() -> str:
    """Name of the app registered for https links, e.g. 'DuckDuckGo'."""
    import winreg

    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice",
        ) as key:
            prog_id = winreg.QueryValueEx(key, "ProgId")[0]
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, rf"{prog_id}\Application") as key:
            return winreg.QueryValueEx(key, "ApplicationName")[0]
    except OSError:
        return ""


@tool()
def open_url(url: str, browser: str = "") -> dict:
    """Open a website. browser: '' (default browser), 'chrome', 'edge', 'firefox', 'brave' or 'duckduckgo'. Asks the owner first."""
    url = url.strip()
    if not url.lower().startswith(("http://", "https://")):
        url = "https://" + url
    choice = (browser or "").lower().replace(" ", "").replace("browser", "")
    choice = {"google": "chrome", "googlechrome": "chrome", "microsoftedge": "edge", "ddg": "duckduckgo"}.get(choice, choice)
    if choice and choice not in BROWSERS:
        raise ValueError(f"Unknown browser '{browser}'. Use one of: {', '.join(BROWSERS)} or leave empty.")
    label = BROWSERS[choice][1] if choice else "the default browser"
    confirm(f"Open {url} in {label}")
    default = _default_browser()
    if not choice or BROWSERS[choice][1].lower() in default.lower():
        # The default browser (even a Store app) receives URLs via the shell.
        os.startfile(url)  # type: ignore[attr-defined]
        return {"opened": url, "browser": default or "default"}
    exe, app_name = BROWSERS[choice]
    path = _app_path(exe) if exe else None
    if path:
        subprocess.Popen([path, url])
        return {"opened": url, "browser": app_name}
    # Store apps such as DuckDuckGo cannot take a URL on the command line.
    _launch(_find_app(app_name))
    return {
        "launched": app_name,
        "note": f"{app_name} opened but cannot receive a URL directly. Focus it, press ctrl+l, type {url} and press enter.",
    }


@tool()
def open_path(path: str) -> dict:
    """Open a FILE or FOLDER on disk with its default Windows app (not for websites or apps; use open_url / launch_app). Asks the owner first."""
    if "://" in path or path.lower().startswith("www."):
        raise ValueError("That is a web address: use open_url instead.")
    if path.lower().endswith(".exe"):
        raise ValueError("To start a program use launch_app with its name.")
    target = safe_path(path)
    confirm(f"Open:\n{target}")
    os.startfile(str(target))  # type: ignore[attr-defined]
    time.sleep(0.5)
    return {"opened": str(target)}


@tool()
def system_info() -> dict:
    """Basic info about this PC: screen size, allowed file roots, models in use."""
    import pyautogui

    width, height = pyautogui.size()
    return {
        "screen": [width, height],
        "allowed_roots": [str(r) for r in ROOTS],
        "vision_model": VISION_MODEL,
        "yolo_model": YOLO_MODEL,
        "confirmations": confirmations_required(CONFIRMATION_POLICY, CONFIRM),
        "home": str(HOME),
    }


import browser  # noqa: E402  (registers the browser_* tools)

browser.register(tool, confirm, _save, ask_vision)

import site_mapper  # noqa: E402  (registers the site_* mapping tools)

site_mapper.register(tool)


if __name__ == "__main__":
    if "--http" in sys.argv:
        mcp.run(
            "streamable-http",
            host="127.0.0.1",
            port=int(os.environ.get("LOCALTOOLS_PORT", "8765")),
        )
    else:
        mcp.run("stdio")
