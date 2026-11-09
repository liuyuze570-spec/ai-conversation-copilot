import { useEffect, useRef, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { SourceBar } from './components/SourceBar';
import { SubtitleList } from './components/SubtitleList';
import { LiveTranslateBar } from './components/LiveTranslateBar';
import { FactPanel } from './components/FactPanel';
import { ReplyPanel } from './components/ReplyPanel';
import { QuickActions } from './components/QuickActions';
import { ComposeStatus } from './components/ComposeStatus';
import { CommCards } from './components/CommCards';
import { SettingsPanel } from './components/SettingsPanel';
import { RecordsPanel } from './components/RecordsPanel';
import { PrivacyNotice } from './components/PrivacyNotice';
import { useCopilot } from './hooks/useCopilot';
import { useSessions } from './hooks/useSessions';
import { useSettingsStore } from './stores/settings';
import { useUiStore } from './stores/ui';
import { useConversationStore } from './stores/conversation';
import { useHistoryStore } from './stores/history';
import { flushHistory, startHistorySync, stopHistorySync } from './lib/history-sync';

export default function App() {
  const {
    settings,
    scenarioMode,
    toggleListening,
    requestReplies,
    pauseAndReply,
    resumePlayback,
    setScenario,
    speak,
    clearConversation,
    closeReplies,
    listenToSystemAudio,
    retryTranslate,
    reconnectAudio,
  } = useCopilot();

  // 会话切换（新建 / 打开 / 删除 / 全部清空）统一走 resetLiveSession（由
  // useCopilot 注册）：取消在途的翻译、回复、朗读和事实提取，并清掉事实卡。
  // 只清字幕会让上一场的关键信息和迟到的译文串到新的会话里。
  const { total, newSession, loadEarlier, recent, resumeRecent } = useSessions();

  const loaded = useSettingsStore((state) => state.loaded);
  const status = useUiStore((state) => state.status);
  const statusMessage = useUiStore((state) => state.statusMessage);
  const suggestions = useUiStore((state) => state.suggestions);
  const busy = useUiStore((state) => state.busy);
  const playback = useUiStore((state) => state.playback);
  const showSettings = useUiStore((state) => state.showSettings);
  const showRecords = useUiStore((state) => state.showRecords);
  const showPrivacy = useUiStore((state) => state.showPrivacy);
  const toggleSettings = useUiStore((state) => state.toggleSettings);
  const toggleRecords = useUiStore((state) => state.toggleRecords);
  const updateSettings = useSettingsStore((state) => state.update);
  const setHistoryLimit = useConversationStore((state) => state.setHistoryLimit);

  /**
   * 「重点信息」里点某条事实 → 需要把对应的那句字幕滚进视野并高亮一下。
   * 用一次性 id，SubtitleList 处理完立刻清掉，避免下次进来又闪一下。
   */
  const [highlightId, setHighlightId] = useState<string | null>(null);

  /**
   * 0.6.3：不再「启动即自动采集」。
   *
   * 旧逻辑在 loaded && privacyAccepted && idle 时立刻 startListening，
   * 用户一打开软件就开始监听，却不知道在听哪一路音源；对靠字幕获取信息
   * 的目标使用者来说，先知道「它在听什么」比自动开录更重要。现在启动后
   * 停在「未开始采集」，由用户在音源条上明确点「开始采集」，或先到
   * 设置里选好音源用途再开始。保留 privacyAccepted 门（隐私说明必须先接受）。
   */
  const autoStartRef = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    if (autoStartRef.current) return;
    autoStartRef.current = true;
    // 仅在「真实模式且首次启动」时不再自动开始；演示样例与打包自检走它们自己的入口。
    // 明确停在未开始状态，等待用户主动选择音源与开始采集。
  }, [loaded]);

  /*
   * 关闭窗口时补一次「冲洗」。
   *
   * 这不是主要保存手段 —— 每条消息定稿时就已经写进库并拿到回执了。这里只是
   * 把 debounce 还没到的那几百毫秒补上，所以不指望它在 beforeunload 里一定跑完，
   * 也不把「保存成功」押在它身上。
   */
  useEffect(() => {
    const handler = () => {
      void flushHistory();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // 记录同步：字幕 / AI 回复 / 事实一有变化就进待写队列（有防抖）。
  useEffect(() => {
    startHistorySync();
    void useHistoryStore.getState().refreshStatus();
    return () => stopHistorySync();
  }, []);

  // Compact mode shrinks the overlay so it stays out of the way.
  useEffect(() => {
    window.copilot.resize(settings.uiMode === 'compact' ? 400 : 460, settings.uiMode === 'compact' ? 330 : 640);
  }, [settings.uiMode]);

  // How far back the user can scroll in the transcript.
  useEffect(() => {
    setHistoryLimit(settings.subtitle.maxItems);
  }, [settings.subtitle.maxItems, setHistoryLimit]);

  return (
    <div
      data-app-shell
      data-contrast={settings.subtitle.highContrast ? 'high' : 'normal'}
      className="relative flex h-full w-full flex-col overflow-hidden bg-ink-950"
    >
      <TitleBar
        status={status}
        statusMessage={statusMessage}
        alwaysOnTop={settings.window.alwaysOnTop}
        locked={settings.window.locked}
        onToggleListening={() => void toggleListening()}
        onToggleSettings={() => toggleSettings()}
        onToggleAlwaysOnTop={() => {
          const next = !settings.window.alwaysOnTop;
          void updateSettings({ window: { ...settings.window, alwaysOnTop: next } });
          window.copilot.setAlwaysOnTop(next);
        }}
        onToggleLock={() => {
          const next = !settings.window.locked;
          void updateSettings({ window: { ...settings.window, locked: next } });
          window.copilot.setLocked(next);
        }}
      />

      {/* 音源 + 状态 + 开始/暂停 + 重新连接 + 字号/高对比：首页第一眼要确认
          「它在听吗、在听什么」，所以这条比标题栏更靠前、更显眼。 */}
      <SourceBar
        onToggleListening={() => void toggleListening()}
        onReconnect={() => void reconnectAudio()}
      />

      {/* Watching a video / practising exam listening → pin the live subtitle. */}
      {scenarioMode !== 'conversation' && <LiveTranslateBar scenario={scenarioMode} />}

      {/* 关键事实卡：默认折叠成一行，展开后自身滚动，不挡住字幕和主按钮。 */}
      <FactPanel
        onLocate={(itemId) => setHighlightId(itemId)}
        onSpeak={(text, id) => void speak(text, id)}
      />

      <SubtitleList
        recordsCount={total}
        onNewSession={() => void newSession()}
        onOpenRecords={() => toggleRecords(true)}
        recent={recent}
        onResume={() => void resumeRecent()}
        onListen={() => void listenToSystemAudio()}
        onSpeak={(text, id) => void speak(text, id)}
        onRetryTranslate={retryTranslate}
        onLoadEarlier={loadEarlier}
        highlightId={highlightId}
        onHighlightHandled={() => setHighlightId(null)}
      />

      <ReplyPanel
        suggestions={suggestions}
        onSpeak={(text, id, speed) => void speak(text, id, speed)}
        onRefine={(mode, current) => void requestReplies(mode, { current })}
        onClose={closeReplies}
      />

      {/* 0.6.3：「中文 → 外语」的常驻状态条，收起更多/小窗口/大字号都可见。
          只显示状态与重试，回复正文在 ReplyPanel。 */}
      <ComposeStatus
        onRetry={(chinese) => void requestReplies('from-chinese', { chinese })}
        onClear={() => useUiStore.getState().resetCompose()}
      />

      {settings.uiMode === 'compact' ? (
        <div className="border-t border-line-soft px-3 py-2.5">
          {settings.mockMode && (
            <button
              data-demo-banner
              onClick={() => void listenToSystemAudio()}
              className="no-drag mb-2 w-full rounded-xl border border-warn/20 bg-warn/[0.07] px-2 py-1.5
                text-[10.5px] text-warn/85 transition-colors duration-150 hover:bg-warn/15"
            >
              演示模式：听不到电脑的声音 · 点此切换真实监听
            </button>
          )}
          {scenarioMode === 'conversation' && (
            /*
             * 紧凑模式也必须留沟通卡入口。
             *
             * 沟通卡是断网、没额度时唯一的兜底 —— 把窗口收小恰恰是「不想让人
             * 看见屏幕、只想举一句话给对方」的场景，这时候把入口藏掉等于把
             * 最需要它的功能关掉了。
             */
            <div className="mb-2">
              <CommCards compact onSpeak={(text) => void speak(text)} />
            </div>
          )}
          {scenarioMode === 'conversation' ? (
            <button
              data-primary-action="reply"
              disabled={busy}
              onClick={() => void requestReplies('reply')}
              className="no-drag w-full rounded-xl bg-accent py-2.5 text-[13px] font-semibold text-white
                transition-colors duration-150 hover:bg-accent-dim disabled:opacity-35"
            >
              帮我回复　<span className="text-[11px] font-normal opacity-60">Alt + Space</span>
            </button>
          ) : (
            <button
              data-primary-action={playback === 'paused' ? 'resume' : 'pause'}
              onClick={() => (playback === 'paused' ? resumePlayback() : void pauseAndReply())}
              className={`no-drag w-full rounded-xl py-2.5 text-[13px] font-semibold transition-colors duration-150 ${
                playback === 'paused'
                  ? 'border border-line bg-ink-800 text-white/85 hover:bg-ink-700'
                  : 'bg-accent text-white hover:bg-accent-dim'
              }`}
            >
              {playback === 'paused'
                ? '▶ 继续播放'
                : scenarioMode === 'exam'
                  ? '暂停 · 给参考答案'
                  : '暂停 · 生成回复'}
            </button>
          )}
        </div>
      ) : (
        <QuickActions
          disabled={busy}
          hasSuggestions={suggestions.length > 0}
          scenario={scenarioMode}
          playback={playback}
          onAction={(mode) => void requestReplies(mode)}
          onSubmit={(chinese) => requestReplies('from-chinese', { chinese })}
          onRetry={(chinese) => requestReplies('from-chinese', { chinese })}
          onCloseReplies={closeReplies}
          onDemoLine={() => void window.copilot.audioDemoLine()}
          onSetScenario={(mode) => void setScenario(mode)}
          onPauseReply={() => void pauseAndReply()}
          onResume={resumePlayback}
          onListenSystem={() => void listenToSystemAudio()}
          onSpeak={(text) => void speak(text)}
        />
      )}

      {showRecords && <RecordsPanel onClose={() => toggleRecords(false)} />}
      {showSettings && <SettingsPanel onClose={() => toggleSettings(false)} />}
      {showPrivacy && <PrivacyNotice />}
    </div>
  );
}
