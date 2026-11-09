"""反馈持久化：SQLite 文件库（匿名、可查询、状态如实）。

设计边界（对应比赛要求里最容易造假的三处）：

- **真持久**：写 SQLite 文件，不是内存字典。进程重启后仍能按编号查到。
  线上发布沙箱的文件系统是否跨重启保留，属于部署环境能力，**单独说明，
  不拿本地测试结果冒充线上已验证**。
- **匿名凭证不泄露内容**：查询要同时给编号和一次性 token；库里只存
  token 的 SHA-256，不存明文。凭证不对返回 403，且不返回任何反馈正文。
- **状态不许假装**：新反馈一律 `received`（已收到）。`analyzing` /
  `pending_verification` / `fixed` 只能由带管理员凭据的状态接口推进，
  前端没有任何「提交即已修复」的路径。
- **1000 字符规则**：按 Unicode 码点计数，与前端 `[...text].length` 一致；
  只计 `where_wrong` + `suggestion`，原文/译文/诊断属于附带信息，单独存。
"""

from __future__ import annotations

import hashlib
import secrets
import sqlite3
import threading
import time
from pathlib import Path

MAX_CHARS = 1000
STATUSES = ("received", "analyzing", "pending_verification", "fixed")
STATUS_LABELS = {
    "received": "已收到",
    "analyzing": "分析中",
    "pending_verification": "待验证",
    "fixed": "已修复",
}
CATEGORIES = (
    "recognition", "translation", "money_date", "reply", "pronunciation", "operation", "other",
)
CATEGORY_LABELS = {
    "recognition": "识别",
    "translation": "翻译",
    "money_date": "金额日期",
    "reply": "回复",
    "pronunciation": "近音",
    "operation": "操作问题",
    "other": "其他",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS feedback (
    ticket          TEXT PRIMARY KEY,
    token_hash      TEXT NOT NULL,
    session_key     TEXT NOT NULL,
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    where_wrong     TEXT NOT NULL,
    suggestion      TEXT NOT NULL,
    category        TEXT NOT NULL,
    original        TEXT NOT NULL DEFAULT '',
    translation     TEXT NOT NULL DEFAULT '',
    reply_text      TEXT NOT NULL DEFAULT '',
    diagnostics     TEXT NOT NULL DEFAULT '',
    attach_context  INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'received',
    fixed_version   TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL,
    updated_at      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_dedup
    ON feedback(session_key, content_hash, created_at);
"""


def char_count(text: str) -> int:
    """反馈正文长度：Unicode 码点数，与 JS `[...text].length` 一致。"""
    return len(text or "")


def feedback_body(where_wrong: str, suggestion: str) -> str:
    return f"{(where_wrong or '').strip()}\n{(suggestion or '').strip()}".strip()


def _hash(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


class FeedbackStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = Path(path)
        self._lock = threading.Lock()
        # check_same_thread=False + 显式锁：FastAPI 的同步路由跑在线程池里。
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def submit(
        self,
        *,
        session_key: str,
        where_wrong: str,
        suggestion: str,
        category: str,
        original: str = "",
        translation: str = "",
        reply_text: str = "",
        diagnostics: str = "",
        attach_context: bool = False,
        now: float | None = None,
    ) -> tuple[dict | None, str | None]:
        """返回 (结果, 错误码)。错误码为 EMPTY / TOO_LONG / CATEGORY / DUPLICATE。"""
        where = (where_wrong or "").strip()
        suggest = (suggestion or "").strip()
        body = feedback_body(where, suggest)
        if not where and not suggest:
            return None, "EMPTY"
        if char_count(body) > MAX_CHARS:
            return None, "TOO_LONG"
        if category not in CATEGORIES:
            return None, "CATEGORY"

        # 附带信息只在用户**明确勾选**后才落库；默认不附整段录音、历史、
        # 也不附诊断。录音根本没有进入这条链路（音频只走 /api/transcribe）。
        if not attach_context:
            original = ""
            translation = ""
            reply_text = ""
            diagnostics = ""

        stamp = now if now is not None else time.time()
        content_hash = _hash(body + "|" + category)
        ticket = f"FB-{time.strftime('%Y%m%d', time.localtime(stamp))}-{secrets.token_hex(3).upper()}"
        token = secrets.token_hex(16)

        with self._lock:
            # 同一会话 60 秒内提交一模一样的内容 → 判重复，不生成第二条。
            row = self._conn.execute(
                "SELECT ticket, created_at FROM feedback "
                "WHERE session_key = ? AND content_hash = ? "
                "ORDER BY created_at DESC LIMIT 1",
                (session_key, content_hash),
            ).fetchone()
            if row and stamp - float(row[1]) < 60:
                return None, "DUPLICATE"
            self._conn.execute(
                "INSERT INTO feedback (ticket, token_hash, session_key, content, content_hash, "
                "where_wrong, suggestion, category, original, translation, reply_text, "
                "diagnostics, attach_context, status, fixed_version, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    ticket, _hash(token), session_key, body, content_hash,
                    where, suggest, category,
                    original[:MAX_CHARS], translation[:MAX_CHARS], reply_text[:MAX_CHARS],
                    diagnostics[:MAX_CHARS], int(attach_context), "received", "",
                    stamp, stamp,
                ),
            )
            self._conn.commit()

        return {
            "ticket": ticket,
            "token": token,          # 只在创建时返回一次
            "status": "received",
            "status_label": STATUS_LABELS["received"],
            "chars": char_count(body),
            "max_chars": MAX_CHARS,
            "fixed_version": "",
        }, None

    def lookup(self, ticket: str, token: str) -> dict | None:
        """凭证不匹配返回 None，且不返回任何正文（调用方据此回 403）。"""
        with self._lock:
            row = self._conn.execute(
                "SELECT ticket, token_hash, status, fixed_version, created_at, "
                "where_wrong, suggestion, category, original, translation, reply_text, "
                "diagnostics, attach_context FROM feedback WHERE ticket = ?",
                (ticket,),
            ).fetchone()
        if not row or not secrets.compare_digest(row[1], _hash(token or "")):
            return None
        return {
            "ticket": row[0],
            "status": row[2],
            "status_label": STATUS_LABELS.get(row[2], row[2]),
            "fixed_version": row[3],
            "created_at": row[4],
            "where_wrong": row[5],
            "suggestion": row[6],
            "category": row[7],
            "category_label": CATEGORY_LABELS.get(row[7], row[7]),
            "original": row[8],
            "translation": row[9],
            "reply_text": row[10],
            "diagnostics": row[11],
            "attach_context": bool(row[12]),
        }

    def set_status(self, ticket: str, status: str, fixed_version: str = "") -> bool:
        """只允许服务端在验证/发布之后推进；前端没有这个入口。"""
        if status not in STATUSES:
            return False
        with self._lock:
            cursor = self._conn.execute(
                "UPDATE feedback SET status = ?, fixed_version = ?, updated_at = ? WHERE ticket = ?",
                (status, fixed_version if status == "fixed" else "", time.time(), ticket),
            )
            self._conn.commit()
            return cursor.rowcount > 0

    def count(self) -> int:
        with self._lock:
            return int(self._conn.execute("SELECT COUNT(*) FROM feedback").fetchone()[0])
