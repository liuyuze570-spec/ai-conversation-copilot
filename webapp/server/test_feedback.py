"""反馈库回归：1000 字符规则 / 空白 / 超限 / 重复 / 匿名凭证 / 持久化 / 状态。

跑法：`./.venv/Scripts/python.exe -m unittest test_feedback -v`
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from feedback_store import FeedbackStore, MAX_CHARS, char_count, feedback_body


def submit(store, **overrides):
    payload = {
        "session_key": "s1",
        "where_wrong": "译文把币种写成了美元",
        "suggestion": "原话没说币种，应该留空并问对方",
        "category": "translation",
        "original": "The deposit is 300.",
        "translation": "定金300美元。",
    }
    payload.update(overrides)
    return store.submit(**payload)


class FeedbackStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "nested" / "feedback.sqlite3"
        self.store = FeedbackStore(self.db)

    def tearDown(self):
        try:
            self.store.close()
        except Exception:
            pass
        self.tmp.cleanup()

    def test_01_count_rule_is_unicode_codepoints(self):
        # 中文、emoji 都按 1 个码点，和前端 [...text].length 一致；不是 UTF-8 字节数。
        self.assertEqual(char_count("你好😀"), 3)
        self.assertEqual(len("你好😀".encode("utf-8")), 10)
        self.assertEqual(MAX_CHARS, 1000)

    def test_02_empty_rejected(self):
        result, reason = submit(self.store, where_wrong="   ", suggestion="\n")
        self.assertIsNone(result)
        self.assertEqual(reason, "EMPTY")

    def test_03_over_limit_rejected(self):
        result, reason = submit(self.store, where_wrong="错" * 1001)
        self.assertIsNone(result)
        self.assertEqual(reason, "TOO_LONG")
        ok, reason = submit(self.store, where_wrong="错" * 1000, suggestion="")
        self.assertIsNotNone(ok)
        self.assertEqual(ok["chars"], 1000)
        self.assertEqual(ok["max_chars"], 1000)

    def test_04_joined_body_is_what_is_counted(self):
        # 两栏合计，不是分别算：900 + 200 也必须被拦。
        result, reason = submit(self.store, where_wrong="错" * 900, suggestion="改" * 200)
        self.assertEqual(reason, "TOO_LONG")
        self.assertEqual(char_count(feedback_body("错" * 900, "改" * 200)), 1101)

    def test_05_duplicate_rejected(self):
        first, _ = submit(self.store)
        self.assertIsNotNone(first)
        again, reason = submit(self.store)
        self.assertIsNone(again)
        self.assertEqual(reason, "DUPLICATE")

    def test_06_bad_category_rejected(self):
        result, reason = submit(self.store, category="not-a-category")
        self.assertIsNone(result)
        self.assertEqual(reason, "CATEGORY")

    def test_07_status_starts_at_received(self):
        created, _ = submit(self.store)
        self.assertEqual(created["status"], "received")
        self.assertEqual(created["status_label"], "已收到")
        self.assertEqual(created["fixed_version"], "")
        record = self.store.lookup(created["ticket"], created["token"])
        self.assertEqual(record["status"], "received")

    def test_08_wrong_token_leaks_nothing(self):
        created, _ = submit(self.store)
        self.assertIsNone(self.store.lookup(created["ticket"], "wrong-token"))
        self.assertIsNone(self.store.lookup(created["ticket"], ""))

    def test_09_attach_context_defaults_off(self):
        created, _ = submit(self.store)  # attach_context 默认 False
        record = self.store.lookup(created["ticket"], created["token"])
        self.assertEqual(record["original"], "")
        self.assertEqual(record["translation"], "")
        self.assertFalse(record["attach_context"])
        created2, _ = submit(
            self.store, where_wrong="另一处不对", attach_context=True
        )
        record2 = self.store.lookup(created2["ticket"], created2["token"])
        self.assertEqual(record2["original"], "The deposit is 300.")
        self.assertTrue(record2["attach_context"])

    def test_10_persists_across_reopen(self):
        """重新打开同一个库（模拟服务重启），编号仍可查、内容还在。"""
        created, _ = submit(self.store)
        self.store.close()
        reopened = FeedbackStore(self.db)
        try:
            record = reopened.lookup(created["ticket"], created["token"])
            self.assertIsNotNone(record)
            self.assertEqual(record["suggestion"], "原话没说币种，应该留空并问对方")
            self.assertEqual(reopened.count(), 1)
        finally:
            reopened.close()
        self.store = reopened  # 已关闭，tearDown 不再重复关

    def test_11_status_can_only_advance_server_side(self):
        created, _ = submit(self.store)
        self.assertFalse(self.store.set_status(created["ticket"], "made-up"))
        self.assertTrue(self.store.set_status(created["ticket"], "analyzing"))
        self.assertEqual(self.store.lookup(created["ticket"], created["token"])["status"], "analyzing")
        self.assertTrue(self.store.set_status(created["ticket"], "fixed", "0.7.0-web.9"))
        record = self.store.lookup(created["ticket"], created["token"])
        self.assertEqual(record["status"], "fixed")
        self.assertEqual(record["fixed_version"], "0.7.0-web.9")


if __name__ == "__main__":
    unittest.main()
