import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SAMPLE_CASES, directionFor, sampleVariant } from '../../shared/samples';
import { useSettingsStore } from '../stores/settings';

/**
 * 三组可体验样例。
 *
 * 这个面板存在的意义是让评委（或任何一个第一次打开软件的人）在**不接任何
 * Key、不放任何真实音频**的情况下，把「字幕 → 译文 → 关键信息 → 保存」这条
 * 链路亲手走一遍，并且能核对三件最难的事：时间、否定改期、金额纠正。
 *
 * 证据等级必须写在脸上：
 *  - 这些句子是**预置文本**，点下去只是把它注入字幕流；
 *  - 它不证明语音识别准不准，也不证明真实模型的翻译质量；
 *  - 真实音频链路的测试记录见交付文档的「测试记录表」，未执行的一律写「未执行」。
 */
export function SamplesPanel({ onClose }: { onClose: () => void }) {
  const mockMode = useSettingsStore((state) => state.settings.mockMode);
  const nativeLanguage = useSettingsStore((state) => state.settings.nativeLanguage);
  const targetLanguage = useSettingsStore((state) => state.settings.targetLanguage);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const direction = directionFor(nativeLanguage, targetLanguage);

  useEffect(() => {
    closeRef.current?.focus();
    const shell = document.querySelector<HTMLElement>('[data-app-shell]');
    if (shell) shell.inert = true;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (shell) shell.inert = false;
    };
  }, [onClose]);

  const run = async (id: string) => {
    setBusy(id);
    try {
      const result = await window.copilot.samplesRun(id);
      setNotice(
        result.ok
          ? '已注入这一句（预置文本）。看下面字幕区的原文、译文和「关键信息」卡片。'
          : (result.message ?? '这一句没能运行'),
      );
    } catch {
      setNotice('运行失败，请重试');
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div
      data-samples-panel
      role="dialog"
      aria-modal="true"
      aria-label="三组可体验样例"
      style={{ position: 'fixed', inset: 0, zIndex: 65 }}
      className="subtle-scroll overflow-y-auto bg-ink-950 px-3 py-3"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-white/90">三组可体验样例</p>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-white/45">
            预置文本，用来验证界面流程和「关键信息」是否抓对；<b className="text-warn/80">不是</b>
            真实语音识别的结果，也不会调用付费接口。
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          data-samples-close
          onClick={onClose}
          aria-label="关闭样例面板，回到字幕"
          className="no-drag shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11.5px] text-white/75
            hover:bg-ink-800 hover:text-white"
        >
          关闭
        </button>
      </div>

      {!mockMode && (
        <p className="mb-2 rounded-lg border border-warn/35 bg-warn/10 px-2 py-1.5 text-[10.5px] leading-relaxed text-warn">
          现在是真实采集模式。样例只在演示模式下运行，避免把预置文本混进你的真实记录，
          也避免误以为这是识别结果。要体验请到「设置 → API 功能」打开演示模式。
        </p>
      )}

      {notice && (
        <p
          data-samples-notice
          role="status"
          className="mb-2 rounded-lg border border-line-soft bg-ink-850 px-2 py-1.5 text-[10.5px] leading-relaxed text-white/70"
        >
          {notice}
        </p>
      )}

      <div className="space-y-2">
        {!direction && (
          <p
            data-samples-direction-missing
            className="rounded-lg border border-warn/35 bg-warn/10 px-2 py-1.5 text-[10.5px] leading-relaxed text-warn"
          >
            当前是「{nativeLanguage} → {targetLanguage}」，这一组没有预置样例。
            本版只对「中文 → 英语」「日语 → 英语」「英语 → 日语」写了逐句核对过的样例；
            换成这三个之一，这里就会出现三句可点的样例。
          </p>
        )}
        {direction &&
          SAMPLE_CASES.map((sample) => {
            const variant = sampleVariant(sample, direction);
            if (!variant) return null;
            return (
              <div
                key={sample.id}
                data-sample-case={sample.id}
                data-sample-direction={direction}
                className="rounded-xl border border-line-soft bg-ink-850 px-2.5 py-2"
              >
                <p className="text-[11.5px] font-medium text-white/85">{sample.title}</p>
                <p data-sample-original className="mt-1 text-[12px] leading-snug text-white/90">
                  {variant.original}
                </p>
                <p data-sample-translated className="mt-0.5 text-[11px] leading-snug text-white/55">
                  参考译文：{variant.translation}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {variant.focus.map((line) => (
                    <li key={line} className="text-[10px] leading-relaxed text-accent-soft/70">
                      · {line}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  data-sample-run={sample.id}
                  disabled={busy !== null}
                  onClick={() => void run(sample.id)}
                  className="no-drag mt-1.5 rounded-lg border border-accent/40 bg-accent/12 px-2.5 py-1
                    text-[11px] font-medium text-accent-soft transition-colors hover:bg-accent/20
                    disabled:opacity-40"
                >
                  {busy === sample.id ? '正在注入…' : '试这一句'}
                </button>
              </div>
            );
          })}
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-white/30">
        真实语音链路的测试（真音频 → 真识别 → 真翻译）需要麦克风/系统声音与可用的
        识别额度，本轮见「测试记录表」；没有执行的项目写「未执行」，不写成通过。
      </p>
    </div>,
    document.body,
  );
}
