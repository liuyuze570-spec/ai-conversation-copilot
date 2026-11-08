import win32com.client as win32
from pathlib import Path
out = Path('testdata'); out.mkdir(exist_ok=True)
voice = win32.Dispatch('SAPI.SpVoice')
tokens = voice.GetVoices()
eng = None
for i in range(tokens.Count):
    t = tokens.Item(i)
    desc = t.GetDescription()
    print(i, desc)
    if 'English' in desc or 'en-US' in desc:
        eng = t
if eng is None:
    raise SystemExit('no english voice')
voice.Voice = eng
texts = {
 's1-report.wav': 'Please send the report by 3 p.m. tomorrow.',
 's2-meeting.wav': 'The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m.',
 's3-budget.wav': 'The budget is fifteen thousand, not fifty thousand.',
 's4-new.wav': 'I will bring the blue folder to the office at 4:15 p.m. on Friday.',
}
stream = win32.Dispatch('SAPI.SpFileStream')
for name, text in texts.items():
    path = out / name
    if path.exists(): path.unlink()
    stream.Open(str(path), 3, False)
    voice.AudioOutputStream = stream
    voice.Speak(text)
    stream.Close()
    print(name, path.stat().st_size)
