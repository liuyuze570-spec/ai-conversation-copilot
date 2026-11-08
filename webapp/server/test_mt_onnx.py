"""本地翻译（进程内 ONNX）回归测试。

断言只压「必须保住的东西」：时间点、金额、否定词、以及同一次输入两次结果一致。
不压整句措辞 —— 换模型版本时措辞会变，但对听障使用者来说，数字错了才是事故。

跑法：`cd webapp/server && ./.venv/Scripts/python.exe -m unittest test_mt_onnx -v`
"""

from __future__ import annotations

import unittest

from engine_mt_onnx import OnnxOpusMT

CASES = [
    # 英文原文，中文译文里必须出现的片段（每个片段都要在）
    ("Please send the report by 3 p.m. tomorrow.", ["明天", "3"]),
    ("The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m.",
     ["星期二", "星期四", "10", "30"]),
    ("The budget is fifteen thousand, not fifty thousand.", ["一万五千", "五万"]),
    ("I will bring the blue folder to the office at 4.15 p.m. on Friday.",
     ["星期五", "4", "15"]),
]


class LocalMtTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.engine = OnnxOpusMT()
        if not cls.engine.available:
            raise unittest.SkipTest(f"本地翻译模型不可用：{cls.engine.detail}")
        cls.engine.warmup()

    def test_model_reports_itself_as_real(self) -> None:
        self.assertEqual(self.engine.mode, "local-onnx")
        self.assertTrue(self.engine.available)

    def test_keeps_numbers_times_and_negation(self) -> None:
        for source, must in CASES:
            with self.subTest(source=source):
                result = self.engine.translate(source)
                self.assertGreater(result.elapsed_ms, 0)
                self.assertEqual(result.mode, "local-onnx")
                self.assertTrue(result.translation.strip(), "译文不能为空")
                for fragment in must:
                    self.assertIn(fragment, result.translation,
                                  f"译文丢了「{fragment}」：{result.translation}")

    def test_negation_survives(self) -> None:
        """否定被翻丢是这类场景最危险的错误，单独压一条。"""
        out = self.engine.translate(
            "The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m."
        ).translation
        self.assertTrue(("不" in out) or ("没" in out), f"否定可能被丢了：{out}")

    def test_same_input_same_output(self) -> None:
        source = "The budget is fifteen thousand, not fifty thousand."
        first = self.engine.translate(source).translation
        second = self.engine.translate(source).translation
        self.assertEqual(first, second, "同一输入两次结果不同，解码不可复现")

    def test_never_returns_english_only(self) -> None:
        """整句必须出现中文，防止模型没加载却返回原文冒充翻译。"""
        out = self.engine.translate("Please send the report by 3 p.m. tomorrow.").translation
        self.assertTrue(any("\u4e00" <= ch <= "\u9fff" for ch in out), f"没有中文：{out}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
