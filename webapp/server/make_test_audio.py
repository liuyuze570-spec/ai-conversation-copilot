"""用系统 SAPI 合成三句英语测试音频（只用于自动化测试，不是真人录音）。

产物写到 webapp/server/testdata/*.wav，同时在 meta.json 里记下：
- 合成用的语音名、语速
- 生成时间
这样测试报告里能说清「这段音频是怎么来的」，不会让人误以为是真人录音。
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path

import pyttsx3

OUT = Path(__file__).resolve().parent / "testdata"
OUT.mkdir(exist_ok=True)

LINES = {
    "s1-report.wav": "Please send the report by 3 p.m. tomorrow.",
    "s2-meeting.wav": "The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m.",
    "s3-budget.wav": "The budget is fifteen thousand, not fifty thousand.",
    # 离线验收要用「从未写入样例库」的新句子。
    "s4-new.wav": "I will bring the blue folder to the office at 4:15 p.m. on Friday.",
}

engine = pyttsx3.init()
voices = engine.getProperty("voices")
english = next((voice for voice in voices if "en" in str(voice.languages).lower() or "English" in voice.name), None)
if english is None:
    print("没有英语语音，无法合成测试音频", file=sys.stderr)
    sys.exit(2)
engine.setProperty("voice", english.id)
engine.setProperty("rate", 165)

meta = {
    "generated_at": datetime.now().isoformat(timespec="seconds"),
    "engine": "Windows SAPI5 via pyttsx3",
    "voice": english.name,
    "voice_id": english.id,
    "rate": 165,
    "note": "合成语音，仅用于自动化测试；不是真人录音，不能用于评价识别准确率。",
    "files": [],
}

for name, text in LINES.items():
    target = OUT / name
    if target.exists():
        target.unlink()
    engine.save_to_file(text, os.fspath(target))
    engine.runAndWait()
    meta["files"].append({"file": name, "text": text, "bytes": target.stat().st_size})

(OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(meta, ensure_ascii=False, indent=2))
