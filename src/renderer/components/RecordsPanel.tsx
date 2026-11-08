import { useEffect, useRef, useState } from 'react';
import { useSessions } from '../hooks/useSessions';
import { useHistoryStore } from '../stores/history';
import { TARGET_LANGUAGES } from '../../shared/types';
import { HISTORY_PAGE_SIZE } from '../../shared/history';
import { saveStateLabel } from '../lib/history-sync';
import { readingPrefs } from '../../shared/reading';
import { useSettingsStore } from '../stores/settings';

/**
 * 对话记录面板。
 *
 * 三件事必须在这里说清楚，否则用户没法信任它：
 *  1. **存在哪、存了多少**（文件路径 + 条数，可一键打开文件夹）；
 *  2. **现在到底存没存**（已保存 / 尚未保存 + 重试）；
 *  3. **删除是不可逆的**（两次确认，且「清空当前显示」不在这个面板里）。
 *
 * 一万条消息的用户打开这个面板时，列表只取 30 段、详情只取 50 条 ——
 * 不是「只有这么多」，而是「先给你看这么多」，往下/往上都能继续加载。
 */

function timeLabel(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function langLabel(language: string): string {
  return TARGET_LANGUAGES.find((item) => item.value === language)?.label.split(' ')[0] ?? language;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function RecordsPanel({ onClose }: { onClose: () => void }) {
  const { total, saveState, saveError, pendingCount, openSession, removeSession, clearAllSessions, retrySave } =
    useSessions();
  const sessions = useHistoryStore((state) => state.sessions);
  const loadedAll = useHistoryStore((state) => state.loadedAll);
  const listLoading = useHistoryStore((state) => state.listLoading);
  const results = useHistoryStore((state) => state.results);
  const query = useHistoryStore((state) => state.query);
  const searching = useHistoryStore((state) => state.searching);
  const status = useHistoryStore((state) => state.status);
  const detailId = useHistoryStore((state) => state.detailId);
  const detail = useHistoryStore((state) => state.detail);
  const detailLoading = useHistoryStore((state) => state.detailLoading);

  const [term, setTerm] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    void useHistoryStore.getState().loadSessions(true);
    void useHistoryStore.getState().refreshStatus();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (term.trim()) void useHistoryStore.getState().search(term);
      else useHistoryStore.getState().clearSearch();
    }, 260);
    return () => clearTimeout(timer);
  }, [term]);

  const list = results ?? sessions;

  const exportAll = async () => {
    setBusy(true);
    const result = await useHistoryStore.getState().exportData({ format: 'text' });
    setBusy(false);
    setNotice(result.message);
  };

  const backup = async () => {
    setBusy(true);
    const result = await useHistoryStore.getState().backup();
    setBusy(false);
    setNotice(result.message);
  };

  return (
    <div
      data-records-panel
      className="subtle-scroll absolute inset-0 z-20 flex flex-col overflow-y-auto bg-ink-900/95 px-3 py-3 backdrop-blur-xl"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-semibold text-white/90">
          对话记录
          <span className="ml-1.5 text-[10.5px] font-normal text-white/40">
            共 {total} 段 · {status.messages} 条消息 · {sizeLabel(status.bytes)}
          </span>
        </span>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="关闭对话记录，返回字幕"
          className="no-drag rounded-md px-2 py-1 text-[11px] text-white/50 hover:bg-ink-700 hover:text-white"
        >
          返回
        </button>
      </div>

      {/* 保存状态：只有主进程回执才算「已保存」。 */}
      <div
        data-history-save-state={saveState}
        className={`mb-2 flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10.5px] ${
          saveState === 'failed'
            ? 'border-danger/40 bg-danger/10 text-danger'
            : 'border-line-soft bg-ink-850 text-white/55'
        }`}
      >
        <span className="shrink-0">{saveStateLabel(saveState, pendingCount)}</span>
        {saveState === 'failed' ? (
          <button
            type="button"
            data-history-retry
            onClick={() => void retrySave().then((ok) => setNotice(ok ? '已重新保存成功' : '还是没能保存，请检查磁盘或权限'))}
            className="no-drag ml-auto shrink-0 rounded bg-danger/20 px-1.5 py-[1px] text-[10px] text-danger"
          >
            重试保存
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void useHistoryStore.getState().openFolder()}
            className="no-drag ml-auto shrink-0 text-[10px] text-white/40 underline decoration-dotted hover:text-white/70"
            title={status.file || '打开用户数据目录'}
          >
            打开记录文件夹
          </button>
        )}
      </div>
      {saveError && (
        <p className="mb-2 text-[10.5px] leading-relaxed text-danger/85">
          {saveError.title} · {saveError.hint}
        </p>
      )}

      <div className="mb-2 flex items-center gap-1.5">
        <input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          aria-label="搜索历史记录（标题、原文、译文、谐音）"
          placeholder="搜索原文 / 译文 / 谐音…"
          className="no-drag min-w-0 flex-1 rounded-lg border border-line-soft bg-ink-850 px-2 py-1.5
            text-[11px] text-white/85 placeholder:text-white/25 focus:border-accent/50 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void exportAll()}
          disabled={busy || !status.ready}
          className="no-drag shrink-0 rounded-lg border border-line px-2 py-1.5 text-[10.5px] text-white/60
            hover:bg-ink-700 hover:text-white disabled:opacity-40"
        >
          导出全部
        </button>
      </div>

      {notice && (
        <p
          data-history-notice
          role="status"
          className="mb-2 rounded-lg border border-line-soft bg-ink-850 px-2 py-1.5 text-[10.5px] leading-relaxed text-white/65"
        >
          {notice}
        </p>
      )}

      {!status.ready && (
        <p className="mb-3 rounded-lg border border-danger/35 bg-danger/10 px-2 py-2 text-[11px] leading-relaxed text-danger">
          记录功能现在不可用（{status.lastError || '打不开记录文件'}）。字幕和翻译仍然正常工作，
          但这一场的记录不会保存。请按提示处理后重启软件。
        </p>
      )}

      {detailId ? (
        <SessionDetail
          onBack={() => useHistoryStore.getState().closeDetail()}
          onNotice={setNotice}
          onContinue={async () => {
            const ok = await openSession(detailId);
            if (ok) onClose();
            else setNotice('这段记录打不开，可能是记录文件正在被占用');
          }}
        />
      ) : (
        <>
          {results && (
            <p className="mb-1.5 text-[10px] text-white/40">
              搜索「{query}」命中 {results.length} 段
              <button
                type="button"
                onClick={() => {
                  setTerm('');
                  useHistoryStore.getState().clearSearch();
                }}
                className="no-drag ml-1.5 underline decoration-dotted hover:text-white/70"
              >
                清除
              </button>
            </p>
          )}

          {searching && <p className="py-2 text-center text-[11px] text-white/35">搜索中…</p>}

          {list.length === 0 && !searching ? (
            <p className="mt-4 text-center text-[11.5px] leading-relaxed text-white/35">
              {results ? '没有找到匹配的记录。' : '还没有记录。'}
              <br />
              {results ? '换个词试试，或者清掉搜索看全部。' : '开始采集后，每一句字幕都会自动保存在这里，'}
              {!results && (
                <>
                  <br />
                  关掉软件也不会丢。
                </>
              )}
            </p>
          ) : (
            <div className="space-y-1.5">
              {list.map((session) => {
                const active = session.id === detailId;
                const deleteConfirm = confirmDelete === session.id;
                return (
                  <div
                    key={session.id}
                    data-history-session={session.id}
                    className={`rounded-xl border px-2.5 py-2 transition ${
                      active
                        ? 'border-accent/45 bg-accent/10'
                        : 'border-line-soft bg-ink-850 hover:border-line-strong'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => void useHistoryStore.getState().openDetail(session.id)}
                      aria-label={`查看记录：${session.title || '无标题'}，${session.messageCount} 条消息`}
                      className="no-drag w-full text-left"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[12px] text-white/85">
                          {session.title || '（无标题）'}
                        </span>
                        {'hits' in session && (session as { hits?: number }).hits ? (
                          <span className="shrink-0 rounded bg-accent/20 px-1 text-[9px] text-accent-soft">
                            命中 {(session as { hits?: number }).hits}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-white/35">
                        <span>{timeLabel(session.updatedAt)}</span>
                        <span>·</span>
                        <span>{langLabel(session.language)}</span>
                        <span>·</span>
                        <span>{session.messageCount} 条</span>
                      </div>
                      {'snippet' in session && (session as { snippet?: string }).snippet ? (
                        <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-white/45">
                          {(session as { snippet?: string }).snippet}
                        </p>
                      ) : null}
                    </button>
                    <div className="mt-1 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void useHistoryStore.getState().openDetail(session.id)}
                        className="no-drag text-[10px] text-white/45 hover:text-white/80"
                      >
                        查看
                      </button>
                      {deleteConfirm ? (
                        <>
                          <button
                            type="button"
                            data-history-delete-confirm
                            onClick={() => {
                              setConfirmDelete(null);
                              void removeSession(session.id).then((result) => {
                                if (!result.ok) setNotice(result.message ?? '删除失败');
                                else setNotice('已删除这一段记录');
                              });
                            }}
                            className="no-drag rounded bg-danger/20 px-1.5 py-[1px] text-[10px] text-danger"
                          >
                            确认删除（不可恢复）
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(null)}
                            className="no-drag text-[10px] text-white/40 hover:text-white/70"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(session.id)}
                          aria-label={`删除记录：${session.title || '无标题'}`}
                          className="no-drag text-[10px] text-white/30 hover:text-danger/85"
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {!results && !loadedAll && (
                <button
                  type="button"
                  data-history-load-more
                  onClick={() => void useHistoryStore.getState().loadMore()}
                  disabled={listLoading}
                  className="no-drag w-full rounded-lg border border-line px-2 py-1.5 text-[11px] text-white/55
                    hover:bg-ink-700 hover:text-white disabled:opacity-40"
                >
                  {listLoading ? '正在加载…' : '加载更多（更早的会话）'}
                </button>
              )}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line-soft pt-2">
            <button
              type="button"
              onClick={() => void backup()}
              disabled={busy || !status.ready}
              className="no-drag rounded-md border border-line px-2 py-1 text-[10.5px] text-white/55
                hover:bg-ink-700 hover:text-white disabled:opacity-40"
            >
              备份数据库
            </button>
            {confirmClear ? (
              <>
                <button
                  type="button"
                  data-history-clear-confirm
                  onClick={() => {
                    setConfirmClear(false);
                    void clearAllSessions().then((result) => {
                      setNotice(result.ok ? '已清空全部历史记录' : (result.message ?? '清空失败'));
                    });
                  }}
                  className="no-drag rounded-md bg-danger/20 px-2 py-1 text-[10.5px] text-danger"
                >
                  确认清空全部（不可恢复）
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  className="no-drag rounded-md px-2 py-1 text-[10.5px] text-white/45 hover:text-white/80"
                >
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                className="no-drag rounded-md px-2 py-1 text-[10.5px] text-white/30 hover:text-danger/85"
              >
                清空全部历史
              </button>
            )}
          </div>

          <p className="mt-2 text-[10px] leading-relaxed text-white/30">
            记录保存在本机（{status.file || '用户数据目录'}）。
            关闭软件、重启、升级都不会删除；只有上面的「删除 / 清空全部」会。
            <br />
            本地保存**不等于加密**：能登录这台电脑的人可以看到这些文件。
            本软件不会把记录上传到任何云端，也没有账号体系。
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-white/30">
            数据库完整性自检：{status.integrity || '未执行'}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * 一段记录的内容（分页）。
 *
 * 只渲染 50 条一页，向上可以继续加载。用 `content-visibility:auto` 让
 * 屏幕外的消息不参与布局/绘制 —— 这是「不等同于虚拟列表但效果等价」的做法：
 * 长会话滚动时不会因为几千个节点卡住，同时保持 DOM 结构简单、可被读屏访问。
 */
function SessionDetail({
  onBack,
  onContinue,
  onNotice,
}: {
  onBack: () => void;
  onContinue: () => Promise<void>;
  onNotice: (text: string) => void;
}) {
  const detail = useHistoryStore((state) => state.detail);
  const detailLoading = useHistoryStore((state) => state.detailLoading);
  const detailId = useHistoryStore((state) => state.detailId);
  /*
   * 历史详情也按用户调的字号显示。
   *
   * 以前的写法是三行硬编码 12/13/11px —— 有人把译文调到 40px 才看得清，
   * 到「记录」里又变回 13px，等于白调。这里读的是同一份设置，
   * 主字幕和记录里看到的字一样大。
   */
  const subtitlePrefs = useSettingsStore((state) => state.settings.subtitle);
  const prefs = readingPrefs(subtitlePrefs);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previousHeight = useRef(0);

  // 加载更早的一页之后，把滚动位置「钉」在原来的内容上，不要跳到某处。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (previousHeight.current > 0) {
      const delta = el.scrollHeight - previousHeight.current;
      if (delta > 0) el.scrollTop += delta;
    }
    previousHeight.current = el.scrollHeight;
  }, [detail?.messages.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回记录列表"
          className="no-drag rounded-md px-1.5 py-1 text-[10.5px] text-white/55 hover:bg-ink-700 hover:text-white"
        >
          ← 列表
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px] text-white/70">
          {detail?.messages.length ?? 0} 条已加载
          {detail?.hasMore ? '（还有更早的）' : ''}
        </span>
        <button
          type="button"
          onClick={() => void onContinue()}
          className="no-drag shrink-0 rounded-md bg-accent/85 px-2 py-1 text-[10.5px] font-semibold text-white hover:bg-accent"
        >
          在这段记录上继续
        </button>
      </div>

      {detail?.hasMore && (
        <button
          type="button"
          data-history-load-earlier
          onClick={() => void useHistoryStore.getState().loadEarlier()}
          disabled={detailLoading}
          className="no-drag mb-1.5 w-full rounded-lg border border-line px-2 py-1 text-[10.5px] text-white/55
            hover:bg-ink-700 hover:text-white disabled:opacity-40"
        >
          {detailLoading ? '正在加载…' : '加载更早的内容'}
        </button>
      )}

      <div ref={scrollRef} className="subtle-scroll min-h-0 flex-1 overflow-y-auto pr-0.5">
        {detail?.messages.length ? (
          detail.messages.map((message) => (
            <div
              key={message.id}
              data-history-message={message.id}
              style={{ contentVisibility: 'auto', containIntrinsicSize: '84px' }}
              className="mb-2 rounded-lg border border-line-soft bg-ink-850/70 px-2 py-1.5"
            >
              <div className="mb-0.5 flex items-center gap-1.5 text-[9.5px] text-white/35">
                <span>{message.speaker === 'foreign' ? '对方' : '你'}</span>
                <span>·</span>
                <span>{timeLabel(message.ts)}</span>
                {message.state === 'failed' && <span className="text-danger">翻译失败</span>}
                {message.state === 'cancelled' && <span className="text-warn">已停止翻译</span>}
                {message.state === 'partial' && <span className="text-warn">未完成</span>}
                {message.edited && <span className="text-accent-soft">已修改</span>}
              </div>
              {message.original && (
                <p
                  data-history-original
                  style={{ fontSize: `${prefs.originalFontSize}px` }}
                  className="leading-snug text-white/90"
                >
                  {message.original}
                </p>
              )}
              {message.translation && (
                <p
                  data-history-translation
                  style={{ fontSize: `${prefs.translationFontSize}px` }}
                  className="mt-0.5 leading-snug text-white/85"
                >
                  {message.translation}
                </p>
              )}
              {message.romanization && (
                <p
                  data-history-romanization
                  style={{ fontSize: `${prefs.romanizationFontSize}px` }}
                  className="mt-0.5 leading-snug text-accent-soft/70"
                >
                  {message.romanization}
                </p>
              )}
              {message.reply && (
                <p className="mt-0.5 text-[11px] leading-snug text-ok/80">回复：{message.reply}</p>
              )}
              {message.translationError && (
                <p className="mt-0.5 text-[10px] leading-relaxed text-danger/75">
                  {message.translationError.title} · {message.translationError.hint}
                </p>
              )}
            </div>
          ))
        ) : (
          <p className="py-4 text-center text-[11px] text-white/35">
            {detailLoading ? '正在读取…' : '这一段没有可显示的消息'}
          </p>
        )}
      </div>

      <p className="mt-1.5 text-[10px] leading-relaxed text-white/30">
        这里显示的是当时保存下来的原文、译文和谐音，不会重新翻译、也不会再调用模型。
        {detailId ? `会话 ${detailId.slice(0, 10)}…` : ''}
        <button
          type="button"
          onClick={() => {
            void useHistoryStore
              .getState()
              .exportData({ sessionId: detailId ?? undefined, format: 'text' })
              .then((result) => onNotice(result.message));
          }}
          className="no-drag ml-1.5 underline decoration-dotted hover:text-white/70"
        >
          导出这一段
        </button>
      </p>
      <p className="text-[10px] text-white/25">
        每页 {HISTORY_PAGE_SIZE} 条，按顺序拼接，不重复、不漏条。
      </p>
    </div>
  );
}
