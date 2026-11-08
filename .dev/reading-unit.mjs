/**
 * 字号（三类独立）+ 只迁移一次 + 重启保留 —— 纯函数与设置迁移的单元测试。
 *
 * 为什么单独一个文件：这一组规则以前写在渲染路径上（`readingPrefs()` 里边读
 * 边把 15 改成 18），只能靠「打开软件看看字号」来验证，于是回归了也没人发现。
 * 现在迁移挪到主进程，用真的 settings.json 跑一遍，断言能落在数字上。
 *
 * 覆盖：
 *   A. 三类字号互不推动（`adjustFontSize` 只动被选中的那一类）
 *   B. 连续从 12 调到 30，15 和 23 都要原样保留（不许被当成「旧默认」改掉）
 *   C. 0.4.0 的旧设置（原文 15 / 译文 23、没有 readingVersion）升级一次 → 18 / 24
 *   D. 用户主动选 15 / 23（readingVersion 已经是 2）→ 重启后仍然是 15 / 23
 *   E. 全新安装 → 直接用 18 / 24，不需要迁移
 *   F. 迁移结果真的写进磁盘（不是只改了内存）
 *
 * 不联网、不碰用户真实的 settings.json（全程临时目录 + electron 桩）。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

const require = createRequire(import.meta.url);

const ROOT = path.join(os.tmpdir(), `copilot-reading-test-${process.pid}`);
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const electronEntry = require.resolve('electron');

/**
 * 用一个新的临时用户目录「启动一次软件」。
 *
 * 必须清掉 `settings-store` 的 require 缓存 —— 它是个单例，不清就等于
 * 一直读第一次那份对象，测不出「重启之后还对不对」。
 */
function boot(dir) {
  require.cache[electronEntry] = {
    id: electronEntry,
    filename: electronEntry,
    loaded: true,
    exports: {
      app: {
        getPath: () => dir,
        on: () => undefined,
        whenReady: () => Promise.resolve(),
        getVersion: () => '0.0.0-test',
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.from(''),
        decryptString: () => '',
      },
    },
  };
  delete require.cache[require.resolve('../dist/main/settings-store.js')];
  const mod = require('../dist/main/settings-store.js');
  return mod.getSettingsStore();
}

function writeSettings(dir, value) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(value, null, 2), 'utf8');
}

function readSettings(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
}

let total = 0;
let failed = 0;

function eq(actual, expected, msg) {
  total += 1;
  try {
    assert.deepStrictEqual(actual, expected);
  } catch {
    failed += 1;
    console.log(
      `  FAIL ${msg}\n    实际: ${JSON.stringify(actual)}\n    期望: ${JSON.stringify(expected)}`,
    );
  }
}

function ok(cond, msg, extra) {
  total += 1;
  if (!cond) {
    failed += 1;
    console.log(`  FAIL ${msg}${extra === undefined ? '' : ' -> ' + extra}`);
  }
}

const reading = require('../dist/shared/reading.js');

// ---------------------------------------------------------------------------
console.log('A. 三类字号互不推动');
{
  const base = reading.readingPrefs({
    originalFontSize: 18,
    translationFontSize: 24,
    romanizationFontSize: 18,
  });
  eq(base.originalFontSize, 18, 'A1 原文默认 18');
  eq(base.translationFontSize, 24, 'A2 译文默认 24（不再等于原文减 2）');
  eq(base.romanizationFontSize, 18, 'A3 谐音默认 18（不再等于原文减 3）');

  const biggerOriginal = reading.adjustFontSize(base, 'original', 4);
  eq(biggerOriginal.originalFontSize, 22, 'A4 调大原文生效');
  eq(biggerOriginal.translationFontSize, 24, 'A5 调原文不动译文');
  eq(biggerOriginal.romanizationFontSize, 18, 'A6 调原文不动谐音');

  const biggerTranslation = reading.adjustFontSize(base, 'translation', 6);
  eq(biggerTranslation.translationFontSize, 30, 'A7 调大译文生效');
  eq(biggerTranslation.originalFontSize, 18, 'A8 调译文不动原文');
  eq(biggerTranslation.romanizationFontSize, 18, 'A9 调译文不动谐音');

  const biggerRoman = reading.adjustFontSize(base, 'romanization', 3);
  eq(biggerRoman.romanizationFontSize, 21, 'A10 调大谐音生效');
  eq(biggerRoman.originalFontSize, 18, 'A11 调谐音不动原文');
  eq(biggerRoman.translationFontSize, 24, 'A12 调谐音不动译文');
}

// ---------------------------------------------------------------------------
console.log('B. 连续调过 15 / 23，不许被「迁移」掉');
{
  // 模拟用户用 A+ 一路从 12 点到 30：每一步都从当前 prefs 出发。
  let prefs = reading.readingPrefs({
    originalFontSize: 12,
    translationFontSize: 12,
    romanizationFontSize: 12,
  });
  const seenOriginal = new Set();
  for (let i = 0; i < 18; i += 1) {
    prefs = reading.adjustFontSize(prefs, 'original', 1);
    seenOriginal.add(prefs.originalFontSize);
  }
  ok(seenOriginal.has(15), 'B1 原文调到过 15');
  ok(seenOriginal.has(23), 'B2 原文调到过 23');
  eq(prefs.originalFontSize, 30, 'B3 连点到 30 就是 30');
  eq(prefs.translationFontSize, 12, 'B4 连点原文没把译文带上去');
  eq(prefs.romanizationFontSize, 12, 'B5 连点原文没把谐音带上去');

  // 读回来（相当于 React 重渲染 / 重新读设置）时 15、23 必须还在。
  const at15 = reading.readingPrefs({ originalFontSize: 15, translationFontSize: 24 });
  eq(at15.originalFontSize, 15, 'B6 readingPrefs 不再把 15 改成 18');
  const at23 = reading.readingPrefs({ originalFontSize: 18, translationFontSize: 23 });
  eq(at23.translationFontSize, 23, 'B7 readingPrefs 不再把 23 改成 24');

  // 范围钳制还在（12–64），但只钳范围，不做版本迁移。
  eq(reading.readingPrefs({ originalFontSize: 5 }).originalFontSize, 12, 'B8 低于 12 钳到 12');
  eq(reading.readingPrefs({ translationFontSize: 200 }).translationFontSize, 64, 'B9 高于 64 钳到 64');
}

// ---------------------------------------------------------------------------
console.log('C. 0.4.0 旧设置升级一次');
const legacyDir = path.join(ROOT, 'legacy');
{
  // 0.4.0 落盘的样子：原文 15 / 译文 23，没有 readingVersion。
  writeSettings(legacyDir, {
    targetLanguage: 'English',
    nativeLanguage: 'Chinese',
    subtitle: { originalFontSize: 15, translationFontSize: 23 },
  });
  const store = boot(legacyDir);
  const s = store.get().subtitle;
  eq(s.originalFontSize, 18, 'C1 旧默认 15 → 18');
  eq(s.translationFontSize, 24, 'C2 旧默认 23 → 24');
  eq(s.romanizationFontSize, 18, 'C3 谐音补上默认 18');
  eq(store.get().readingVersion, 2, 'C4 迁移标记写回 2');

  const disk = readSettings(legacyDir);
  eq(disk.subtitle.originalFontSize, 18, 'C5 迁移结果落盘（不是只改内存）');
  eq(disk.readingVersion, 2, 'C6 迁移标记也落盘了');
}

// ---------------------------------------------------------------------------
console.log('D. 用户主动选 15 / 23（已迁移过）→ 重启保留');
{
  // 用户自己把原文调到 15、译文调到 23，readingVersion 已经是 2。
  writeSettings(legacyDir, {
    readingVersion: 2,
    subtitle: { originalFontSize: 15, translationFontSize: 23, romanizationFontSize: 20 },
  });
  const store = boot(legacyDir);
  const s = store.get().subtitle;
  eq(s.originalFontSize, 15, 'D1 用户选的 15 保留');
  eq(s.translationFontSize, 23, 'D2 用户选的 23 保留');
  eq(s.romanizationFontSize, 20, 'D3 用户选的谐音 20 保留');

  // 再启动一次（真的重新 require），还是 15 / 23 —— 不会每次启动都迁移。
  const again = boot(legacyDir);
  eq(again.get().subtitle.originalFontSize, 15, 'D4 第二次启动仍然是 15');
  eq(again.get().subtitle.translationFontSize, 23, 'D5 第二次启动仍然是 23');
  eq(again.get().readingVersion, 2, 'D6 版本标记没被反复改写');
}

// ---------------------------------------------------------------------------
console.log('E. 全新安装');
const freshDir = path.join(ROOT, 'fresh');
{
  const store = boot(freshDir);
  const s = store.get().subtitle;
  eq(s.originalFontSize, 18, 'E1 新装原文 18');
  eq(s.translationFontSize, 24, 'E2 新装译文 24');
  eq(s.romanizationFontSize, 18, 'E3 新装谐音 18');
  eq(store.get().readingVersion, 2, 'E4 新装直接标记为已迁移，不再走 15→18');
  eq(store.get().hintSystem, 'hanzi', 'E5 新装默认汉字近音（中文理解）');
  eq(store.get().accent, 'en-US', 'E6 新装默认 en-US 口音');
  eq(store.get().uiLanguage, 'zh-CN', 'E7 界面语言固定简体中文');
}

// ---------------------------------------------------------------------------
console.log('F. 语言方向迁移（理解语言 → 默认提示体系）');
{
  const dir = path.join(ROOT, 'ja');
  // 一个把理解语言设成日语、但还没有 hintSystem 的老设置。
  writeSettings(dir, { nativeLanguage: 'Japanese', targetLanguage: 'English' });
  const store = boot(dir);
  const s = store.get();
  eq(s.hintSystem, 'katakana', 'F1 日语理解者默认给片假名，不给汉字谐音');
  eq(s.accent, 'en-US', 'F2 目标英语补上 en-US');

  const dir2 = path.join(ROOT, 'en-ja');
  writeSettings(dir2, { nativeLanguage: 'English', targetLanguage: 'Japanese' });
  const store2 = boot(dir2);
  eq(store2.get().hintSystem, 'romaji', 'F3 英语理解者看日语默认给罗马字');
  eq(store2.get().accent, 'ja-JP', 'F4 目标日语补上 ja-JP');

  // 用户自己选过就不要再改。
  const dir3 = path.join(ROOT, 'kept');
  writeSettings(dir3, {
    nativeLanguage: 'Japanese',
    targetLanguage: 'English',
    hintSystem: 'romaji',
  });
  const store3 = boot(dir3);
  eq(store3.get().hintSystem, 'romaji', 'F5 用户选过的提示体系不被迁移覆盖');
}

// ---------------------------------------------------------------------------
fs.rmSync(ROOT, { recursive: true, force: true });

console.log(failed === 0 ? `\nRESULT PASS ${total}/${total}` : `\nRESULT FAIL ${failed}/${total}`);
process.exit(failed === 0 ? 0 : 1);
