/**
 * 朗读（系统语音）的语言核验。
 *
 * 用户实测过的故障：点「朗读」，界面显示在念，耳机里是一段英语腔的日语 ——
 * 因为找不到 ja-JP 语音时旧实现退到 `voices[0]`。第二个故障：语音引擎
 * `onerror` 被当成 `onend`，界面显示「播放成功」，其实一点声音都没有。
 *
 * 这个文件把两条都钉成断言。用桩替换 `window.speechSynthesis`，
 * 不发声、不依赖本机装了哪些语音，跑的是 `dist/services/tts/web-speech.js`
 * 里那份真代码。
 *
 * 运行：node .dev/tts-unit.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let passed = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail ? `  →  ${detail}` : ''}`);
}

function eq(label, actual, expected) {
  check(label, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// --------------------------------------------------------------------------- //
// 桩：一个可以控制「念完了 / 报错了」的语音引擎
// --------------------------------------------------------------------------- //
class Utterance {
  constructor(text) {
    this.text = text;
    this.lang = '';
    this.rate = 1;
    this.pitch = 1;
    this.voice = null;
    this.onend = null;
    this.onerror = null;
  }
}

let voices = [];
let spoken = [];
const synth = {
  getVoices: () => voices,
  speak: (utterance) => spoken.push(utterance),
  cancel: () => {},
};

globalThis.SpeechSynthesisUtterance = Utterance;
globalThis.window = { speechSynthesis: synth };

const { WebSpeechTTS } = require('../dist/services/tts/web-speech.js');

/** 每种语言装几个语音，然后返回一个新引擎（语音缓存是实例级的）。 */
function engineWith(list) {
  voices = list.map(([name, lang]) => ({ name, lang }));
  spoken = [];
  return new WebSpeechTTS();
}

const EN = ['Microsoft Zira', 'en-US'];
const JA = ['Microsoft Haruka', 'ja-JP'];

// --------------------------------------------------------------------------- //
// A. 有对应语言 → 用它，并 resolve
// --------------------------------------------------------------------------- //
{
  const tts = engineWith([EN, JA]);
  let settled = 'pending';
  const p = tts.speak({ text: 'こんにちは', lang: 'ja-JP' }).then(
    () => (settled = 'resolved'),
    (error) => (settled = `rejected:${error.code ?? error.message}`),
  );
  const utterance = spoken[0];
  eq('A 交出去一条', spoken.length, 1);
  eq('A 用的是日语语音', utterance.voice?.name, 'Microsoft Haruka');
  eq('A lang 跟着语音走', utterance.lang, 'ja-JP');
  eq('A 文本原样', utterance.text, 'こんにちは');
  utterance.onend();
  await p;
  eq('A 念完 = resolve', settled, 'resolved');
}

// --------------------------------------------------------------------------- //
// B. 没有对应语言 → 报错，不许拿英语顶上
// --------------------------------------------------------------------------- //
{
  const tts = engineWith([EN]);
  let code = '';
  let lang = '';
  await tts.speak({ text: '안녕하세요', lang: 'ko-KR' }).catch((error) => {
    code = error.code ?? '';
    lang = error.lang ?? '';
  });
  eq('B 缺韩语语音要报 TTS_LANG_UNAVAILABLE', code, 'TTS_LANG_UNAVAILABLE');
  eq('B 报错里带上是哪种语言', lang, 'ko-KR');
  eq('B 根本没有交出去念（不会用英语腔读韩语）', spoken.length, 0);
}

// --------------------------------------------------------------------------- //
// C. 用户指定的语音名不属于目标语言 → 不采用
// --------------------------------------------------------------------------- //
{
  const tts = engineWith([EN, JA]);
  const p = tts.speak({ text: 'おはよう', lang: 'ja-JP', voice: 'Microsoft Zira' });
  const utterance = spoken[0];
  eq('C 指定的英语语音不被采用', utterance.voice?.name, 'Microsoft Haruka');
  eq('C lang 仍是日语', utterance.lang, 'ja-JP');
  utterance.onend();
  await p;
}

// --------------------------------------------------------------------------- //
// D. 语音列表还没加载完（空）→ 仍然念，但 lang 要写对
// --------------------------------------------------------------------------- //
{
  const tts = engineWith([]);
  const p = tts.speak({ text: 'hello', lang: 'en-GB' });
  const utterance = spoken[0];
  eq('D 空列表时仍然交给系统念', spoken.length, 1);
  eq('D 没有语音时 lang 用请求里的', utterance.lang, 'en-GB');
  eq('D 没有语音时不强行绑一个别的语言', utterance.voice, null);
  utterance.onend();
  await p;
}

// --------------------------------------------------------------------------- //
// E. onerror 不等于念完了
// --------------------------------------------------------------------------- //
{
  const tts = engineWith([EN]);
  let outcome = 'pending';
  const p = tts
    .speak({ text: 'hello', lang: 'en-US' })
    .then(() => (outcome = 'resolved'))
    .catch((error) => (outcome = `rejected:${error.code}:${error.detail}`));
  spoken[0].onerror({ error: 'synthesis-failed' });
  await p;
  eq('E 引擎报错要 reject（不能当成功）', outcome, 'rejected:TTS_FAILED:synthesis-failed');
}

// --------------------------------------------------------------------------- //
// F. 停止：安静收场，不弹错
// --------------------------------------------------------------------------- //
{
  const tts = engineWith([EN]);
  let outcome = 'pending';
  const p = tts
    .speak({ text: 'a long sentence', lang: 'en-US' })
    .then(() => (outcome = 'resolved'))
    .catch(() => (outcome = 'rejected'));
  tts.stop();
  await p;
  eq('F stop() 只 resolve，不 reject', outcome, 'resolved');

  // stop 之后迟到的事件不许把状态改回去。
  let again = 'resolved';
  spoken[0].onerror({ error: 'interrupted' });
  again = outcome;
  eq('F 迟到的事件被忽略', again, 'resolved');
}

// --------------------------------------------------------------------------- //
// G. 语音清单查询（界面要用它显示「当前语音 / 缺少语音」）
// --------------------------------------------------------------------------- //
{
  const tts = engineWith([EN, JA]);
  eq('G 查日语语音', tts.voicesFor('ja-JP').length, 1);
  eq('G 查日语语音名', tts.voicesFor('ja-JP')[0].name, 'Microsoft Haruka');
  eq('G 查不存在的韩语语音', tts.voicesFor('ko-KR').length, 0);
  eq('G 列全部语音', tts.listVoices().length, 2);
  // 只比语言前缀：ja 与 ja-JP 都算日语。
  eq('G 语言前缀匹配 ja', tts.voicesFor('ja').length, 1);
}

// --------------------------------------------------------------------------- //
// H. 慢速是真的慢（rate 传下去）
// --------------------------------------------------------------------------- //
{
  const tts = engineWith([EN]);
  const p = tts.speak({ text: 'slow down', lang: 'en-US', speed: 0.75 });
  eq('H 0.75 倍速传给引擎', spoken[0].rate, 0.75);
  spoken[0].onend();
  await p;

  const p2 = tts.speak({ text: 'too slow', lang: 'en-US', speed: 0.1 });
  eq('H 过慢被压到 0.5（系统下限）', spoken[1].rate, 0.5);
  spoken[1].onend();
  await p2;
}

// --------------------------------------------------------------------------- //
console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条`);
if (failures.length) {
  for (const line of failures) console.log(`  ✗ ${line}`);
  process.exit(1);
}
