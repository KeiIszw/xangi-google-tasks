"""Google Tasks を gog CLI 経由で読み書きするバックエンド。

runtime.py の device API から呼ばれ、G2 アプリに渡しやすい小さな dict へ整形して返す。
OAuth トークンは xangi を動かすホストの gog キーリングに置いたままにし、このモジュールは gog を
subprocess で呼ぶだけにする（G2・スマホ側へ Google の資格情報を出さないため）。

前提となる環境変数:
    GOG_BIN               gog の実行ファイル（既定: PATH 上の gog）
    GOG_ACCOUNT           操作対象の Google アカウント（gog --account に渡す）
    GOG_KEYRING_PASSWORD  gog の file キーリングを非対話で開くためのパスワード

副作用:
    Google Tasks API へのリクエスト（gog 経由）。追加・更新・削除は Google 側に即時反映される。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from typing import Any

# gog 1回の呼び出し上限（秒）。G2 側の待ち時間と xangi device ingress の
# 応答ヘッダ期限（120秒）より十分短くし、失敗をエラー表示として返せるようにする。
GOG_TIMEOUT_SEC = 25

# 完了済みタスクを含める時の取得上限。Google Tasks API の 1 ページ上限が 100 件で、
# 古い完了タスクを全ページ読むと G2 の表示待ちが長くなるため 1 ページに留める。
COMPLETED_FETCH_MAX = 100
# 完了済みとして表示する期間（日）。G2 で見返すのは最近完了したものだけの想定。
COMPLETED_LOOKBACK_DAYS = 30

# 期日の入力形式。例: "2026-11-28"。Tasks API は日付部分しか保持しない。
DUE_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# タイトルの上限文字数。Google Tasks の UI 上の上限（1024文字）に合わせる。
TITLE_MAX_CHARS = 1024


class TasksError(RuntimeError):
    """gog の実行失敗や入力不正を表す。message は G2 にそのまま表示できる短文にする。"""


def _gog_command(args: list[str]) -> list[str]:
    """gog のコマンドラインを組み立てる。

    Args:
        args: `tasks` 以降のサブコマンドと引数。

    Returns:
        subprocess に渡す argv。JSON 出力・非対話・アカウント指定を必ず付ける。

    Raises:
        TasksError: gog が見つからない場合。
    """
    gog_bin = os.environ.get("GOG_BIN", "").strip() or shutil.which("gog") or ""
    if not gog_bin:
        raise TasksError("gog が見つかりません")
    command = [gog_bin, "--json", "--no-input"]
    account = os.environ.get("GOG_ACCOUNT", "").strip()
    if account:
        command += ["--account", account]
    return command + ["tasks", *args]


def run_gog(args: list[str]) -> dict[str, Any]:
    """gog tasks を実行し、JSON 出力を dict で返す。

    Args:
        args: `tasks` 以降の引数。例: ["list", "<listId>", "--all"]

    Returns:
        gog の JSON 出力。出力が空のコマンド（delete 等）では空 dict。

    Raises:
        TasksError: タイムアウト、非0終了、JSON 解析失敗の場合。
    """
    try:
        completed = subprocess.run(
            _gog_command(args),
            capture_output=True,
            timeout=GOG_TIMEOUT_SEC,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise TasksError("Google Tasks の応答がタイムアウトしました") from error
    if completed.returncode != 0:
        # stderr にはアカウント名が含まれることがあるため、末尾の短い部分だけ返す。
        tail = completed.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["unknown error"]
        raise TasksError(f"gog 失敗: {tail[0][:160]}")
    stdout = completed.stdout.decode("utf-8", "replace").strip()
    if not stdout:
        return {}
    try:
        parsed = json.loads(stdout)
    except ValueError as error:
        raise TasksError("gog の出力を解析できません") from error
    return parsed if isinstance(parsed, dict) else {"result": parsed}


def list_tasklists() -> list[dict[str, str]]:
    """タスクリスト一覧を返す。

    Returns:
        [{"id": str, "title": str}, ...]。Google 側の並び順を保つ。
    """
    data = run_gog(["lists", "list", "--all"])
    return [
        {"id": str(item.get("id", "")), "title": str(item.get("title", ""))}
        for item in data.get("tasklists", [])
        if item.get("id")
    ]


def normalize_task(item: dict[str, Any]) -> dict[str, Any]:
    """gog の task JSON から G2 表示に必要な項目だけを取り出す。

    Args:
        item: Tasks API の task リソース。

    Returns:
        {"id", "title", "status", "due", "notes", "parent", "position"}。
        due は "YYYY-MM-DD" か None。Tasks API は due を "2026-11-28T00:00:00.000Z"
        の形で返すが、時刻部分は常に 0 時で意味を持たないため日付だけにする。
    """
    due = item.get("due")
    return {
        "id": str(item.get("id", "")),
        "title": str(item.get("title", "")),
        "status": "completed" if item.get("status") == "completed" else "needsAction",
        "due": due[:10] if isinstance(due, str) and len(due) >= 10 else None,
        "notes": str(item.get("notes", "") or ""),
        "parent": item.get("parent") or None,
        "position": str(item.get("position", "")),
    }


def order_tasks(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """未完了→完了の順に並べ、各グループ内で親タスクの直後に子タスクを置く。

    Tasks API の list は並び順を保証しないため、position（辞書順で比較できる
    ゼロ埋め文字列）で Google Tasks アプリと同じ並びに戻す。親が別グループや
    取得範囲外にある子タスクは、トップレベルとして扱う。

    Args:
        tasks: normalize_task 済みのタスク。

    Returns:
        並べ替えた新しいリスト。子タスクには "depth": 1、それ以外は 0 を付ける。
    """
    ordered: list[dict[str, Any]] = []
    for status in ("needsAction", "completed"):
        group = [task for task in tasks if task["status"] == status]
        ids = {task["id"] for task in group}
        children: dict[str, list[dict[str, Any]]] = {}
        roots: list[dict[str, Any]] = []
        for task in group:
            if task["parent"] and task["parent"] in ids:
                children.setdefault(task["parent"], []).append(task)
            else:
                roots.append(task)
        for root in sorted(roots, key=lambda task: task["position"]):
            ordered.append({**root, "depth": 0})
            for child in sorted(children.get(root["id"], []), key=lambda task: task["position"]):
                ordered.append({**child, "depth": 1})
    return ordered


def list_tasks(tasklist_id: str, include_completed: bool = False) -> list[dict[str, Any]]:
    """指定リストのタスクを表示順で返す。

    未完了は全件、完了済みは直近 COMPLETED_LOOKBACK_DAYS 日・最大 COMPLETED_FETCH_MAX 件を
    別々に取得して結合する。1 回の呼び出しで完了済みを含めて上限件数まで取ると、
    古い完了タスクに押し出されて未完了タスクが欠けることがある（2026-11-27 に確認）。

    Args:
        tasklist_id: タスクリスト ID。
        include_completed: True なら完了済みも含める。

    Returns:
        order_tasks 済みのタスク一覧。
    """
    _require_id(tasklist_id, "list")
    # Tasks API は showCompleted の既定が true で、非表示化（clear）前の完了タスクも返すため、
    # 未完了の取得結果からも completed を除く。
    open_items = run_gog(["list", tasklist_id, "--all", "--max=100"]).get("tasks", [])
    tasks = [task for task in map(normalize_task, open_items) if task["status"] != "completed"]
    if include_completed:
        since = (datetime.now(timezone.utc) - timedelta(days=COMPLETED_LOOKBACK_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
        done_items = run_gog([
            "list", tasklist_id,
            # gog の仕様で --show-completed は --show-hidden と併用が必要。
            "--show-completed", "--show-hidden",
            f"--completed-min={since}", f"--max={COMPLETED_FETCH_MAX}",
        ]).get("tasks", [])
        known = {task["id"] for task in tasks}
        tasks += [
            task for task in map(normalize_task, done_items)
            if task["status"] == "completed" and task["id"] not in known
        ]
    return order_tasks(tasks)


def add_task(tasklist_id: str, title: str, due: str | None = None) -> dict[str, Any]:
    """タスクを追加し、作成されたタスクを返す。

    Args:
        tasklist_id: 追加先のリスト ID。
        title: タイトル。前後の空白は除く。空は不可。
        due: "YYYY-MM-DD" または None。

    Raises:
        TasksError: 入力不正または gog 失敗。
    """
    _require_id(tasklist_id, "list")
    clean_title = title.strip()
    if not clean_title:
        raise TasksError("タイトルが空です")
    if len(clean_title) > TITLE_MAX_CHARS:
        raise TasksError("タイトルが長すぎます")
    args = ["add", tasklist_id, f"--title={clean_title}"]
    if due:
        args.append(f"--due={_validate_due(due)}")
    data = run_gog(args)
    return normalize_task(data.get("task", data))


def set_completed(tasklist_id: str, task_id: str, completed: bool) -> dict[str, Any]:
    """タスクを完了または未完了にする。

    Args:
        tasklist_id: リスト ID。
        task_id: タスク ID。
        completed: True で完了、False で未完了に戻す。
    """
    _require_id(tasklist_id, "list")
    _require_id(task_id, "task")
    data = run_gog(["done" if completed else "undo", tasklist_id, task_id])
    return normalize_task(data.get("task", data))


def set_due(tasklist_id: str, task_id: str, due: str | None) -> dict[str, Any]:
    """タスクの期日を変更する。

    Args:
        tasklist_id: リスト ID。
        task_id: タスク ID。
        due: "YYYY-MM-DD"。None または空文字で期日を消す。
    """
    _require_id(tasklist_id, "list")
    _require_id(task_id, "task")
    value = _validate_due(due) if due else ""
    data = run_gog(["update", tasklist_id, task_id, f"--due={value}"])
    return normalize_task(data.get("task", data))


def delete_task(tasklist_id: str, task_id: str) -> None:
    """タスクを削除する。Google Tasks のゴミ箱には入らず復元できない点に注意。"""
    _require_id(tasklist_id, "list")
    _require_id(task_id, "task")
    run_gog(["delete", tasklist_id, task_id, "--force"])


def _validate_due(due: str) -> str:
    """期日文字列が YYYY-MM-DD 形式か確認して返す。"""
    value = str(due).strip()
    if not DUE_DATE_RE.match(value):
        raise TasksError("期日は YYYY-MM-DD 形式で指定してください")
    return value


def _require_id(value: str, kind: str) -> None:
    """ID が空でなく、gog のフラグと誤認される先頭 '-' を含まないことを確認する。"""
    if not value or not isinstance(value, str) or value.startswith("-"):
        raise TasksError(f"{kind} id が不正です")
