import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ApiError,
  getFeedbackConfig,
  queryFeedback,
  submitFeedback,
  type FeedbackConfig,
  type FeedbackRecord,
  type FeedbackReceipt,
} from './api';

/**
 * 反馈：真提交、真编号、真查询。
 *
 * 三条不能让步：
 *  1. 失败时**不清空输入框**（网络错、超限、重复提交都一样），用户写的字不能丢；
 *  2. 默认不带原文/译文/诊断，要带必须先在这里预览再自己勾；录音根本不进这条链路；
 *  3. 状态由服务端给，提交完就是「已收到」，界面没有「已修复」按钮。
 */
export interface FeedbackContext {
  original?: string;
  translation?: string;
  reply?: string;
}

const FALLBACK_CATEGORIES = [
  { value: 'recognition', label: '识别' },
  { value: 'translation', label: '翻译' },
  { value: 'money_date', label: '金额日期' },
  { value: 'reply', label: '回复' },
  { value: 'pronunciation', label: '近音' },
  { value: 'operation', label: '操作问题' },
  { value: 'other', label: '其他' },
];

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'FEEDBACK_EMPTY': return '还没写内容：请写一下哪里不对，或建议怎么说。';
      case 'FEEDBACK_TOO_LONG': return '超过 1000 个字符了，删一点再提交（你写的内容还在）。';
      case 'FEEDBACK_DUPLICATE': return '刚才已经提交过一模一样的内容了，没有重复入库。';
      case 'FEEDBACK_CATEGORY': return '问题类型不对，请重新选一个。';
      case 'FEEDBACK_STORE_UNAVAILABLE': return '这台服务没有启用持久反馈库，内容没有保存。';
      case 'FEEDBACK_NOT_FOUND': return '编号或查询凭证不对；凭证不对时不显示反馈内容。';
      default: return `提交失败（${error.code}）：${error.message}`;
    }
  }
  return '提交失败：连不上服务。你写的内容还在，可以稍后再试。';
}

export function FeedbackPanel({
  context,
  version,
  build,
}: {
  context: FeedbackContext | null;
  version?: string;
  build?: string;
}): ReactNode {
  const [config, setConfig] = useState<FeedbackConfig | null>(null);
  const [where, setWhere] = useState('');
  const [suggest, setSuggest] = useState('');
  const [category, setCategory] = useState('translation');
  const [attach, setAttach] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<FeedbackReceipt | null>(null);

  const [queryTicket, setQueryTicket] = useState('');
  const [queryToken, setQueryToken] = useState('');
  const [queryBusy, setQueryBusy] = useState(false);
  const [queryError, setQueryError] = useState('');
  const [record, setRecord] = useState<FeedbackRecord | null>(null);

  useEffect(() => {
    let alive = true;
    getFeedbackConfig()
      .then((cfg) => {
        if (alive) setConfig(cfg);
      })
      .catch(() => {
        if (alive) setConfig(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const maxChars = config?.max_chars ?? 1000;
  // 与服务端 feedback_body() 同式：两栏 trim 后用换行拼起来再 trim，
  // 按 Unicode 码点数（[...str].length），不是 UTF-8 字节数。
  const body = `${where.trim()}\n${suggest.trim()}`.trim();
  const chars = useMemo(() => [...body].length, [body]);
  const remaining = maxChars - chars;
  const tooLong = remaining < 0;
  const blank = chars === 0;

  const diagnostics = JSON.stringify(
    {
      app_version: version ?? '',
      build: build ?? '',
      source_language: 'en',
      // 只有非个人、非内容的信息；不取录音、不取历史、不取 Key。
      browser_language: navigator.language,
    },
    null,
    0,
  );

  const submit = async () => {
    if (busy || blank || tooLong) return;
    setBusy(true);
    setError('');
    try {
      const result = await submitFeedback({
        where_wrong: where,
        suggestion: suggest,
        category,
        original: attach ? (context?.original ?? '') : '',
        translation: attach ? (context?.translation ?? '') : '',
        reply_text: attach ? (context?.reply ?? '') : '',
        diagnostics: attach ? diagnostics : '',
        attach_context: attach,
      });
      setReceipt(result);
      setQueryTicket(result.ticket);
      setQueryToken(result.token);
      setRecord(null);
      // 成功后才清空，失败路径一律保留。
      setWhere('');
      setSuggest('');
      setAttach(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const lookup = async () => {
    if (queryBusy || !queryTicket.trim() || !queryToken.trim()) return;
    setQueryBusy(true);
    setQueryError('');
    setRecord(null);
    try {
      setRecord(await queryFeedback(queryTicket.trim(), queryToken.trim()));
    } catch (failure) {
      setQueryError(errorMessage(failure));
    } finally {
      setQueryBusy(false);
    }
  };

  return (
    <section aria-labelledby="feedback-heading" className="mt-4" data-testid="feedback-panel">
      <h2 id="feedback-heading" className="text-base font-semibold text-white">
        翻译有误 / 意见反馈
      </h2>
      <p className="muted mt-1 text-[12.5px] text-white/55">
        提交后会写进服务端数据库并给一个编号。没有管理员凭据时状态只会停在「已收到」，
        不会提交完就显示「已修复」。
      </p>

      <div className="mt-3 space-y-3">
        <label className="block">
          <span className="text-[12.5px] text-white/75">哪里不正确 *</span>
          <textarea
            value={where}
            onChange={(event) => setWhere(event.target.value)}
            rows={3}
            placeholder="例如：原话没有说币种，译文却写了美元"
            aria-label="哪里不正确"
            data-testid="feedback-where"
            className="mt-1 w-full resize-y rounded-xl border border-white/12 bg-ink-950/60 p-2.5 text-[13.5px] leading-relaxed text-white outline-none focus-visible:border-accent"
          />
        </label>

        <label className="block">
          <span className="text-[12.5px] text-white/75">建议怎么说</span>
          <textarea
            value={suggest}
            onChange={(event) => setSuggest(event.target.value)}
            rows={3}
            placeholder="例如：显示「币种未说明」，并问对方是什么币种"
            aria-label="建议表达"
            data-testid="feedback-suggest"
            className="mt-1 w-full resize-y rounded-xl border border-white/12 bg-ink-950/60 p-2.5 text-[13.5px] leading-relaxed text-white outline-none focus-visible:border-accent"
          />
        </label>

        <fieldset>
          <legend className="text-[12.5px] text-white/75">问题类型</legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {(config?.categories ?? FALLBACK_CATEGORIES).map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={category === item.value}
                data-testid={`feedback-category-${item.value}`}
                onClick={() => setCategory(item.value)}
                className={`rounded-lg px-2.5 py-1 text-[12px] ${
                  category === item.value
                    ? 'bg-accent/30 text-white ring-1 ring-accent'
                    : 'border border-white/15 text-white/75'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </fieldset>

        <div>
          <p
            className={`text-[12px] ${tooLong ? 'text-amber-300' : 'text-white/50'}`}
            data-testid="feedback-counter"
            role="status"
          >
            已输入 {chars} 个字符 / 最多 {maxChars}，剩余 {Math.max(remaining, 0)}
            {tooLong ? `（超出 ${-remaining}，请删减）` : ''}
          </p>
          <p className="mt-1 text-[11px] text-white/40">
            按 Unicode 字符计数，与服务端一致；只计上面两栏。
          </p>
        </div>

        <div className="rounded-xl border border-white/12 p-2.5">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={attach}
              onChange={(event) => setAttach(event.target.checked)}
              aria-label="附带当前句子的上下文"
              data-testid="feedback-attach"
              className="mt-1 h-4 w-4"
            />
            <span className="text-[12.5px] text-white/80">
              附带当前原文、译文和诊断信息（默认不附）
            </span>
          </label>
          <p className="mt-1.5 text-[11.5px] text-white/45">
            勾选前先看一遍下面这些将一起提交的内容。不附录音、不附历史对话、不附密钥。
          </p>
          <div className="mt-2 space-y-1 text-[11.5px] text-white/60" data-testid="feedback-preview">
            <p><span className="text-white/40">原文：</span>{context?.original || '（本次没有原文）'}</p>
            <p><span className="text-white/40">译文：</span>{context?.translation || '（本次没有译文）'}</p>
            <p><span className="text-white/40">回复：</span>{context?.reply || '（未指定回复）'}</p>
            <p><span className="text-white/40">诊断：</span>{diagnostics}</p>
          </div>
        </div>

        <button
          type="button"
          disabled={busy || blank || tooLong}
          onClick={() => void submit()}
          aria-label="提交反馈"
          data-testid="feedback-submit"
          className="rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
        >
          {busy ? '提交中…' : '提交反馈'}
        </button>

        {error ? (
          <p role="alert" className="text-[12.5px] text-amber-300" data-testid="feedback-error">
            {error}
          </p>
        ) : null}

        {receipt ? (
          <div
            className="rounded-xl border border-emerald-400/30 bg-emerald-400/5 p-3"
            data-testid="feedback-receipt"
          >
            <p className="text-[13px] text-white">
              已收到，编号 <strong className="font-semibold" data-testid="feedback-ticket">{receipt.ticket}</strong>
              {' · '}状态 <strong>{receipt.status_label}</strong>
            </p>
            <p className="mt-1 text-[11.5px] text-white/60">
              查询凭证（只显示这一次，请自己保存）：
              <code className="ml-1 break-all text-[11px] text-white/85" data-testid="feedback-token">
                {receipt.token}
              </code>
            </p>
            <p className="mt-1 text-[11px] text-white/45">
              状态推进需要管理员凭据并在修复验证之后进行；没有配置时一直显示「已收到」。
            </p>
          </div>
        ) : null}
      </div>

      <div className="mt-5 border-t border-white/10 pt-4">
        <h3 className="text-[13px] font-medium text-white">查询受理状态</h3>
        <p className="mt-1 text-[11.5px] text-white/45">
          要同时有编号和查询凭证才看得到内容；凭证不对不返回任何反馈正文。
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            value={queryTicket}
            onChange={(event) => setQueryTicket(event.target.value)}
            placeholder="反馈编号"
            aria-label="反馈编号"
            data-testid="feedback-query-ticket"
            className="min-w-[160px] flex-1 rounded-lg border border-white/12 bg-ink-950/60 px-2.5 py-1.5 text-[12.5px] text-white outline-none focus-visible:border-accent"
          />
          <input
            value={queryToken}
            onChange={(event) => setQueryToken(event.target.value)}
            placeholder="查询凭证"
            aria-label="查询凭证"
            data-testid="feedback-query-token"
            className="min-w-[160px] flex-1 rounded-lg border border-white/12 bg-ink-950/60 px-2.5 py-1.5 text-[12.5px] text-white outline-none focus-visible:border-accent"
          />
          <button
            type="button"
            disabled={queryBusy || !queryTicket.trim() || !queryToken.trim()}
            onClick={() => void lookup()}
            aria-label="查询反馈状态"
            data-testid="feedback-query-submit"
            className="rounded-lg border border-white/20 px-3 py-1.5 text-[12.5px] text-white disabled:opacity-40"
          >
            查询
          </button>
        </div>
        {queryError ? (
          <p role="alert" className="mt-2 text-[12.5px] text-amber-300" data-testid="feedback-query-error">
            {queryError}
          </p>
        ) : null}
        {record ? (
          <div className="mt-2 rounded-xl border border-white/12 p-2.5" data-testid="feedback-query-result">
            <p className="text-[12.5px] text-white">
              {record.ticket} · <span data-testid="feedback-query-status">{record.status_label}</span>
              {record.fixed_version ? ` · 修复版本 ${record.fixed_version}` : ''}
            </p>
            <p className="mt-1 text-[11.5px] text-white/60">{record.where_wrong}</p>
            {record.suggestion ? (
              <p className="mt-0.5 text-[11.5px] text-white/50">建议：{record.suggestion}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
