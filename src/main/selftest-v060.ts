import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { logger } from './logger';
import { getSettingsStore } from './settings-store';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';

/**
 * 0.6.0 的真界面自检（`COPILOT_V060=<输出目录>`）。
 *
 * 和 0.5.0 那份（`selftest-v050.ts`）分开写的原因：那一份验的是「三类字号
 * 能不能各自调、记录能不能落盘」，这一版要验的是**全新的三件交互** ——
 * 点词看读音、双面沟通卡、语言方向与语音状态，外加「早期记录能不能翻出来」。
 * 混在一份里（537 行）改哪一处都得重读全部，风险比收益大。
 *
 * 证据等级：这里全部是真实界面操作（点真按钮、读 DOM、读 IPC 回执）。
 * 它**不**证明语音识别准确、不证明模型翻译质量、也不证明目标使用者能用 ——
 * 那几项在文档里单独标「未执行」。
 */
export async function runV060SelfCheck(win: BrowserWindow) {
  const dir = process.env.COPILOT_V060;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });

  const steps: { name: string; data: unknown }[] = [];
  const record = (name: string, data: unknown) => {
    steps.push({ name, data });
    logger.info('SelfCheck', `v060 ${name}`);
  };

  const shot = async (name: string) => {
    try {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `${name}.png`), image.toPNG());
    } catch (error) {
      logger.warn('SelfCheck', `screenshot ${name} failed: ${String(error).slice(0, 40)}`);
    }
  };

  const js = async <T>(code: string): Promise<T> => {
    try {
      return (await win.webContents.executeJavaScript(code)) as T;
    } catch (error) {
      logger.warn('SelfCheck', `script failed: ${String(error).slice(0, 60)}`);
      return null as unknown as T;
    }
  };

  const waitFor = async (selector: string, tries = 40): Promise<boolean> => {
    for (let i = 0; i < tries; i += 1) {
      const hit = await js<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (hit) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  };

  const original = getSettingsStore().get();
  const demo: Partial<Settings> = {
    mockMode: true,
    demoAutoPlay: false,
    scenarioMode: 'conversation',
    tone: 'auto',
    targetLanguage: 'English',
    nativeLanguage: 'Chinese',
    hintSystem: 'hanzi',
    subtitle: { ...DEFAULT_SETTINGS.subtitle },
  };

  try {
    win.setBounds({ width: 460, height: 640 });
    getSettingsStore().update(demo);
    record('0-settings', { before: original.mockMode, after: 'mock' });

    win.reload();
    await waitFor('[data-quick-actions]');
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // 首次启动的隐私说明会挡住界面，先接受（和 v050 一样）。
    await js(`
      (() => {
        var accept = document.querySelector('[data-privacy-accept]');
        if (accept) accept.click();
        return true;
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // ---- 1. 设置里的四个语言字段 + 方向状态 + 语音状态 -------------------
    await js(`
      (() => {
        var open = document.querySelector('[aria-label="打开设置"]');
        if (open) open.click();
        return true;
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 600));
    record('1-language-settings', await js(`
      (() => {
        var q = function (sel) { return document.querySelector(sel); };
        var text = function (sel) {
          var el = q(sel);
          return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null;
        };
        var direction = q('[data-direction-status]');
        return {
          uiLanguage: text('[data-ui-language]'),
          hasNative: !!q('[data-native-select]'),
          hasTarget: !!q('[data-target-select]'),
          hasHint: !!q('[data-hint-select]'),
          hasAccent: !!q('[data-accent-select]'),
          directionText: direction ? (direction.textContent || '').replace(/\\s+/g, ' ').slice(0, 200) : null,
          voiceText: text('[data-voice-status]'),
          voiceMissingHintShown: (text('[data-voice-status]') || '').indexOf('缺少') >= 0
        };
      })()
    `));
    await shot('01-language-settings');

    // 记下「理解语言 → 提示体系」这一对当前显示值。
    record('2-direction-pair', await js(`
      (async () => {
        var s = await window.copilot.getSettings();
        return {
          ui: s.uiLanguage,
          comprehension: s.nativeLanguage,
          target: s.targetLanguage,
          hint: s.hintSystem,
          accent: s.accent,
          readingHint: s.pronunciation ? s.pronunciation.readingHint : null
        };
      })()
    `));

    // 关掉设置，回首页。设置面板的关闭按钮是那颗「返回」（`data-settings-back`），
    // 不是右上角的叉 —— 写错选择器时界面不会报错，只是后面所有截图都多盖一层面板。
    const closedSettings = await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var back = document.querySelector('[data-settings-back]');
        if (!back) return { ok: false, why: 'no-back-button' };
        back.click();
        for (var i = 0; i < 30 && document.querySelector('[data-settings-back]'); i += 1) await sleep(100);
        return { ok: !document.querySelector('[data-settings-back]') };
      })()
    `);
    record('2b-settings-closed', closedSettings);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // ---- 2. 跑一组样例，拿到真实字幕 -------------------------------------
    await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var more = document.querySelector('[data-more-toggle]');
        if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
        await sleep(200);
        var open = document.querySelector('[data-samples-open]');
        if (open) open.click();
        await sleep(400);
        var run = document.querySelector('[data-sample-run]');
        if (run) run.click();
        await sleep(1500);
        var close = document.querySelector('[data-samples-close]');
        if (close) close.click();
        return true;
      })()
    `);
    if (!(await waitFor('[data-subtitle-item]', 60))) {
      record('3-sample-failed', { items: 0 });
    }

    // ---- 3. 点词看读音：原文与提示行必须同源 ----------------------------
    record('3-word-hints', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var items = [].slice.call(document.querySelectorAll('[data-subtitle-item]'));
        var last = items[items.length - 1] || null;
        if (!last) return { ok: false, why: 'no-subtitle' };
        var words = [].slice.call(last.querySelectorAll('[data-word-seg]'));
        var hints = [].slice.call(last.querySelectorAll('[data-hint-seg]'));
        var saved = last.querySelector('[data-hint-saved]') || last.querySelector('[data-hint-source]');
        if (!words.length) return { ok: false, why: 'no-word-segments', hints: hints.length };
        words[0].click();
        await sleep(200);
        var activeWords = last.querySelectorAll('[data-word-active="true"]').length;
        var activeHints = last.querySelectorAll('[data-hint-active="true"]').length;
        var firstText = words[0].textContent;
        var firstHint = hints.length ? hints[0].textContent : null;
        words[0].click();
        await sleep(150);
        return {
          ok: true,
          words: words.length,
          hints: hints.length,
          sameCount: words.length === hints.length,
          firstWord: firstText,
          firstHint: firstHint,
          activeWordsAfterClick: activeWords,
          activeHintsAfterClick: activeHints,
          savedHintSystem: saved ? (saved.getAttribute('data-hint-saved') || saved.getAttribute('data-hint-source')) : null,
          romanizationText: (last.querySelector('[data-romanization]') || {}).textContent || null
        };
      })()
    `));
    await shot('02-word-hints');

    // ---- 4. 回复面板：释义 / 提示字系 / 分句 / 双面卡入口 ----------------
    record('4-reply-panel', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var more = document.querySelector('[data-more-toggle]');
        if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
        await sleep(250);
        var reply = [].slice.call(document.querySelectorAll('button')).filter(function (b) {
          return (b.textContent || '').trim() === '帮我回复';
        })[0];
        if (!reply) return { ok: false, why: 'no-reply-button' };
        reply.click();
        for (var i = 0; i < 80 && !document.querySelector('[data-reply-panel]'); i += 1) await sleep(250);
        var panel = document.querySelector('[data-reply-panel]');
        if (!panel) return { ok: false, why: 'panel-missing' };
        // 面板先出现、卡片后到（要等一次模型/模拟调用返回），所以等的是卡片。
        for (var k = 0; k < 100 && !document.querySelector('[data-reply-meaning]'); k += 1) await sleep(250);
        panel = document.querySelector('[data-reply-panel]');
        var hint = panel.querySelector('[data-pron-chinese]');
        return {
          ok: true,
          hasMeaning: !!panel.querySelector('[data-reply-meaning]'),
          meaningText: (panel.querySelector('[data-reply-meaning]') || {}).textContent || null,
          hintSystem: hint ? hint.getAttribute('data-hint-system') : null,
          hintText: hint ? hint.textContent : null,
          hasPhrases: !!panel.querySelector('[data-speak-phrases]'),
          hasShowCard: !!panel.querySelector('[data-reply-show]')
        };
      })()
    `));
    await shot('03-reply-panel');

    // ---- 5. 双面卡：打开 / inert / 翻面 / Esc 关闭 / 焦点归还 ------------
    record('5-show-card', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var open = document.querySelector('[data-reply-show]');
        if (!open) return { ok: false, why: 'no-show-button' };
        /*
         * 截图要在卡片**还开着**的时候拍。
         *
         * 上一版把 shot('04-show-card') 放在 Esc 之后，拍到的其实是回复面板 ——
         * 断言（inert / 30px / 焦点归还）都是对的，但截图证明不了双面卡长什么样。
         * 现在拆成三步：开 → 拍对方面 → 翻面 → 拍我方面 → 关。触发按钮存在
         * window 上，跨 executeJavaScript 调用还在。
         */
        window.__scShowTrigger = open;
        open.focus();
        open.click();
        for (var i = 0; i < 30 && !document.querySelector('[data-show-card]'); i += 1) await sleep(100);
        var card = document.querySelector('[data-show-card]');
        if (!card) return { ok: false, why: 'card-missing' };
        // 等一帧：inert 是在 effect 里设的，读到卡片不等于 effect 已经跑过。
        await sleep(200);
        var shell = document.querySelector('[data-app-shell]');
        /*
         * 必须在卡片还开着的时候把值读进变量。
         *
         * 第一版把「shell.inert === true」直接写在最后返回的对象字面量里，
         * 那行是在 Esc 关闭之后才求值的 —— 关闭时 cleanup 已经把 inert 撤了，
         * 于是永远读到 false，看起来像「无障碍没生效」，其实是量错了时机。
         */
        var inertWhileOpen = shell ? shell.inert === true : null;
        var inertAttrWhileOpen = shell ? shell.hasAttribute('inert') : null;
        var themText = (card.querySelector('[data-show-text]') || {}).textContent || '';
        var themFont = card.querySelector('[data-show-text]')
          ? getComputedStyle(card.querySelector('[data-show-text]')).fontSize : null;
        var hasSpeak = !!card.querySelector('[data-show-speak]');
        var hasSlow = !!card.querySelector('[data-show-speak-slow]');
        return {
          ok: true,
          openedShellInert: inertWhileOpen,
          shellInertAttrWhileOpen: inertAttrWhileOpen,
          themTextLength: themText.length,
          themFontSize: themFont,
          hasSpeak: hasSpeak,
          hasSlow: hasSlow,
          cardStillOpen: !!document.querySelector('[data-show-card]')
        };
      })()
    `));
    // 卡片没关，这时拍到的才是「给对方看」那一面。
    await shot('04-show-card-them');

    record('5b-show-card-me', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var card = document.querySelector('[data-show-card]');
        if (!card) return { ok: false, why: 'card-missing' };
        var flip = card.querySelector('[data-show-flip]');
        if (!flip) return { ok: false, why: 'no-flip' };
        flip.click();
        await sleep(250);
        var meCard = document.querySelector('[data-show-card]');
        if (!meCard) return { ok: false, why: 'card-gone-after-flip' };
        var meMeaning = meCard.querySelector('[data-show-meaning]');
        var meHint = meCard.querySelector('[data-show-hint]');
        var meHintSystem = meHint ? meHint.getAttribute('data-hint-system') : null;
        var meText = (meCard.querySelector('[data-show-text]') || {}).textContent || '';
        var meFont = meCard.querySelector('[data-show-text]')
          ? getComputedStyle(meCard.querySelector('[data-show-text]')).fontSize : null;
        var tipWhileOpen = !!meCard.querySelector('[data-show-confirm-tip]');
        return {
          ok: true,
          meHasMeaning: !!meMeaning,
          meMeaningText: meMeaning ? meMeaning.textContent : null,
          meHasHint: !!meHint,
          meHintSystem: meHintSystem,
          meHintText: meHint ? meHint.textContent : null,
          meFontSize: meFont,
          meTextLength: meText.length,
          confirmTipShown: tipWhileOpen,
          cardStillOpen: !!document.querySelector('[data-show-card]')
        };
      })()
    `));
    // 翻到「我」这一面，再拍一张 —— 双面卡两面都要有实物照片。
    await shot('04b-show-card-me');

    record('5c-show-card-close', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(300);
        return {
          ok: !document.querySelector('[data-show-card]'),
          closedAfterEsc: !document.querySelector('[data-show-card]'),
          shellInertAfterClose: (document.querySelector('[data-app-shell]') || {}).inert === true,
          focusBackToTrigger: document.activeElement === window.__scShowTrigger
        };
      })()
    `));

    // ---- 6. 120 条记录：打开最近一段 → 加载更早 --------------------------
    record('6-seed-history', await js(`
      (async () => {
        var id = 'selfcheck-120';
        await window.copilot.historyEnsureSession({
          id: id, language: 'English', scenario: 'conversation', sourceMode: 'online',
          comprehension: 'Chinese', hintSystem: 'hanzi'
        });
        var list = [];
        for (var i = 1; i <= 120; i += 1) {
          list.push({
            id: id + '-m' + i, sessionId: id, seq: i,
            ts: Date.now() - (121 - i) * 1000,
            speaker: 'foreign', source: 'system',
            original: 'Seed line ' + i,
            translation: '第 ' + i + ' 条',
            romanization: '西德 莱恩 ' + i,
            hintSystem: 'hanzi', hintVersion: 2, comprehension: 'Chinese',
            state: 'final'
          });
        }
        var result = await window.copilot.historyUpsert({ sessionId: id, messages: list });
        return { ok: !!(result && result.ok), written: result && result.ok ? result.data.written : null };
      })()
    `));
    await new Promise((resolve) => setTimeout(resolve, 600));

    // 重新载入渲染层：上次记录的入口是在 mount 时查的。
    win.reload();
    await waitFor('[data-quick-actions]');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await js(`
      (() => {
        var accept = document.querySelector('[data-privacy-accept]');
        if (accept) accept.click();
        return true;
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 400));

    record('7-load-earlier', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        for (var i = 0; i < 40 && !document.querySelector('[data-resume-last-open]'); i += 1) await sleep(250);
        var open = document.querySelector('[data-resume-last-open]');
        if (!open) return { ok: false, why: 'no-resume-entry' };
        open.click();
        for (var j = 0; j < 60 && document.querySelectorAll('[data-subtitle-item]').length === 0; j += 1) await sleep(250);
        var firstPage = document.querySelectorAll('[data-subtitle-item]').length;
        var earlier = document.querySelector('[data-load-earlier]');
        if (!earlier) return { ok: false, why: 'no-load-earlier', firstPage: firstPage };
        earlier.click();
        for (var k = 0; k < 60 && document.querySelectorAll('[data-subtitle-item]').length <= firstPage; k += 1) await sleep(250);
        var secondPage = document.querySelectorAll('[data-subtitle-item]').length;
        var topText = (document.querySelector('[data-subtitle-original]') || {}).textContent || '';
        return {
          ok: true,
          firstPage: firstPage,
          secondPage: secondPage,
          grew: secondPage > firstPage,
          topOriginal: topText,
          stillHasLoadEarlier: !!document.querySelector('[data-load-earlier]')
        };
      })()
    `));
    await shot('05-load-earlier');

    // ---- 7. 落盘：字号与语言方向在重开后还在 -----------------------------
    record('8-persisted', await js(`
      (async () => {
        var s = await window.copilot.getSettings();
        return {
          original: s.subtitle.originalFontSize,
          translation: s.subtitle.translationFontSize,
          romanization: s.subtitle.romanizationFontSize,
          readingVersion: s.readingVersion,
          comprehension: s.nativeLanguage,
          hint: s.hintSystem,
          accent: s.accent
        };
      })()
    `));
    // ---- 9. 确认卡：改了值之后，句子和释义必须同源 -----------------------
    record('9-fact-confirm', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var setValue = function (input, value) {
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        var rows = function () {
          return [].slice.call(document.querySelectorAll('[data-fact-row]'));
        };
        var findByText = function (needle) {
          var list = rows();
          for (var i = 0; i < list.length; i += 1) {
            var text = (list[i].textContent || '').replace(/\s/g, '');
            if (text.indexOf(needle) >= 0) return list[i];
          }
          return null;
        };
        var edit = async function (row, value) {
          var btn = row.querySelector('[data-fact-action="edit"]');
          if (!btn) return false;
          btn.click();
          await sleep(250);
          var input = row.querySelector('[data-fact-edit-input]');
          if (!input) return false;
          setValue(input, value);
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await sleep(400);
          return true;
        };

        // 跑「会议改到周四 10:30」：原话里有 10:30，也有被否定的 Tuesday。
        var more = document.querySelector('[data-more-toggle]');
        if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
        await sleep(200);
        var open = document.querySelector('[data-samples-open]');
        if (open) open.click();
        await sleep(400);
        var run = document.querySelector('[data-sample-run="sample-moved"]');
        if (run) run.click();
        await sleep(1800);
        var close = document.querySelector('[data-samples-close]');
        if (close) close.click();
        await sleep(300);

        var toggle = document.querySelector('[data-fact-toggle]');
        if (!toggle) return { ok: false, why: 'no-fact-panel' };
        if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
        await sleep(400);

        var timeRow = findByText('10:30');
        if (!timeRow) {
          return { ok: false, why: 'no-time-row', rows: rows().map(function (row) { return row.textContent; }) };
        }
        var before = timeRow.textContent || '';
        if (!(await edit(timeRow, '11:30'))) return { ok: false, why: 'edit-failed' };
        var afterEdit = (findByText('11:30') || timeRow).textContent || '';

        var checkbox = timeRow.querySelector('input[type="checkbox"]');
        if (!checkbox) return { ok: false, why: 'no-checkbox' };
        if (!checkbox.checked) checkbox.click();
        await sleep(200);

        var confirmBtn = document.querySelector('[data-fact-confirm]');
        if (!confirmBtn) return { ok: false, why: 'no-confirm-button' };
        confirmBtn.click();
        var draft = null;
        for (var i = 0; i < 24; i += 1) {
          await sleep(250);
          draft = document.querySelector('[data-fact-draft]');
          if (draft) break;
        }
        var paragraphs = draft ? [].slice.call(draft.querySelectorAll('p')) : [];
        var english = paragraphs.length ? paragraphs[0].textContent || '' : '';
        var chinese = paragraphs.length > 1 ? paragraphs[1].textContent || '' : '';
        var errorBox = document.querySelector('[data-fact-error]');
        var saveNode = document.querySelector('[data-fact-save-state]');

        // 再把日期改成「还没定」：推不出外语说法 → 必须出现「需补说法」，
        // 并且上一条确认句作废（不能拿改了之前生成的句子继续用）。
        var dateRow = findByText('Thursday') || findByText('周四');
        var needWording = false;
        var draftCleared = false;
        var moneyEdited = false;
        if (dateRow) {
          moneyEdited = await edit(dateRow, '还没定');
          needWording = !!document.querySelector('[data-fact-need-wording]');
          draftCleared = !document.querySelector('[data-fact-draft]');
        }

        // 已确认的行再改值 → 必须回到「待确认」，旧确认不能给新值背书。
        var statusBefore = 'skipped';
        var statusAfter = 'skipped';
        var timeRow2 = findByText('11:30');
        if (timeRow2) {
          var rowConfirm = timeRow2.querySelector('[data-fact-action="confirm"]');
          if (rowConfirm) {
            rowConfirm.click();
            await sleep(300);
          }
          statusBefore = (timeRow2.textContent || '').indexOf('已确认') >= 0 ? '已确认' : 'other';
          if (await edit(timeRow2, '12:30')) {
            await sleep(300);
            var editedRow = findByText('12:30') || timeRow2;
            var editedText = editedRow.textContent || '';
            statusAfter = editedText.indexOf('已确认') >= 0 ? '已确认' : editedText.indexOf('待确认') >= 0 ? '待确认' : 'other';
          }
        }

        return {
          ok: Boolean(draft),
          statusBefore: statusBefore,
          statusAfter: statusAfter,
          before: before,
          afterEdit: afterEdit,
          english: english,
          chinese: chinese,
          englishHasNew: english.indexOf('11:30') >= 0,
          englishHasOld: english.indexOf('10:30') >= 0,
          chineseHasNew: chinese.indexOf('11:30') >= 0,
          chineseHasOld: chinese.indexOf('10:30') >= 0,
          moneyEdited: moneyEdited,
          needWording: needWording,
          draftClearedAfterEdit: draftCleared,
          error: errorBox ? errorBox.textContent : null,
          factSaveState: saveNode ? saveNode.getAttribute('data-fact-save-state') : null
        };
      })()
    `));
    await shot('07-fact-confirm');

  } catch (error) {
    logger.error('SelfCheck', `v060 aborted: ${String(error).slice(0, 80)}`);
  } finally {
    fs.writeFileSync(path.join(dir, 'v060-selfcheck.json'), JSON.stringify(steps, null, 2), 'utf8');
    // 还原设置：不能把演示模式 / 小窗口留给用户。
    try {
      getSettingsStore().update({
        mockMode: original.mockMode,
        scenarioMode: original.scenarioMode,
        targetLanguage: original.targetLanguage,
        nativeLanguage: original.nativeLanguage,
        hintSystem: original.hintSystem,
        accent: original.accent,
        subtitle: original.subtitle,
        tone: original.tone,
      });
      if (original.window.bounds) win.setBounds(original.window.bounds);
    } catch (error) {
      logger.warn('SelfCheck', `restore settings failed: ${String(error).slice(0, 40)}`);
    }
    await shot('06-final');
    logger.info('SelfCheck', `v060 done: ${steps.length} steps -> ${dir}`);
  }
}
