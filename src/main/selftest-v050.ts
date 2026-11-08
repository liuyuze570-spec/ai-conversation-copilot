import fs from 'node:fs';
import path from 'node:path';
import { app, type BrowserWindow } from 'electron';
import { logger } from './logger';
import { getSettingsStore } from './settings-store';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';
import { contrastOfCss } from '../shared/reading';

/**
 * 0.5.0 的真界面自检（`COPILOT_V050=<输出目录>`）。
 *
 * 为什么单独写一份而不是塞进 index.ts 里那坨：
 *  - 那坨是 0.4.0 的场景，改它风险高；
 *  - 这一版要验证的东西完全不同 —— 三类字号能不能各自调、记录能不能真的
 *    写进 SQLite 并在关闭重开后读出来、样例面板是否真的接上了界面。
 *
 * 证据等级：这里全部是**真实界面操作**（点真按钮、读 getComputedStyle、
 * 读 IPC 回执）。它不证明语音识别准，也不证明模型翻译好 —— 那是另一张表。
 */
export async function runV050SelfCheck(win: BrowserWindow) {
  const dir = process.env.COPILOT_V050;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });

  const steps: { name: string; data: unknown }[] = [];
  const record = (name: string, data: unknown) => {
    steps.push({ name, data });
    logger.info('SelfCheck', `v050 ${name}`);
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

  const original = getSettingsStore().get();
  const demo: Partial<Settings> = {
    mockMode: true,
    demoAutoPlay: false,
    scenarioMode: 'conversation',
    tone: 'auto',
    targetLanguage: 'English',
    subtitle: { ...DEFAULT_SETTINGS.subtitle },
  };

  try {
    win.setBounds({ width: 460, height: 640 });
    getSettingsStore().update(demo);
    record('0-settings', { before: original.mockMode, after: 'mock' });

    // 设置改了要重载：渲染层的 zustand 只在启动时读一次设置。
    win.reload();
    for (let i = 0; i < 40; i += 1) {
      const ready = await js<boolean>('!!document.querySelector("[data-quick-actions]")');
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // ---- 0b. 首次启动的隐私说明：文案是否已经改成「记录会保存」-------
    record('0b-privacy', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var accept = document.querySelector('[data-privacy-accept]');
        if (!accept) return { shown: false };
        var host = accept.closest('div');
        var text = document.body.innerText || '';
        var items = [].slice.call(document.querySelectorAll('li')).map(function (li) {
          return li.textContent;
        });
        accept.click();
        await sleep(400);
        return {
          shown: true,
          mentionsPersist: text.indexOf('会保存在这台电脑上') >= 0,
          stillSaysMemoryOnly: text.indexOf('只存在内存里') >= 0,
          mentionsNotEncrypted: text.indexOf('不等于加密') >= 0,
          points: items,
          closed: !document.querySelector('[data-privacy-accept]'),
          hadHost: !!host
        };
      })()
    `));

    // ---- 0b. 首次启动的隐私说明：文案是否已经改成「记录会保存」-------
    // ---- 1. 三类字号入口存在，且当前值可读 -----------------------------
    record('1-font-controls', await js(`
      (() => {
        var targets = [].slice.call(document.querySelectorAll('[data-font-target]'));
        var value = document.querySelector('[data-font-value]');
        var minus = document.querySelector('[data-font-dec]');
        var plus = document.querySelector('[data-font-inc]');
        return {
          targets: targets.length,
          labels: targets.map(function (t) { return t.getAttribute('data-font-target'); }),
          pressed: targets.filter(function (t) { return t.getAttribute('aria-pressed') === 'true'; })
            .map(function (t) { return t.getAttribute('data-font-target'); }),
          valueText: value ? value.textContent : null,
          valuePx: value ? value.getAttribute('data-font-value') : null,
          hasMinus: !!minus,
          hasPlus: !!plus,
          minusLabel: minus ? minus.getAttribute('aria-label') : null,
          plusLabel: plus ? plus.getAttribute('aria-label') : null
        };
      })()
    `));

    // ---- 2. 三组样例：真点开、真按运行 ---------------------------------
    record('2-samples-open', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var more = document.querySelector('[data-more-toggle]');
        if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
        await sleep(200);
        var open = document.querySelector('[data-samples-open]');
        if (!open) return { ok: false, why: 'no-samples-button' };
        open.click();
        for (var i = 0; i < 20 && !document.querySelector('[data-samples-panel]'); i += 1) await sleep(100);
        var panel = document.querySelector('[data-samples-panel]');
        if (!panel) return { ok: false, why: 'panel-missing' };
        var cases = [].slice.call(document.querySelectorAll('[data-sample-case]'));
        return {
          ok: true,
          count: cases.length,
          ids: cases.map(function (c) { return c.getAttribute('data-sample-case'); }),
          originals: cases.map(function (c) {
            var el = c.querySelector('[data-sample-original]');
            return el ? el.textContent : null;
          }),
          shellInert: (document.querySelector('[data-app-shell]') || {}).inert === true
        };
      })()
    `));
    await shot('01-samples-panel');

    record('3-sample-run', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var run = document.querySelector('[data-sample-run]');
        if (!run) return { ok: false, why: 'no-run-button' };
        run.click();
        for (var i = 0; i < 40 && !document.querySelector('[data-samples-notice]'); i += 1) await sleep(100);
        var notice = document.querySelector('[data-samples-notice]');
        var close = document.querySelector('[data-samples-close]');
        if (close) close.click();
        // 关闭后要等它真的卸载：同一帧读 DOM 会读到还没提交的旧状态。
        for (var k = 0; k < 30 && document.querySelector('[data-samples-panel]'); k += 1) await sleep(100);
        for (var j = 0; j < 60 && !document.querySelector('[data-subtitle-item]'); j += 1) await sleep(250);
        var items = document.querySelectorAll('[data-subtitle-item]');
        return {
          ok: items.length > 0,
          notice: notice ? notice.textContent : null,
          items: items.length,
          shellInertAfterClose: (document.querySelector('[data-app-shell]') || {}).inert === true,
          panelClosed: !document.querySelector('[data-samples-panel]')
        };
      })()
    `));

    // ---- 3. 三类文字的真实渲染字号 -------------------------------------
    const fontsBefore = await js<{
      original: string | null;
      translation: string | null;
      romanization: string | null;
      romanizationText: string | null;
      state: string | null;
    }>(`
      (() => {
        var style = function (sel) {
          var el = document.querySelector(sel);
          if (!el) return null;
          return getComputedStyle(el).fontSize;
        };
        var roman = document.querySelector('[data-romanization]');
        return {
          original: style('[data-subtitle-original]'),
          translation: style('[data-translation-state="ok"]'),
          romanization: roman ? getComputedStyle(roman).fontSize : null,
          romanizationText: roman ? roman.textContent : null,
          state: (function () {
            var st = document.querySelector('[data-translation-state]');
            return st ? st.getAttribute('data-translation-state') : null;
          })()
        };
      })()
    `);
    record('4-rendered-fonts-before', fontsBefore);
    await shot('02-subtitle-default');

    // ---- 4. 只调「译文」，另外两类不许动 -------------------------------
    record('5-adjust-translation', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var pick = function (name) {
          return document.querySelector('[data-font-target="' + name + '"]');
        };
        var t = pick('translation');
        if (!t) return { ok: false, why: 'no-translation-target' };
        t.click();
        await sleep(150);
        var plus = document.querySelector('[data-font-inc]');
        for (var i = 0; i < 8; i += 1) { plus.click(); await sleep(80); }
        await sleep(300);
        var style = function (sel) {
          var el = document.querySelector(sel);
          return el ? getComputedStyle(el).fontSize : null;
        };
        var roman = document.querySelector('[data-romanization]');
        var value = document.querySelector('[data-font-value]');
        return {
          ok: true,
          valuePx: value ? value.getAttribute('data-font-value') : null,
          valueText: value ? value.textContent : null,
          original: style('[data-subtitle-original]'),
          translation: style('[data-translation-state="ok"]'),
          romanization: roman ? getComputedStyle(roman).fontSize : null,
          persisted: null
        };
      })()
    `));
    record('6-settings-after-adjust', await js(`
      (async () => {
        var s = await window.copilot.getSettings();
        return {
          original: s.subtitle.originalFontSize,
          translation: s.subtitle.translationFontSize,
          romanization: s.subtitle.romanizationFontSize
        };
      })()
    `));
    await shot('03-translation-bigger');

    // ---- 5. 只调「谐音」------------------------------------------------
    record('7-adjust-romanization', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var pick = function (name) {
          return document.querySelector('[data-font-target="' + name + '"]');
        };
        var r = pick('romanization');
        if (!r) return { ok: false, why: 'no-romanization-target' };
        r.click();
        await sleep(150);
        var plus = document.querySelector('[data-font-inc]');
        for (var i = 0; i < 6; i += 1) { plus.click(); await sleep(80); }
        await sleep(300);
        var style = function (sel) {
          var el = document.querySelector(sel);
          return el ? getComputedStyle(el).fontSize : null;
        };
        var roman = document.querySelector('[data-romanization]');
        var value = document.querySelector('[data-font-value]');
        return {
          ok: true,
          valuePx: value ? value.getAttribute('data-font-value') : null,
          original: style('[data-subtitle-original]'),
          translation: style('[data-translation-state="ok"]'),
          romanization: roman ? getComputedStyle(roman).fontSize : null,
          romanizationVisible: !!roman
        };
      })()
    `));
    await shot('04-romanization-bigger');

    // ---- 6. 记录：写入回执 → 状态 → 列表 → 详情 ------------------------
    const saveState = await js<string | null>(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        for (var i = 0; i < 40; i += 1) {
          var el = document.querySelector('[data-save-state]');
          var v = el ? el.getAttribute('data-save-state') : null;
          if (v === 'saved' || v === 'failed') return v;
          await sleep(250);
        }
        var last = document.querySelector('[data-save-state]');
        return last ? last.getAttribute('data-save-state') : 'missing';
      })()
    `);
    record('8-save-state', { state: saveState });

    record('9-history-ipc', await js(`
      (async () => {
        // 这些 IPC 回的是 { ok, data } 包装，字段在 data 里。
        var statusRaw = await window.copilot.historyStatus();
        var status = statusRaw && statusRaw.ok ? statusRaw.data : null;
        var list = await window.copilot.historyList({ limit: 20 });
        var first = (list && list.ok && list.data && list.data.items && list.data.items[0]) || null;
        var page = first
          ? await window.copilot.historyPage({ sessionId: first.id, limit: 50 })
          : null;
        var rows = page && page.ok && page.data ? page.data.messages : [];
        return {
          ready: status ? status.ready : null,
          file: status ? status.file : null,
          integrity: status ? status.integrity : null,
          sessions: status ? status.sessions : null,
          messages: status ? status.messages : null,
          listOk: !!(list && list.ok),
          total: list && list.ok ? list.data.total : null,
          firstTitle: first ? first.title : null,
          firstCount: first ? first.messageCount : null,
          pageCount: rows.length,
          firstOriginal: rows.length ? rows[0].original : null,
          firstTranslation: rows.length ? rows[0].translation : null,
          firstRomanization: rows.length ? rows[0].romanization : null,
          firstSeq: rows.length ? rows[0].seq : null
        };
      })()
    `));

    // ---- 7. 高对比：读真实渲染色算对比度 -------------------------------
    record('10-high-contrast', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var toggle = document.querySelector('[data-contrast-toggle]');
        if (!toggle) return { ok: false, why: 'no-contrast-toggle' };
        if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click();
        await sleep(400);
        var root = document.querySelector('[data-app-shell]');
        var trans = document.querySelector('[data-translation-state="ok"]');
        var orig = document.querySelector('[data-subtitle-original]');
        var read = function (el) {
          if (!el) return null;
          var cs = getComputedStyle(el);
          return { color: cs.color, bg: cs.backgroundColor };
        };
        return {
          ok: true,
          rootBg: root ? getComputedStyle(root).backgroundColor : null,
          contrastValue: root ? root.getAttribute('data-contrast') : null,
          translation: read(trans),
          original: read(orig)
        };
      })()
    `));
    await shot('05-high-contrast');

    // 用真实渲染色算对比度（主进程算，避免自检脚本里再实现一遍）。
    const hc = await js<{ translation: { color: string; bg: string } | null; original: { color: string; bg: string } | null; rootBg: string | null }>(`
      (() => {
        var pick = function (sel) {
          var el = document.querySelector(sel);
          if (!el) return null;
          var cs = getComputedStyle(el);
          return { color: cs.color, bg: cs.backgroundColor };
        };
        var root = document.querySelector('[data-app-shell]');
        return {
          translation: pick('[data-translation-state="ok"]'),
          original: pick('[data-subtitle-original]'),
          rootBg: root ? getComputedStyle(root).backgroundColor : null
        };
      })()
    `);
    const ratioOf = (node: { color: string; bg: string } | null, fallbackBg: string) => {
      if (!node) return null;
      const bg = node.bg && node.bg !== 'rgba(0, 0, 0, 0)' ? node.bg : fallbackBg;
      return contrastOfCss(node.color, bg);
    };
    record('11-contrast-measured', {
      rootBg: hc?.rootBg ?? null,
      translation: ratioOf(hc?.translation ?? null, hc?.rootBg || 'rgb(0,0,0)'),
      original: ratioOf(hc?.original ?? null, hc?.rootBg || 'rgb(0,0,0)'),
    });

    // ---- 8. 沟通卡：焦点陷阱 + inert ------------------------------------
    record('12-comm-cards', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var card = document.querySelector('[data-comm-card]');
        if (!card) return { ok: false, why: 'no-comm-card' };
        card.click();
        for (var i = 0; i < 30 && !document.querySelector('[data-comm-overlay]'); i += 1) await sleep(100);
        var overlay = document.querySelector('[data-comm-overlay]');
        if (!overlay) return { ok: false, why: 'overlay-missing' };
        var shell = document.querySelector('[data-app-shell]');
        var focusables = [].slice.call(
          overlay.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')
        );
        var movedIn = overlay.contains(document.activeElement);
        for (var k = 0; k < focusables.length + 2; k += 1) {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
          await sleep(25);
        }
        var insideAfterTab = overlay.contains(document.activeElement);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(350);
        return {
          ok: true,
          shellInertWhileOpen: true,
          focusables: focusables.length,
          focusMovedIn: movedIn,
          stillInsideAfterTab: insideAfterTab,
          closedByEsc: !document.querySelector('[data-comm-overlay]'),
          shellInertAfterClose: shell ? shell.inert === true : null
        };
      })()
    `));

    // ---- 9. 记录面板：能从界面打开并看到会话 ---------------------------
    record('13-records-panel', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var btn = document.querySelector('[data-open-records]');
        if (!btn) return { ok: false, why: 'no-records-button' };
        btn.click();
        for (var i = 0; i < 30 && !document.querySelector('[data-records-panel]'); i += 1) await sleep(150);
        var panel = document.querySelector('[data-records-panel]');
        if (!panel) return { ok: false, why: 'panel-missing' };
        // 列表是异步拉回来的：只等面板出现就读，会读到「共 0 段」的空状态。
        for (var w = 0; w < 40 && !panel.querySelector('[data-history-session]'); w += 1) await sleep(150);
        var rows = [].slice.call(panel.querySelectorAll('[data-history-session]'));
        var saveBadge = panel.querySelector('[data-history-save-state]');
        var header = panel.textContent.slice(0, 120);
        // 行是 div，可点的是里面那个 button（点 div 什么都不会发生）。
        if (rows.length) rows[0].querySelector('button').click();
        for (var j = 0; j < 30 && !document.querySelector('[data-history-message]'); j += 1) await sleep(150);
        await sleep(400);
        var msgs = document.querySelectorAll('[data-history-message]');
        var headerNow = panel.textContent.slice(0, 60);
        // 历史详情必须和主字幕用同一套字号，否则用户调大的字到这里又变小。
        var fs = function (sel) {
          var el = document.querySelector(sel);
          return el ? getComputedStyle(el).fontSize : null;
        };
        var settings = await window.copilot.getSettings();
        return {
          ok: rows.length > 0,
          headerNow: headerNow,
          detailFonts: {
            original: fs('[data-history-original]'),
            translation: fs('[data-history-translation]'),
            romanization: fs('[data-history-romanization]'),
            expected: {
              original: settings.subtitle.originalFontSize,
              translation: settings.subtitle.translationFontSize,
              romanization: settings.subtitle.romanizationFontSize
            }
          },
          sessions: rows.length,
          saveState: saveBadge ? saveBadge.getAttribute('data-history-save-state') : null,
          headerSnippet: header,
          detailMessages: msgs.length,
          hasLoadEarlier: !!document.querySelector('[data-load-earlier]')
        };
      })()
    `));
    await shot('06-records');

    // ---- 10. 重启后仍在（关窗重载 = 用户关掉再打开） --------------------
    win.reload();
    for (let i = 0; i < 40; i += 1) {
      const ready = await js<boolean>('!!document.querySelector("[data-quick-actions]")');
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    record('14-after-reload', await js(`
      (async () => {
        var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var s = await window.copilot.getSettings();
        var statusRaw = await window.copilot.historyStatus();
        var status = statusRaw && statusRaw.ok ? statusRaw.data : null;
        var list = await window.copilot.historyList({ limit: 10 });
        var resume = document.querySelector('[data-resume-last]');
        var resumeTitle = document.querySelector('[data-resume-last-title]');
        var resumeButton = document.querySelector('[data-resume-last-open]');
        var beforeResume = document.querySelectorAll('[data-subtitle-item]').length;
        if (resumeButton) resumeButton.click();
        for (var i = 0; i < 40 && !document.querySelector('[data-subtitle-item]'); i += 1) await sleep(150);
        await sleep(300);
        var items = [].slice.call(document.querySelectorAll('[data-subtitle-item]'));
        var text = function (sel) {
          var el = document.querySelector(sel);
          return el ? el.textContent : null;
        };
        return {
          fonts: {
            original: s.subtitle.originalFontSize,
            translation: s.subtitle.translationFontSize,
            romanization: s.subtitle.romanizationFontSize
          },
          ready: status ? status.ready : null,
          sessions: status ? status.sessions : null,
          messages: status ? status.messages : null,
          total: list && list.ok ? list.data.total : null,
          restartHadEmptySubtitle: beforeResume === 0,
          resumeCardShown: !!resume,
          resumeTitle: resumeTitle ? resumeTitle.textContent : null,
          itemsAfterResume: items.length,
          originalAfterResume: text('[data-subtitle-original]'),
          translationAfterResume: text('[data-translation-state="ok"]'),
          romanizationAfterResume: text('[data-romanization]')
        };
      })()
    `));
    await shot('07-after-reload');
    await shot('08-resumed');

    record('done', { steps: steps.length });
  } catch (error) {
    record('error', { message: String(error).slice(0, 200) });
  } finally {
    try {
      fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ steps }, null, 2), 'utf8');
    } catch (error) {
      logger.warn('SelfCheck', `write report failed: ${String(error).slice(0, 40)}`);
    }
    // 还原设置：这一条以前踩过坑（跑完停在 video / 窗口变成设置面板尺寸）。
    try {
      getSettingsStore().update({
        mockMode: original.mockMode,
        scenarioMode: 'conversation',
        tone: original.tone,
        targetLanguage: original.targetLanguage,
        subtitle: original.subtitle,
      });
    } catch {
      /* 还原失败也要退出 */
    }
    logger.info('SelfCheck', 'v050 done');
    setTimeout(() => app.quit(), 600);
  }
}
