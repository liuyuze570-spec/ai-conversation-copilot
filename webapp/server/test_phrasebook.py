"""常用语库与译文后处理回归测试。

压三件必须保住的事：
  1. 拼写变体要能查到（`hellow` 是截图里真实出现过的输入）；
  2. 查表命中不能给出明显错误的译文（这是「优先于模型」的前提）；
  3. 句尾复述修剪只砍残句，**不许砍掉用户本来就说的话**。

跑法：`cd webapp/server && ./.venv/Scripts/python.exe -m unittest test_phrasebook -v`
"""

from __future__ import annotations

import unittest

from phrasebook import drop_repeated_tail, looks_degenerate, lookup


class LookupTest(unittest.TestCase):
    def test_spelling_variant_is_corrected(self) -> None:
        hit = lookup("hellow", "en")
        self.assertIsNotNone(hit)
        assert hit is not None
        self.assertEqual(hit.translation, "你好")
        self.assertEqual(hit.key, "hello")
        self.assertTrue(hit.corrected)

    def test_sentence_and_word_kinds(self) -> None:
        sentence = lookup("How are you?", "en")
        word = lookup("meeting", "en")
        self.assertEqual(sentence.kind if sentence else None, "sentence")
        self.assertEqual(word.kind if word else None, "word")

    def test_cjk_greetings(self) -> None:
        for source, language, expected in (
            ("こんにちは", "ja", "你好"),
            ("안녕하세요", "ko", "你好"),
            ("Здравствуйте", "ru", "您好"),
        ):
            hit = lookup(source, language)
            self.assertIsNotNone(hit, f"{language} 问候语没查到：{source}")
            assert hit is not None
            self.assertEqual(hit.translation, expected)
            self.assertFalse(hit.corrected)

    def test_english_table_not_used_for_other_languages(self) -> None:
        """拿英文表去匹配日语原文只会误命中，语种必须分开查。"""
        self.assertIsNone(lookup("hello", "ja"))


class DegenerateTest(unittest.TestCase):
    def test_catches_known_failures(self) -> None:
        for source, out in (
            ("hello", "哈哈哈哈哈哈哈哈哈"),
            ("hi", "hi hi hi"),
            ("hellow", "hellow"),
            ("Good morning", "早早早早早"),
            ("hello", ""),
        ):
            bad, why = looks_degenerate(source, out)
            self.assertTrue(bad, f"没抓住退化：{out!r}")
            self.assertTrue(why)

    def test_keeps_normal_output(self) -> None:
        for source, out in (
            ("hello", "你好"),
            ("Good morning", "早上好"),
            ("See you tomorrow.", "明天见。"),
        ):
            bad, why = looks_degenerate(source, out)
            self.assertFalse(bad, f"误判成退化：{out!r} ({why})")


class TailTrimTest(unittest.TestCase):
    def test_trims_echoed_tail(self) -> None:
        for raw, expected in (
            ("三点见,三点", "三点见"),
            ("明天见,明天", "明天见"),
            ("明天的会议几点了?,明天", "明天的会议几点了?"),
            ("好,好", "好"),
        ):
            self.assertEqual(drop_repeated_tail(raw), expected)

    def test_keeps_legitimate_sentences(self) -> None:
        for text in (
            "我们三点见,三点之前到",
            "你好,谢谢",
            "一,二,三",
            "明天的会议是三点,地点在二楼",
            "没有标点的正常句子",
            "",
        ):
            self.assertEqual(drop_repeated_tail(text), text)


if __name__ == "__main__":
    unittest.main()
