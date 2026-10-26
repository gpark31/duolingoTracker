"""Serves the tracker app and relays Duolingo's public profile data to it.

Duolingo's unofficial API doesn't allow browser (CORS) requests, so the app asks this relay instead.
Standard library only.

    python server.py                  # http://localhost:8787
    HOST=0.0.0.0 PORT=8080 python server.py   # when deploying
"""

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent / "app"
DUO_API = "https://www.duolingo.com/2017-06-30/users"
USER_AGENT = "Mozilla/5.0 (lesson-tracker relay)"
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,40}$")
CACHE_SECONDS = 60
TIMEOUT_SECONDS = 10

_cache: dict[tuple[str, bool], tuple[float, dict]] = {}


class RelayError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def fetch_json(url: str, token: str | None = None) -> dict:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
        return json.loads(res.read().decode("utf-8"))


def normalize_profile(user: dict) -> dict:
    """Reduce Duolingo's user object to what the app needs."""
    courses = user.get("courses") or []
    current = next((c for c in courses if c.get("id") == user.get("currentCourseId")), None)
    if current is None and courses:
        current = max(courses, key=lambda c: c.get("xp") or 0)
    return {
        "username": user.get("username"),
        "streak": user.get("streak"),
        "totalXp": user.get("totalXp"),
        "courseTitle": current.get("title") if current else None,
        "courseXp": current.get("xp") if current else None,
        "gains": None,
    }


def normalize_gains(raw: dict) -> list[dict]:
    """xpGains entries look like {"time": <unix seconds>, "xp": <int>, ...}; keep only those two."""
    out = []
    for g in raw.get("xpGains") or []:
        try:
            t = int(g["time"])
        except (KeyError, TypeError, ValueError):
            continue
        out.append({"t": t, "xp": int(g.get("xp") or 0)})
    return out


def lookup(username: str, token: str | None = None) -> dict:
    if not USERNAME_RE.match(username):
        raise RelayError(400, "That doesn't look like a Duolingo username.")
    key = (username.lower(), bool(token))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]

    fields = "users{id,username,streak,totalXp,currentCourseId,courses}"
    url = DUO_API + "?" + urllib.parse.urlencode({"username": username, "fields": fields})
    try:
        data = fetch_json(url)
    except urllib.error.HTTPError as e:
        raise RelayError(502, f"Duolingo answered with an error ({e.code}).") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise RelayError(504, "Couldn't reach Duolingo. Try again in a moment.") from e
    users = data.get("users") or []
    if not users:
        raise RelayError(404, f"No Duolingo user named “{username}”.")
    user = users[0]
    out = normalize_profile(user)

    if token and user.get("id") is not None:
        try:
            raw = fetch_json(f"{DUO_API}/{int(user['id'])}?fields=xpGains", token)
            out["gains"] = normalize_gains(raw)
        except urllib.error.HTTPError as e:
            out["gainsError"] = ("Your login token was rejected, so lessons were estimated from XP."
                                 if e.code in (401, 403) else f"Lesson history unavailable ({e.code}).")
        except (urllib.error.URLError, TimeoutError, ValueError):
            out["gainsError"] = "Lesson history unavailable right now, so lessons were estimated from XP."

    _cache[key] = (time.time(), out)
    return out


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".js": "text/javascript",
        ".json": "application/json",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def end_headers(self):
        if self.path.startswith("/api/"):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "X-Duo-Token")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/duolingo":
            self.api(urllib.parse.parse_qs(parsed.query))
        elif parsed.path.startswith("/api/"):
            self.send_json(404, {"error": "Not found"})
        else:
            super().do_GET()

    def api(self, query: dict):
        username = (query.get("username") or [""])[0].strip()
        token = (self.headers.get("X-Duo-Token") or "").strip() or None
        try:
            self.send_json(200, lookup(username, token))
        except RelayError as e:
            self.send_json(e.status, {"error": str(e)})

    def send_json(self, status: int, body: dict):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        # Never log query strings or headers; they can carry usernames and tokens.
        print(f"{self.command} {urllib.parse.urlparse(self.path).path} -> {args[1] if len(args) > 1 else ''}")


def main():
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8787"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Lesson Tracker running at http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
