#!/usr/bin/env python3
"""xangi Managed Extension「xangi-google-tasks」のランタイム。

xangi 本体が `scripts/xangi-extension serve --workspace <path>` で起動する。
127.0.0.1 の空きポートで HTTP を待ち受け、ready JSON を stdout に 1 行出す。
G2 アプリからの要求は xangi の device ingress
（`http://<host>:18888/api/devices/xangi-google-tasks/<path>`）経由で
このプロセスの `/device/<path>` に転送される。

認証は 2 段階:
    1. Authorization: xangi が付ける runtime token（XANGI_EXTENSION_AUTH_TOKEN）
    2. X-Xangi-Device-Authorization: G2 アプリの Bearer（GTASKS_DEVICE_TOKEN）
   xangi の device ingress 仕様（docs/en/design.md「Shared HTTP ingress for device
   extensions」）で、runtime token だけでは device 操作を許可してはならないとされている。

device API（すべて JSON。/stt だけ入力が生 PCM）:
    GET  /device/lists                          -> {"lists": [...]}
    GET  /device/tasks?list=ID&completed=1      -> {"tasks": [...]}
    POST /device/tasks/add      {list, title, due?}
    POST /device/tasks/complete {list, id, completed: bool}
    POST /device/tasks/due      {list, id, due: "YYYY-MM-DD" | null}
    POST /device/tasks/delete   {list, id}
    POST /device/stt            (16kHz mono s16le PCM) -> {"text": "..."}
   device ingress は GET/POST だけを転送するため、更新・削除も POST で受ける。

設定は server/.env（KEY=VALUE）から読み、親プロセスの環境変数を優先する。
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import signal
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

import stt  # noqa: E402
import tasks_backend  # noqa: E402

EXTENSION_ID = "xangi-google-tasks"
VERSION = "0.1.0"
# JSON 本文の上限。タスク操作の本文は数百バイトなので 64KiB で十分。
JSON_BODY_MAX_BYTES = 64 * 1024


def load_env_file(path: Path, environ: dict[str, str]) -> None:
    """KEY=VALUE 形式の .env を読み、未設定のキーだけ environ に入れる。

    xangi が渡す環境変数（認証 token 等）を .env で上書きしないため setdefault にする。
    """
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        if key:
            environ.setdefault(key, value)


def health() -> dict[str, Any]:
    """xangi の status/doctor 向け health を返す。

    Google への疎通は毎回確認しない（health は頻繁に呼ばれ、API 呼び出し回数を
    無駄に増やすため）。設定の有無だけで ready を判定し、実際の疎通は device API の
    初回操作で確かめる。
    """
    device_token = bool(os.environ.get("GTASKS_DEVICE_TOKEN", "").strip())
    gog_ready = True
    try:
        tasks_backend._gog_command([])
    except tasks_backend.TasksError:
        gog_ready = False
    keyring = bool(os.environ.get("GOG_KEYRING_PASSWORD", "").strip())
    ready = device_token and gog_ready and keyring
    return {
        "ok": ready,
        "ready": ready,
        "version": VERSION,
        "detail": "ready" if ready else "GTASKS_DEVICE_TOKEN / gog / GOG_KEYRING_PASSWORD を確認してください",
        "deviceTokenConfigured": device_token,
        "gogFound": gog_ready,
        "gogKeyringConfigured": keyring,
        "sttConfigured": stt.stt_configured(),
    }


def _body_json(body: bytes) -> dict[str, Any]:
    """POST 本文を JSON object として読む。不正なら TasksError。"""
    try:
        parsed = json.loads(body.decode("utf-8") or "{}")
    except ValueError as error:
        raise tasks_backend.TasksError("JSON が不正です") from error
    if not isinstance(parsed, dict):
        raise tasks_backend.TasksError("JSON object が必要です")
    return parsed


def handle_device(method: str, path: str, query: dict[str, list[str]], body: bytes) -> tuple[int, dict[str, Any]]:
    """認証済みの device 要求を処理する。

    Args:
        method: "GET" または "POST"。
        path: `/device` を除いたパス。例: "/tasks/add"
        query: parse_qs 済みのクエリ。
        body: リクエスト本文。

    Returns:
        (HTTP status, JSON 応答)。失敗時は {"error": "..."}。
    """
    try:
        if method == "GET" and path == "/health":
            return 200, {"ok": True, "version": VERSION}
        if method == "GET" and path == "/lists":
            return 200, {"lists": tasks_backend.list_tasklists()}
        if method == "GET" and path == "/tasks":
            list_id = query.get("list", [""])[0]
            completed = query.get("completed", ["0"])[0] in {"1", "true"}
            return 200, {"tasks": tasks_backend.list_tasks(list_id, include_completed=completed)}
        if method == "POST" and path == "/stt":
            return 200, {"text": stt.transcribe_pcm(body)}
        if method == "POST" and path.startswith("/tasks/"):
            data = _body_json(body)
            list_id = str(data.get("list", ""))
            task_id = str(data.get("id", ""))
            if path == "/tasks/add":
                due = data.get("due") or None
                return 200, {"task": tasks_backend.add_task(list_id, str(data.get("title", "")), due)}
            if path == "/tasks/complete":
                completed = bool(data.get("completed", True))
                return 200, {"task": tasks_backend.set_completed(list_id, task_id, completed)}
            if path == "/tasks/due":
                return 200, {"task": tasks_backend.set_due(list_id, task_id, data.get("due") or None)}
            if path == "/tasks/delete":
                tasks_backend.delete_task(list_id, task_id)
                return 200, {"ok": True}
        return 404, {"error": "not found"}
    except tasks_backend.TasksError as error:
        return 502 if str(error).startswith("gog") or "タイムアウト" in str(error) else 400, {"error": str(error)}
    except stt.SttError as error:
        return 502, {"error": str(error)}


def make_handler(runtime_token: str, device_token_getter: Callable[[], str]):
    """runtime token と device token を検証する HTTP ハンドラクラスを作る。"""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, _format: str, *_args: object) -> None:
            # 既定のアクセスログは stderr を埋めるだけなので出さない。
            return

        def do_GET(self) -> None:  # noqa: N802
            self._handle()

        def do_POST(self) -> None:  # noqa: N802
            self._handle()

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _handle(self) -> None:
            # 1. xangi からの転送であることを runtime token で確認する。
            if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), f"Bearer {runtime_token}".encode()):
                self._send_json(401, {"error": "unauthorized"})
                return
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path == "/health" and self.command == "GET":
                self._send_json(200, health())
                return
            if not parsed.path.startswith("/device/"):
                self._send_json(404, {"error": "not found"})
                return
            # 2. G2 アプリの device token を確認する。
            auth = self.headers.get("X-Xangi-Device-Authorization", "")
            given = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
            expected = device_token_getter()
            if not expected or not hmac.compare_digest(given.encode(), expected.encode()):
                self._send_json(401, {"error": "invalid device token"})
                return
            # 3. 本文を読む（/stt は PCM、それ以外は小さな JSON）。
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self._send_json(400, {"error": "bad content-length"})
                return
            device_path = parsed.path[len("/device"):]
            limit = stt.MAX_PCM_BYTES if device_path == "/stt" else JSON_BODY_MAX_BYTES
            if length < 0 or length > limit:
                self._send_json(413, {"error": "body too large"})
                return
            body = self.rfile.read(length) if length else b""
            status, payload = handle_device(self.command, device_path, urllib.parse.parse_qs(parsed.query), body)
            if status >= 500:
                print(f"[{EXTENSION_ID}] {self.command} {device_path} -> {status}: {payload.get('error')}", file=sys.stderr, flush=True)
            self._send_json(status, payload)

    return Handler


def serve(workspace: Path) -> None:
    """xangi Managed Extension として待ち受け、ready JSON を出して終了要求まで動く。"""
    runtime_token = os.environ.get("XANGI_EXTENSION_AUTH_TOKEN", "").strip()
    if not runtime_token:
        raise RuntimeError("XANGI_EXTENSION_AUTH_TOKEN is required")
    load_env_file(Path(__file__).resolve().parent / ".env", os.environ)  # type: ignore[arg-type]

    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        make_handler(runtime_token, lambda: os.environ.get("GTASKS_DEVICE_TOKEN", "").strip()),
    )
    stopped = threading.Event()

    def shutdown() -> None:
        if stopped.is_set():
            return
        stopped.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, lambda *_: shutdown())
    signal.signal(signal.SIGINT, lambda *_: shutdown())

    def watch_parent() -> None:
        # xangi 本体は終了時に stdin を閉じる。EOF を親の終了とみなして止まる。
        try:
            sys.stdin.buffer.read()
        finally:
            shutdown()

    threading.Thread(target=watch_parent, daemon=True).start()
    print(
        json.dumps(
            {
                "schemaVersion": 2,
                "event": "ready",
                "id": EXTENSION_ID,
                "baseUrl": f"http://127.0.0.1:{server.server_port}",
                "workspace": str(workspace.resolve()),
                "pid": os.getpid(),
            }
        ),
        flush=True,
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(prog=f"{EXTENSION_ID}-extension")
    parser.add_argument("action", choices=["serve"])
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    args = parser.parse_args()
    serve(args.workspace)


if __name__ == "__main__":
    main()
