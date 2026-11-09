"""P2 音频时长预算单测：预算按真实秒数扣，WAV 头探测不依赖 PyAV。

这些是纯函数/内存状态测试，不会启动 faster-whisper，也不会产出任何字幕。
真实识别链路的验证在 webapp/e2e/p2-verify.mjs 里跑。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import app as server  # noqa: E402
from engine_asr import _wav_seconds, probe_seconds  # noqa: E402


def make_wav(seconds: float, rate: int = 16000) -> bytes:
    """构造一段 16-bit mono PCM WAV（全静音，只为测时长探测）。"""
    import struct

    frames = int(seconds * rate)
    data = b"\x00\x00" * frames
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", len(data))
    return header + data


class WavProbeTests(unittest.TestCase):
    def test_3s_slice(self) -> None:
        self.assertAlmostEqual(_wav_seconds(make_wav(3.0)), 3.0, places=6)

    def test_half_second_slice(self) -> None:
        self.assertAlmostEqual(_wav_seconds(make_wav(0.5)), 0.5, places=6)

    def test_48k_rate(self) -> None:
        self.assertAlmostEqual(_wav_seconds(make_wav(2.0, 48000)), 2.0, places=6)

    def test_not_wav(self) -> None:
        self.assertIsNone(_wav_seconds(b"OggS" + b"\x00" * 60))

    def test_truncated(self) -> None:
        self.assertIsNone(_wav_seconds(make_wav(1.0)[:40]))

    def test_probe_prefers_wav_header(self) -> None:
        self.assertAlmostEqual(probe_seconds(make_wav(3.0), ".wav"), 3.0, places=6)

    def test_real_sapi_wav(self) -> None:
        """仓库里的合成语音文件：探测值要落在合理范围内（不是 0，不是 60）。"""
        path = HERE / "testdata" / "s1-report.wav"
        if not path.is_file():
            self.skipTest("缺少合成语音测试音频")
        seconds = probe_seconds(path.read_bytes(), ".wav")
        self.assertIsNotNone(seconds)
        self.assertGreater(seconds, 1.0)
        self.assertLess(seconds, 10.0)


class BudgetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = server.Store()
        self.session = self.store.new_session()

    def test_initial_budget(self) -> None:
        self.assertAlmostEqual(
            self.session.audio_seconds_left, server.AUDIO_BUDGET_SECONDS, places=3
        )

    def test_spend_real_seconds(self) -> None:
        allowed, left = self.store.spend_audio_seconds(self.session, 3.0)
        self.assertTrue(allowed)
        self.assertAlmostEqual(left, server.AUDIO_BUDGET_SECONDS - 3.0, places=3)

    def test_many_3s_slices(self) -> None:
        for _ in range(10):
            allowed, _ = self.store.spend_audio_seconds(self.session, 3.0)
            self.assertTrue(allowed)
        self.assertAlmostEqual(
            self.session.audio_seconds_left, server.AUDIO_BUDGET_SECONDS - 30.0, places=3
        )

    def test_exhausted(self) -> None:
        self.session.audio_seconds_left = 2.0
        allowed, left = self.store.spend_audio_seconds(self.session, 3.0)
        self.assertFalse(allowed)
        self.assertAlmostEqual(left, 2.0, places=3)
        # 被拒的请求不许顺手扣预算
        self.assertAlmostEqual(self.session.audio_seconds_left, 2.0, places=3)

    def test_zero_or_negative_rejected(self) -> None:
        self.assertFalse(self.store.spend_audio_seconds(self.session, 0)[0])
        self.assertFalse(self.store.spend_audio_seconds(self.session, -1)[0])

    def test_translate_quota_unchanged(self) -> None:
        """片段识别走秒数预算，不能吃掉手动翻译/识别的次数配额。"""
        before = (
            self.session.translate_left,
            self.session.transcribe_left,
            self.session.reply_left,
        )
        self.store.spend_audio_seconds(self.session, 3.0)
        after = (
            self.session.translate_left,
            self.session.transcribe_left,
            self.session.reply_left,
        )
        self.assertEqual(before, after)

    def test_rate_limit_bucket(self) -> None:
        store = server.Store()
        hits = [store.rate_ok("127.0.0.1") for _ in range(server.RATE_PER_MIN)]
        self.assertTrue(all(hits))
        self.assertFalse(store.rate_ok("127.0.0.1"))
        # 另一个 IP 不受影响
        self.assertTrue(store.rate_ok("10.0.0.2"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
