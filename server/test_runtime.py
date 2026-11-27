"""server/ の単体テスト。Google・Groq には接続せず、gog 呼び出しを差し替えて検証する。

実行: cd server && python3 -m unittest -v
"""

from __future__ import annotations

import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

import runtime
import stt
import tasks_backend


class OrderTasksTest(unittest.TestCase):
    def test_open_first_and_children_after_parent(self) -> None:
        raw = [
            {"id": "c", "title": "done", "status": "completed", "position": "0"},
            {"id": "b", "title": "child", "status": "needsAction", "parent": "a", "position": "0"},
            {"id": "a", "title": "parent", "status": "needsAction", "position": "1", "due": "2026-11-28T00:00:00.000Z"},
            {"id": "z", "title": "first", "status": "needsAction", "position": "0"},
        ]
        ordered = tasks_backend.order_tasks([tasks_backend.normalize_task(item) for item in raw])
        self.assertEqual([task["id"] for task in ordered], ["z", "a", "b", "c"])
        self.assertEqual([task["depth"] for task in ordered], [0, 0, 1, 0])
        self.assertEqual(ordered[1]["due"], "2026-11-28")

    def test_orphan_child_becomes_root(self) -> None:
        ordered = tasks_backend.order_tasks(
            [tasks_backend.normalize_task({"id": "x", "status": "needsAction", "parent": "gone", "position": "0"})]
        )
        self.assertEqual(ordered[0]["depth"], 0)


class ValidationTest(unittest.TestCase):
    def test_rejects_bad_due_and_flag_like_id(self) -> None:
        with self.assertRaises(tasks_backend.TasksError):
            tasks_backend.set_due("list", "task", "11/28")
        with self.assertRaises(tasks_backend.TasksError):
            tasks_backend.delete_task("--all", "task")
        with self.assertRaises(tasks_backend.TasksError):
            tasks_backend.add_task("list", "   ")

    def test_gog_arguments(self) -> None:
        with mock.patch.object(tasks_backend, "run_gog", return_value={"task": {"id": "t", "status": "needsAction"}}) as run:
            tasks_backend.set_due("L", "T", None)
            run.assert_called_with(["update", "L", "T", "--due="])
            tasks_backend.add_task("L", " 牛乳 ", "2026-11-28")
            run.assert_called_with(["add", "L", "--title=牛乳", "--due=2026-11-28"])


class ListTasksTest(unittest.TestCase):
    def test_completed_tasks_are_hidden_unless_requested(self) -> None:
        data = {"tasks": [
            {"id": "a", "status": "needsAction", "position": "0"},
            {"id": "b", "status": "completed", "position": "1"},
        ]}
        done = {"tasks": [{"id": "c", "status": "completed", "position": "2"}, {"id": "b", "status": "completed", "position": "1"}]}
        with mock.patch.object(tasks_backend, "run_gog", return_value=data):
            self.assertEqual([task["id"] for task in tasks_backend.list_tasks("L")], ["a"])
        # 2 回目の呼び出し（完了済み）の結果を結合し、重複は除く。
        with mock.patch.object(tasks_backend, "run_gog", side_effect=[data, done]) as run:
            self.assertEqual([task["id"] for task in tasks_backend.list_tasks("L", True)], ["a", "b", "c"])
        self.assertIn("--show-completed", run.call_args_list[1].args[0])


class HttpAuthTest(unittest.TestCase):
    """runtime token と device token の両方が必要なことを実 HTTP で確認する。"""

    def setUp(self) -> None:
        handler = runtime.make_handler("runtime-secret", lambda: "device-secret")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def request(self, path: str, headers: dict[str, str], body: bytes | None = None) -> tuple[int, dict]:
        req = urllib.request.Request(self.base + path, data=body, headers=headers, method="POST" if body is not None else "GET")
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_runtime_token_alone_is_rejected(self) -> None:
        status, _ = self.request("/device/lists", {"Authorization": "Bearer runtime-secret"})
        self.assertEqual(status, 401)

    def test_missing_runtime_token_is_rejected(self) -> None:
        status, _ = self.request("/device/lists", {"X-Xangi-Device-Authorization": "Bearer device-secret"})
        self.assertEqual(status, 401)

    def test_both_tokens_reach_backend(self) -> None:
        headers = {"Authorization": "Bearer runtime-secret", "X-Xangi-Device-Authorization": "Bearer device-secret"}
        with mock.patch.object(tasks_backend, "list_tasklists", return_value=[{"id": "L", "title": "Tasks"}]):
            status, payload = self.request("/device/lists", headers)
        self.assertEqual((status, payload), (200, {"lists": [{"id": "L", "title": "Tasks"}]}))

    def test_post_complete_routes_to_backend(self) -> None:
        headers = {
            "Authorization": "Bearer runtime-secret",
            "X-Xangi-Device-Authorization": "Bearer device-secret",
            "Content-Type": "application/json",
        }
        with mock.patch.object(tasks_backend, "set_completed", return_value={"id": "T"}) as done:
            status, _ = self.request("/device/tasks/complete", headers, json.dumps({"list": "L", "id": "T", "completed": False}).encode())
        self.assertEqual(status, 200)
        done.assert_called_once_with("L", "T", False)

    def test_backend_error_is_reported(self) -> None:
        headers = {"Authorization": "Bearer runtime-secret", "X-Xangi-Device-Authorization": "Bearer device-secret"}
        with mock.patch.object(tasks_backend, "list_tasklists", side_effect=tasks_backend.TasksError("gog 失敗: x")):
            status, payload = self.request("/device/lists", headers)
        self.assertEqual(status, 502)
        self.assertIn("gog", payload["error"])


class SttTest(unittest.TestCase):
    def test_wav_header_and_missing_key(self) -> None:
        wav = stt.pcm_to_wav(b"\x00\x00" * 160)
        self.assertTrue(wav.startswith(b"RIFF"))
        with mock.patch.dict(os.environ, {"GROQ_API_KEY": ""}):
            with self.assertRaises(stt.SttError):
                stt.transcribe_pcm(b"\x00\x00" * 16000)

    def test_short_audio_and_hallucination_are_empty(self) -> None:
        self.assertEqual(stt.transcribe_pcm(b"\x00\x00"), "")
        fake = mock.MagicMock()
        fake.__enter__.return_value.read.return_value = json.dumps({"text": "ご視聴ありがとうございました"}).encode()
        with mock.patch.dict(os.environ, {"GROQ_API_KEY": "k"}), mock.patch("urllib.request.urlopen", return_value=fake):
            self.assertEqual(stt.transcribe_pcm(b"\x00\x00" * 16000), "")


if __name__ == "__main__":
    unittest.main()
