"""生成离线验证用的新句子音频（不在任何预置样例里）。

用户要求离线证据不能只靠那三组样例，所以这里另造两句：
- o1：时间 + 站台，含数字和相对时间
- o2：否定 + 更正 + 金额，是这类场景最容易翻错的结构

跑法：`.venv/Scripts/python.exe _tts_offline.py`
"""

import sys
from pathlib import Path

import win32com.client as win32

TEXTS = {
    "o1-platform.wav": "The train leaves at seven forty-five from platform two.",
    "o2-notlater.wav": "The delivery is not on Friday. It will arrive next Monday at 9 a.m.",
}

out = Path(sys.argv[1] if len(sys.argv) > 1 else "testdata/offline")
out.mkdir(parents=True, exist_ok=True)

voice = win32.Dispatch("SAPI.SpVoice")
tokens = voice.GetVoices()
eng = None
for i in range(tokens.Count):
    desc = tokens.Item(i).GetDescription()
    if "English" in desc or "en-US" in desc:
        eng = tokens.Item(i)
if eng is None:
    raise SystemExit("没有可用的英语语音")
voice.Voice = eng

stream = win32.Dispatch("SAPI.SpFileStream")
for name, text in TEXTS.items():
    path = out / name
    if path.exists():
        path.unlink()
    stream.Open(str(path), 3, False)
    voice.AudioOutputStream = stream
    voice.Speak(text)
    stream.Close()
    print(f"{path} {path.stat().st_size} 字节 <- {text}")
