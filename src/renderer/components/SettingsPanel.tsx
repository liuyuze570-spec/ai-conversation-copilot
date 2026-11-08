import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../stores/settings';
import { useAiStatusStore } from '../stores/ai-status';
import { GeneralSettings } from './settings/GeneralSettings';
import { ApiSettings } from './settings/ApiSettings';
import { PerformanceSettings } from './settings/PerformanceSettings';

type Tab = 'general' | 'api' | 'perf';

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'general', label: '常用功能', hint: '语言 · 场景 · 字幕 · 音频 · 窗口' },
  { id: 'api', label: 'API 功能', hint: '连接国内模型 · 只允许国内' },
  { id: 'perf', label: '性能', hint: '各段耗时 · 瓶颈在哪' },
];

/** 面板里所有「能按到」的东西。焦点陷阱用，顺序就是 Tab 顺序。 */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 设置面板外壳。
 *
 * 拆成两个标签页是有原因的：原来所有选项堆在一条长长的滚动条里，
 * 想改「音量」得先滑过一堆 Base URL，新手根本找不到哪里填 Key。
 * 现在「常用功能」（跟模型无关的日常开关）和「API 功能」（连模型）
 * 各自独立，找东西不用翻。
 *
 * 无障碍（0.4.0）：面板是盖在字幕上的，所以打开时把焦点移进来（第一站是
 * 「返回」），关闭时还给打开它的那个按钮，Tab 也不许跑到被盖住的控件上。
 * 只加 role="dialog" 而不做这三件事，键盘用户会「按了打开、焦点还在背后」。
 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('general');
  const uiMode = useSettingsStore((state) => state.settings.uiMode);
  const keyInfo = useAiStatusStore((state) => state.keyInfo);
  const refreshKeys = useAiStatusStore((state) => state.refreshKeys);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void refreshKeys();
  }, [refreshKeys]);

  // 设置内容比较多，打开时临时把窗口放大，关上再还原。
  useEffect(() => {
    window.copilot.resize(520, 720);
    return () => {
      window.copilot.resize(
        uiMode === 'compact' ? 400 : 460,
        uiMode === 'compact' ? 330 : 640,
      );
    };
  }, [uiMode]);

  // 焦点：进来 → 落在「返回」；出去 → 还给原来的入口按钮。
  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    const first = panelRef.current?.querySelector<HTMLElement>('[data-settings-back]');
    (first ?? panelRef.current)?.focus();
    return () => {
      const target = returnTo.current;
      // 通道里那个按钮可能已经不在了（窗口重绘），所以先确认还挂在文档里。
      if (target && document.contains(target)) target.focus();
    };
  }, []);

  /**
   * Tab / Shift+Tab 不出面板。
   *
   * 不做这件事的话，按到最后一个控件之后焦点会跑到背后的「开始采集」上 ——
   * 屏幕上明明盖着一层设置，键盘却在操作看不见的东西。
   */
  const trapTab = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (node) => node.offsetParent !== null,
    );
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const current = document.activeElement as HTMLElement | null;
    if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && (current === first || !panel.contains(current))) {
      event.preventDefault();
      last.focus();
    }
  };

  const apiIssue = !keyInfo?.llm || !keyInfo?.sttReady;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      tabIndex={-1}
      onKeyDown={trapTab}
      className="subtle-scroll absolute inset-0 z-20 flex flex-col overflow-y-auto bg-ink-900/[0.97] px-3 pb-3 backdrop-blur-xl"
    >
      {/* 标题吸顶：设置项很长，滚到「窗口」那一段时还得能一眼看到怎么退出。 */}
      <div className="sticky top-0 z-10 -mx-3 mb-2 border-b border-line-soft bg-ink-900/[0.97] px-3 pb-2 pt-3 backdrop-blur-xl">
        <div className="mb-2.5 flex items-center justify-between">
          <span
            id="settings-title"
            className="text-[13px] font-semibold tracking-[0.01em] text-white/90"
          >
            设置
          </span>
          <button
            type="button"
            data-settings-back
            onClick={onClose}
            aria-label="关闭设置，回到字幕"
            className="no-drag rounded-lg px-2 py-1 text-[11px] text-white/50 transition-colors duration-150 hover:bg-ink-700 hover:text-white"
          >
            返回
          </button>
        </div>

        <div data-settings-tabs className="flex gap-1.5">
          {TABS.map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                data-settings-tab={item.id}
                data-active={active ? 'true' : 'false'}
                onClick={() => setTab(item.id)}
                className={`no-drag relative flex-1 rounded-xl border px-2 py-1.5 text-left transition-colors duration-150 ${
                  active
                    ? 'border-accent/35 bg-accent/12'
                    : 'border-line-soft bg-ink-850 hover:bg-ink-800'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={`text-[12px] font-semibold ${active ? 'text-accent-soft' : 'text-white/70'}`}
                  >
                    {item.label}
                  </span>
                  {item.id === 'api' && apiIssue && (
                    <span className="h-1.5 w-1.5 rounded-full bg-warn" />
                  )}
                </span>
                <span className="mt-0.5 block text-[9.5px] leading-tight text-white/30">
                  {item.hint}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {tab === 'general' && <GeneralSettings />}
      {tab === 'api' && <ApiSettings />}
      {tab === 'perf' && <PerformanceSettings />}

      <p className="mt-3 text-center text-[10px] leading-relaxed text-white/20">
        快捷键：Alt+Space 帮我回复 · Alt+R 我没听清 · Alt+Q 继续话题 · Alt+P 暂停 ·
        Alt+V 看视频模式
      </p>
    </div>
  );
}
