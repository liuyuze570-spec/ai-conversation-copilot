"""后端加固回归测试（2026-11-09 复检报告的 7 项）。

跑法（在 webapp/server 下，用 .venv 的 python）：
    ./.venv/Scripts/python.exe -m unittest test_backend_hardening -v

覆盖：
1. 失效 Cookie + 有效 X-Session-Id 请求头命中有效凭据；鉴权不放宽、TTL 仍生效；
2. 反馈提交限流拒绝时提交确实被阻断、库里没有新记录；请求体大小上限；
3. 反馈目录不可用时 `import app` 成功、/api/health 可用、反馈接口 503；
4. 新查询凭据（x-feedback-token 头）可用且旧 ?token= query 兼容；
5. COPILOT_DATA_DIR 环境变量生效；feedback_store 支持外部路径；重开库后原编号可查；
   发布前备份 / 发布后恢复脚本往返（纯文件复制 + sha256）。

全部用合成数据；不读任何真实用户数据、Key 或录音。
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# import app 之前把反馈库指到临时目录，避免测试碰到真实的 server/data。
_TMP_ROOT = tempfile.mkdtemp(prefix="copilot-hardening-")
os.environ.setdefault("COPILOT_DATA_DIR", str(Path(_TMP_ROOT) / "data"))

import app  # noqa: E402
from feedback_store import FeedbackStore  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402


def make_request(cookie: str | None = None, header: str | None = None) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if cookie is not None:
        headers.append((b"cookie", f"sid={cookie}".encode()))
    if header is not None:
        headers.append((b"x-session-id", header.encode()))
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/translate",
            "headers": headers,
            "query_string": b"",
            "client": ("127.0.0.1", 1234),
            "server": ("testserver", 80),
            "scheme": "http",
        }
    )


def run_subprocess(code: str, env_overrides: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    if env_overrides:
        env.update(env_overrides)
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(HERE),
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
    )


class AppStateCase(unittest.TestCase):
    """把 app.FEEDBACK 换成每个用例独立的临时库，结束恢复，避免互相污染。"""

    def setUp(self) -> None:
        self._orig_feedback = app.FEEDBACK
        self._orig_rate = app.FEEDBACK_RATE_PER_MIN
        self._orig_max = app.FEEDBACK_MAX_BODY_BYTES
        self.tmp = tempfile.TemporaryDirectory()
        self.store = FeedbackStore(Path(self.tmp.name) / "feedback.sqlite3")
        app.FEEDBACK = self.store
        app.STORE.feedback_by_key.clear()
        self.client = TestClient(app.app)

    def tearDown(self) -> None:
        app.FEEDBACK = self._orig_feedback
        app.FEEDBACK_RATE_PER_MIN = self._orig_rate
        app.FEEDBACK_MAX_BODY_BYTES = self._orig_max
        app.STORE.feedback_by_key.clear()
        try:
            self.store.close()
        except Exception:
            pass
        self.tmp.cleanup()


class SessionCredentialTests(AppStateCase):
    """问题 1：候选凭据逐一验证，不再被一个无效 Cookie 抢断。"""

    def test_01_invalid_cookie_plus_valid_header_hits_valid_credential(self) -> None:
        session = app.STORE.new_session()
        req = make_request(cookie="bogus-sid", header=session.sid)
        resolved, reason = app.session_from(req)
        self.assertIsNotNone(resolved)
        self.assertEqual(reason, "")
        self.assertEqual(resolved.sid, session.sid)
        # require_session 也必须放行，且返回的不是 403 响应
        self.assertIsInstance(app.require_session(req), app.Session)

    def test_02_http_invalid_cookie_valid_header_is_not_403(self) -> None:
        # 端到端：空白文本会在扣配额/跑模型之前返回 400；
        # 若鉴权被无效 Cookie 抢断，这里会是 403 SESSION_REQUIRED。
        session = app.STORE.new_session()
        client = TestClient(app.app)
        client.cookies.set("sid", "bogus-sid")
        resp = client.post(
            "/api/translate",
            headers={"x-session-id": session.sid},
            json={"text": "   "},
        )
        self.assertEqual(resp.status_code, 400, resp.text)
        self.assertNotEqual(resp.status_code, 403)

    def test_03_no_valid_credential_still_rejected(self) -> None:
        client = TestClient(app.app)
        client.cookies.set("sid", "bogus-sid")
        resp = client.post("/api/translate", json={"text": "   "})
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(resp.json()["error"]["code"], "SESSION_REQUIRED")
        self.assertTrue(resp.json()["error"]["recoverable"])

    def test_04_session_ttl_7200_still_enforced(self) -> None:
        self.assertEqual(app.SESSION_TTL, 7200)
        session = app.STORE.new_session()
        session.created -= app.SESSION_TTL + 1
        resolved, reason = app.session_from(make_request(header=session.sid))
        self.assertIsNone(resolved)
        self.assertEqual(reason, "expired")


class FeedbackSubmitTests(AppStateCase):
    """问题 2：限流、请求体上限、DB 不可用明确 503。"""

    def test_05_rate_limit_blocks_and_no_new_row(self) -> None:
        app.FEEDBACK_RATE_PER_MIN = 2
        payloads = [
            {"where_wrong": "合成内容 A", "suggestion": "", "category": "other"},
            {"where_wrong": "合成内容 B", "suggestion": "", "category": "other"},
            {"where_wrong": "合成内容 C", "suggestion": "", "category": "other"},
        ]
        statuses = [self.client.post("/api/feedback", json=p).status_code for p in payloads]
        self.assertEqual(statuses, [200, 200, 429], statuses)
        # 被限流的第 3 条没有走到 submit，库里不能多出记录
        self.assertEqual(app.FEEDBACK.count(), 2)

    def test_06_body_size_limit(self) -> None:
        app.FEEDBACK_MAX_BODY_BYTES = 100
        before = app.FEEDBACK.count()
        resp = self.client.post(
            "/api/feedback",
            json={
                "where_wrong": "synthetic",
                "suggestion": "",
                "category": "other",
                "diagnostics": "x" * 500,
            },
        )
        self.assertEqual(resp.status_code, 413)
        self.assertEqual(app.FEEDBACK.count(), before)

    def test_07_store_unavailable_returns_503(self) -> None:
        app.FEEDBACK = None
        resp = self.client.post(
            "/api/feedback",
            json={"where_wrong": "synthetic", "suggestion": "", "category": "other"},
        )
        self.assertEqual(resp.status_code, 503)
        self.assertEqual(resp.json()["error"]["code"], "FEEDBACK_STORE_UNAVAILABLE")
        # 绝不返回伪造回执
        self.assertNotIn("ticket", resp.json())


class FeedbackLookupTests(AppStateCase):
    """问题 5：新请求头方式可用、旧 query 短期兼容、无凭证 403。"""

    def setUp(self) -> None:
        super().setUp()
        created, _ = self.store.submit(
            session_key="synthetic-key",
            where_wrong="合成查询用例",
            suggestion="",
            category="other",
        )
        self.ticket = created["ticket"]
        self.token = created["token"]

    def test_08_header_and_legacy_query_both_work(self) -> None:
        by_header = self.client.get(
            f"/api/feedback/{self.ticket}", headers={"x-feedback-token": self.token}
        )
        by_query = self.client.get(f"/api/feedback/{self.ticket}?token={self.token}")
        self.assertEqual(by_header.status_code, 200)
        self.assertEqual(by_header.json()["ticket"], self.ticket)
        self.assertEqual(by_query.status_code, 200)
        self.assertEqual(by_query.json()["ticket"], self.ticket)

    def test_09_missing_or_wrong_credential_403(self) -> None:
        self.assertEqual(self.client.get(f"/api/feedback/{self.ticket}").status_code, 403)
        self.assertEqual(
            self.client.get(
                f"/api/feedback/{self.ticket}", headers={"x-feedback-token": "wrong"}
            ).status_code,
            403,
        )


class StoreAvailabilityTests(unittest.TestCase):
    """问题 3：反馈库初始化失败不能拖垮 import app / /api/health。"""

    def test_10_import_health_ok_feedback_503_when_dir_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            code = """
import os
from pathlib import Path
blocker = Path(%r) / 'not_a_dir.txt'
blocker.write_text('x', encoding='utf-8')
os.environ['COPILOT_DATA_DIR'] = str(blocker)
import app
assert app.FEEDBACK is None, 'store must be unavailable'
class _M:
    mode = 'mock'
    available = False
app.ASR_CHAIN = [_M()]
app.REPLY_CHAIN = [_M()]
from starlette.testclient import TestClient
c = TestClient(app.app)
h = c.get('/api/health')
assert h.status_code == 200, h.status_code
f = c.post('/api/feedback', json={'where_wrong': 'synthetic', 'suggestion': '', 'category': 'other'})
assert f.status_code == 503, f.status_code
print('UNAVAILABLE_OK', h.status_code, f.status_code)
""" % str(tmp)
            result = run_subprocess(code, {"COPILOT_DATA_DIR": str(Path(tmp) / "not_a_dir.txt")})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("UNAVAILABLE_OK 200 503", result.stdout)


class DataDirTests(unittest.TestCase):
    """问题 4：环境变量生效、外部路径、重开持久化、备份/恢复脚本。"""

    def test_11_copilot_data_dir_env_effective(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "persistent"
            code = """
import os
from pathlib import Path
import app
assert app.FEEDBACK is not None, 'store should initialize'
assert app.FEEDBACK.path.resolve().parent == Path(os.environ['COPILOT_DATA_DIR']).resolve(), app.FEEDBACK.path
assert app.FEEDBACK.path.is_file()
print('ENV_OK', app.FEEDBACK.path)
"""
            result = run_subprocess(code, {"COPILOT_DATA_DIR": str(data_dir)})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("ENV_OK", result.stdout)

    def test_12_feedback_store_accepts_external_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            external = Path(tmp) / "outside" / "nested" / "feedback.sqlite3"
            store = FeedbackStore(external)
            try:
                created, _ = store.submit(
                    session_key="k", where_wrong="外部路径合成数据", suggestion="", category="other"
                )
                self.assertTrue(external.is_file())
                self.assertIsNotNone(store.lookup(created["ticket"], created["token"]))
            finally:
                store.close()

    def test_13_reopen_db_ticket_still_queryable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "feedback.sqlite3"
            store = FeedbackStore(db)
            created, _ = store.submit(
                session_key="k", where_wrong="重启前合成数据", suggestion="", category="other"
            )
            store.close()
            reopened = FeedbackStore(db)
            try:
                record = reopened.lookup(created["ticket"], created["token"])
                self.assertIsNotNone(record)
                self.assertEqual(record["where_wrong"], "重启前合成数据")
                self.assertEqual(reopened.count(), 1)
            finally:
                reopened.close()

    def test_14_backup_restore_roundtrip(self) -> None:
        script = HERE.parent / "deploy" / "backup_restore_feedback.py"
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            backup = Path(tmp) / "backup"
            data.mkdir(parents=True)
            store = FeedbackStore(data / "feedback.sqlite3")
            created, _ = store.submit(
                session_key="k", where_wrong="备份恢复合成数据", suggestion="", category="other"
            )
            store.close()

            b = subprocess.run(
                [sys.executable, str(script), "backup", "--data-dir", str(data), "--backup-dir", str(backup)],
                capture_output=True, text=True, timeout=90,
            )
            self.assertEqual(b.returncode, 0, b.stdout + b.stderr)
            self.assertIn("[backup] OK", b.stdout)
            (data / "feedback.sqlite3").unlink()

            r = subprocess.run(
                [sys.executable, str(script), "restore", "--data-dir", str(data), "--backup-dir", str(backup)],
                capture_output=True, text=True, timeout=90,
            )
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("[restore] OK", r.stdout)

            reopened = FeedbackStore(data / "feedback.sqlite3")
            try:
                record = reopened.lookup(created["ticket"], created["token"])
                self.assertIsNotNone(record)
                self.assertEqual(record["where_wrong"], "备份恢复合成数据")
            finally:
                reopened.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
