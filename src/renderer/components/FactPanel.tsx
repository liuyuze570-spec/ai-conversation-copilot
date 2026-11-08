import { useEffect, useMemo, useRef, useState } from 'react';
import { useFactsStore } from '../stores/facts';
import { useSettingsStore } from '../stores/settings';
import { FACT_LABELS, deriveSpoken, factStatusLabel, type FactItem } from '../../shared/facts';
import { retryFactSave } from '../lib/history-sync';
import { useHistoryStore } from '../stores/history';
import { IconChevronDown, IconSpeaker } from './icons';

/**
 * 「重点信息」——关键事实确认卡。
 *
 * 位置：实时翻译条和字幕列表之间，**默认折叠**。
 *
 * 为什么不放浮层：这个窗口只有 460px 宽，浮层一定会挡住字幕或底部那个
 * 「暂停 / 生成回复」主按钮。折叠成一行标题既提示「有重点信息」，又不抢地方；
 * 展开后自身滚动，高度封顶，绝不把主按钮顶出屏幕。
 */
export function FactPanel({
  onLocate,
  onSpeak,
}: {
  /** 点击某条事实 → 滚到它来源的那句字幕并高亮。 */
  onLocate: (itemId: string) => void;
  /** 朗读生成的确认句（用户主动点，不自动播）。 */
  onSpeak: (text: string, id: string) => void;
}) {
  const items = useFactsStore((state) => state.items);
  const selected = useFactsStore((state) => state.selected);
  const confirming = useFactsStore((state) => state.confirming);
  const draft = useFactsStore((state) => state.draft);
  const error = useFactsStore((state) => state.error);
  const update = useFactsStore((state) => state.update);
  const remove = useFactsStore((state) => state.remove);
  const toggleSelected = useFactsStore((state) => state.toggleSelected);
  const clearSelection = useFactsStore((state) => state.clearSelection);
  const setConfirming = useFactsStore((state) => state.setConfirming);
  const setDraft = useFactsStore((state) => state.setDraft);
  const setError = useFactsStore((state) => state.setError);
  const factSaveState = useHistoryStore((state) => state.factSaveState);
  const fontSize = useSettingsStore((state) => state.settings.subtitle.fontSize);
  const language = useSettingsStore((state) => state.settings.targetLanguage);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [speakingValue, setSpeakingValue] = useState('');
  const [copied, setCopied] = useState(false);
  const requestRef = useRef('');

  const selectedItems = useMemo(
    () => items.filter((item) => selected[item.id]),
    [items, selected],
  );
  const selectedCount = selectedItems.length;

  // 面板卸载（切会话 / 关窗）时把在途的生成请求掐掉。
  useEffect(
    () => () => {
      if (requestRef.current) void window.copilot.aiCancel(requestRef.current);
    },
    [],
  );

  // 没有事实时不占位置，也不显示空壳标题。
  if (!items.length) return null;

  const confirm = async () => {
    if (!selectedCount || confirming) return;
    const requestId = `cf:${Date.now()}`;
    requestRef.current = requestId;
    // 记下这次请求基于哪一版事实：回来时版本变了就说明用户改过，结果作废。
    const atVersion = useFactsStore.getState().version;
    setConfirming(true);
    setError(null);
    try {
      const result = await window.copilot.aiConfirm({
        facts: selectedItems,
        language,
        requestId,
      });
      // 用户已经清空 / 换选 / 改值 → 这条结果不再对应当前事实，丢弃。
      if (requestRef.current !== requestId) return;
      if (useFactsStore.getState().version !== atVersion) return;
      if (!result.ok) {
        setError(result.message ?? '生成失败，请重试');
        return;
      }
      setDraft({
        sentence: result.sentence,
        chinese: result.chinese,
        factIds: selectedItems.map((item) => item.id),
      });
    } catch (e) {
      if (requestRef.current === requestId) setError('生成失败，请重试');
      // 只留错误码：IPC 抛回来的 message 里可能带着服务商原文（含你说的那句话）。
      const code =
        (e as { code?: string } | null)?.code ?? (e instanceof Error ? e.name : 'unknown');
      window.copilot.log('WARN', 'Renderer', `confirm failed: ${code}`);
    } finally {
      if (requestRef.current === requestId) {
        requestRef.current = '';
        setConfirming(false);
      }
    }
  };

  const copyDraft = async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft.sentence);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('复制失败，可以手动选中文本复制');
    }
  };

  const startEdit = (fact: FactItem) => {
    setEditingId(fact.id);
    setEditingValue(fact.value);
  };

  /** 改「现在该怎么说」—— 目标语言的说法，改完当前这一行立刻用新的。 */
  const startSpeakEdit = (fact: FactItem) => {
    setSpeakingId(fact.id);
    setSpeakingValue(fact.spoken ?? fact.sourceText);
  };

  const commitSpoken = () => {
    if (speakingId) update(speakingId, { spoken: speakingValue });
    setSpeakingId(null);
  };

  const commitEdit = () => {
    if (editingId) update(editingId, { value: editingValue });
    setEditingId(null);
  };

  // 只展示最近的一批；全部事实仍然保存在 store 里（上限 300 条）。
  const visible = items.slice(-8).reverse();

  return (
    <div data-fact-panel className="shrink-0 border-b border-line-soft bg-ink-900/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="fact-panel-body"
        data-fact-toggle
        title="从这段对话里抓到的关键信息（时间、地点、金额、待办…）"
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors hover:bg-ink-800/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="text-[11px] font-medium text-accent-soft/90">重点信息</span>
        <span className="tnum rounded-full bg-accent/15 px-1.5 py-[1px] text-[9.5px] text-accent-soft/80">
          {items.length}
        </span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-white/35">
            {items[items.length - 1]?.value}
          </span>
        )}
        {open && <span className="flex-1" />}
        <span
          className={`shrink-0 text-white/35 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          aria-hidden
        >
          <IconChevronDown size={12} />
        </span>
      </button>

      {open && (
        <div id="fact-panel-body" className="px-2 pb-2">
          {/* 高度同时受 rem 和视口约束：460x640 的悬浮窗里，固定 208px 会把字幕区
              压到只剩十几像素（自检量到 subtitle h=16）。按视口收一收，
              展开后仍能看到 3–4 条 + 滚动，字幕也保留可读高度。 */}
          <div className="subtle-scroll max-h-[min(9rem,28vh)] space-y-1 overflow-y-auto pr-0.5">
            {visible.map((fact) => {
              const pending = fact.status !== 'confirmed';
              const editing = editingId === fact.id;
              // 改过值、又推不出可信说法 → 这一行必须让用户自己补一句。
              const needWording = fact.edited && !fact.spoken && !deriveSpoken(fact, language).ok;
              return (
                <div
                  key={fact.id}
                  data-fact-row
                  className={`group rounded-lg px-1.5 py-1 transition-colors hover:bg-ink-850/70 ${
                    fact.status === 'confirmed' ? 'opacity-60' : ''
                  }`}
                >
                  <div className="flex items-start gap-1.5">
                    <input
                      type="checkbox"
                      checked={Boolean(selected[fact.id])}
                      onChange={() => toggleSelected(fact.id)}
                      aria-label={`选择「${FACT_LABELS[fact.kind]}：${fact.value}」用于生成确认句`}
                      className="mt-[3px] h-3 w-3 shrink-0 accent-[color:var(--accent)]"
                    />
                    <span className="mt-[1px] shrink-0 rounded bg-ink-700 px-1 py-[1px] text-[9.5px] text-white/60">
                      {FACT_LABELS[fact.kind]}
                    </span>

                    {editing ? (
                      <input
                        autoFocus
                        value={editingValue}
                        onChange={(event) => setEditingValue(event.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitEdit();
                          if (event.key === 'Escape') setEditingId(null);
                        }}
                        data-fact-edit-input
                        aria-label="修改这条事实"
                        className="min-w-0 flex-1 rounded border border-line bg-ink-800 px-1 py-[1px] text-white/90 outline-none focus:border-accent"
                        style={{ fontSize: `${Math.max(11, fontSize - 3)}px` }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => onLocate(fact.itemId)}
                        title="跳到这句话所在的位置"
                        className="min-w-0 flex-1 text-left leading-snug text-white/90 hover:text-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                        style={{ fontSize: `${Math.max(11, fontSize - 3)}px` }}
                      >
                        {fact.value}
                      </button>
                    )}

                    <span
                      className={`shrink-0 rounded px-1 py-[1px] text-[9px] ${
                        fact.status === 'confirmed'
                          ? 'bg-ok/15 text-ok/90'
                          : fact.certainty === 'uncertain'
                            ? 'bg-warn/15 text-warn/90'
                            : 'bg-ink-700 text-white/45'
                      }`}
                    >
                      {factStatusLabel(fact)}
                    </span>
                  </div>

                  <div className="ml-[18px] mt-0.5 flex items-center gap-1.5">
                    <span
                      className="min-w-0 flex-1 truncate text-[10px] text-white/30"
                      title={`原话：${fact.sourceText}${fact.spoken ? ` ｜ 现在要说：${fact.spoken}` : ''}`}
                    >
                      「{fact.sourceText}」
                      {fact.edited && fact.originalValue
                        ? ` · 已从「${fact.originalValue}」改为「${fact.value}」`
                        : ''}
                      {fact.edited && fact.spoken ? ` · 要说：${fact.spoken}` : ''}
                    </span>
                    {needWording && (
                      <span
                        data-fact-need-wording
                        className="shrink-0 rounded bg-warn/15 px-1 text-[9px] text-warn/90"
                        title="你改了这条，但我没法可靠地换成外语说法；生成确认句前要先补一句"
                      >
                        需补说法
                      </span>
                    )}

                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <RowAction label="定位" action="locate" onClick={() => onLocate(fact.itemId)} />
                      <RowAction label="修改" action="edit" onClick={() => startEdit(fact)} />
                      <RowAction label="改说法" action="spoken" onClick={() => startSpeakEdit(fact)} />
                      <RowAction
                        label={pending ? '确认' : '取消确认'}
                        action="confirm"
                        onClick={() =>
                          update(fact.id, { status: pending ? 'confirmed' : 'pending' })
                        }
                      />
                      <RowAction label="删除" action="remove" danger onClick={() => remove(fact.id)} />
                    </div>
                  </div>

                  {speakingId === fact.id && (
                    <div data-fact-spoken-editor className="ml-[18px] mt-1 rounded-md bg-ink-800/80 px-1.5 py-1">
                      <input
                        autoFocus
                        value={speakingValue}
                        onChange={(event) => setSpeakingValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitSpoken();
                          if (event.key === 'Escape') setSpeakingId(null);
                        }}
                        data-fact-spoken-input
                        aria-label="现在要对对方说的说法"
                        placeholder={fact.sourceText}
                        className="w-full rounded border border-line bg-ink-900 px-1 py-[2px] text-white/90 outline-none focus:border-accent"
                        style={{ fontSize: `${Math.max(11, fontSize - 3)}px` }}
                      />
                      <div className="mt-1 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={commitSpoken}
                          data-fact-spoken-save
                          className="rounded bg-accent/20 px-1.5 py-[1px] text-[9.5px] text-accent-soft hover:bg-accent/30"
                        >
                          保存说法
                        </button>
                        <button
                          type="button"
                          onClick={() => setSpeakingId(null)}
                          className="rounded px-1.5 py-[1px] text-[9.5px] text-white/40 hover:text-white/70"
                        >
                          取消
                        </button>
                        <span className="min-w-0 flex-1 truncate text-[9px] text-white/30">
                          用对方能听懂的话写；数字要跟你改后的值一致
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-1.5 flex items-center gap-1.5 border-t border-line-soft pt-1.5">
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={!selectedCount || confirming}
              data-fact-confirm
              className="rounded-lg bg-accent/20 px-2 py-1 text-[10.5px] font-medium text-accent-soft
                transition-colors hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {confirming ? '生成中…' : `帮我确认${selectedCount ? `（${selectedCount}）` : ''}`}
            </button>
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={clearSelection}
                className="rounded-lg px-1.5 py-1 text-[10px] text-white/40 hover:bg-ink-700 hover:text-white/70"
              >
                取消选择
              </button>
            )}
            <span className="min-w-0 flex-1 truncate text-right text-[9.5px] text-white/25">
              {selectedCount ? '只使用你勾选的信息' : '勾选几条，我帮你写成一句确认'}
            </span>
          </div>

          {error && (
            <p data-fact-error className="mt-1 text-[10px] leading-snug text-danger/85">
              {error}
            </p>
          )}

          {/*
            事实卡自己的保存状态。
            字幕存成功 ≠ 事实卡存成功：两套数据、两次写入，必须分开说。
          */}
          <div
            data-fact-save-state={factSaveState}
            className="mt-1 flex items-center gap-1.5 text-[9px]"
          >
            <span
              className={
                factSaveState === 'failed'
                  ? 'text-danger/85'
                  : factSaveState === 'saved'
                    ? 'text-ok/80'
                    : 'text-white/30'
              }
            >
              {
                {
                  idle: '事实卡：还没写',
                  pending: '事实卡：待保存',
                  saving: '事实卡：正在保存…',
                  saved: '事实卡：已保存',
                  failed: '事实卡：尚未保存',
                }[factSaveState]
              }
            </span>
            {factSaveState === 'failed' && (
              <button
                type="button"
                onClick={() => retryFactSave()}
                data-fact-save-retry
                className="rounded bg-ink-700 px-1 py-[1px] text-[9px] text-white/70 hover:bg-ink-600 hover:text-white"
              >
                重试
              </button>
            )}
            <span className="min-w-0 flex-1 truncate text-right text-white/20">
              原话与修改记录都会留档
            </span>
          </div>

          {draft && (
            <div
              data-fact-draft
              className="mt-1.5 rounded-lg border border-accent/25 bg-accent/[0.07] px-2 py-1.5"
            >
              <p
                className="leading-snug text-white/90"
                style={{ fontSize: `${Math.max(11, fontSize - 2)}px` }}
              >
                {draft.sentence}
              </p>
              <p className="mt-0.5 text-[10px] leading-snug text-white/45">{draft.chinese}</p>
              <div className="mt-1 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void copyDraft()}
                  className="rounded-md bg-ink-700 px-1.5 py-[2px] text-[9.5px] text-white/70 hover:bg-ink-600 hover:text-white"
                >
                  {copied ? '已复制' : '复制'}
                </button>
                <button
                  type="button"
                  onClick={() => onSpeak(draft.sentence, `fact-${draft.factIds.join('-')}`)}
                  className="inline-flex items-center gap-1 rounded-md bg-ink-700 px-1.5 py-[2px] text-[9.5px] text-white/70 hover:bg-ink-600 hover:text-white"
                >
                  <IconSpeaker size={10} /> 朗读
                </button>
                <span className="text-[9px] text-white/25">不会自动发送给任何人</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RowAction({
  label,
  action,
  onClick,
  danger,
}: {
  label: string;
  action: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-fact-action={action}
      className={`rounded px-1 py-[1px] text-[9.5px] transition-colors ${
        danger
          ? 'text-white/30 hover:bg-danger/20 hover:text-danger'
          : 'text-white/30 hover:bg-ink-700 hover:text-white/80'
      }`}
    >
      {label}
    </button>
  );
}
