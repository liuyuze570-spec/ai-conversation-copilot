import { useEffect, useMemo, useState } from 'react';
import { cleanIpcError, useSettingsStore } from '../../stores/settings';
import { useAiStatusStore } from '../../stores/ai-status';
import {
  CUSTOM_PROVIDER_ID,
  DOMESTIC_PROVIDERS,
  checkDomesticURL,
  findProvider,
  recommendedProvider,
  sameHost,
} from '../../../shared/providers';
import type { Settings } from '../../../shared/types';
import { Button, Hint, Row, Section, Select, Toggle } from './controls';

/**
 * 「API 功能」标签页：把「怎么连上模型」这件事做到新手也能一次成功。
 *
 * 设计要点（都来自实际踩过的坑）：
 * 1. 不让用户手写 Base URL —— 从国内服务商列表里选，自动填地址和模型；
 * 2. 只允许国内接口 —— 输入框边填边校验，国外地址直接拦下来并说清原因；
 * 3. 「测试连接」真的发一次请求，把「地址 / Key / 模型」哪一步错了讲明白；
 * 4. 一个 Key 能同时管文字和语音识别（同一家服务商时自动共用）；
 * 5. 旁边就是图文教程，卡住了点一下就有答案。
 */
export function ApiSettings() {
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);

  const keyInfo = useAiStatusStore((state) => state.keyInfo);
  const refreshKeys = useAiStatusStore((state) => state.refreshKeys);
  const test = useAiStatusStore((state) => state.test);
  const testing = useAiStatusStore((state) => state.testing);
  const runTest = useAiStatusStore((state) => state.runTest);
  const setTest = useAiStatusStore((state) => state.setTest);

  const [llmKey, setLlmKey] = useState('');
  const [llmKeySaved, setLlmKeySaved] = useState(false);
  const [sttKey, setSttKey] = useState('');
  const [sttKeySaved, setSttKeySaved] = useState(false);
  const [urlDraft, setUrlDraft] = useState(settings.ai.baseURL);
  const [sttUrlDraft, setSttUrlDraft] = useState(settings.ai.sttBaseURL);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    void refreshKeys();
  }, [refreshKeys]);

  useEffect(() => setUrlDraft(settings.ai.baseURL), [settings.ai.baseURL]);
  useEffect(() => setSttUrlDraft(settings.ai.sttBaseURL), [settings.ai.sttBaseURL]);
  // 换了服务商 / 模型之后，上一次的测试结论就作废了。
  useEffect(() => setTest(null), [settings.ai.provider, settings.ai.model, settings.ai.baseURL, setTest]);

  const provider = findProvider(settings.ai.provider) ?? null;
  const sttProvider = findProvider(settings.ai.sttProvider) ?? null;
  const sttSameAsLlm = sameHost(settings.ai.baseURL, settings.ai.sttBaseURL);

  /** 统一处理保存失败（例如国外地址被拦下）。 */
  const guard = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(cleanIpcError(caught));
    }
  };

  // ---- 服务商切换：地址、模型、语音识别一起跟着变 -------------------------
  const applyProvider = async (id: string) => {
    setNotice(null);
    setModels([]);
    if (id === CUSTOM_PROVIDER_ID) {
      await guard(() => update({ ai: { ...settings.ai, provider: CUSTOM_PROVIDER_ID } }));
      setShowAdvanced(true);
      return;
    }
    const next = findProvider(id);
    if (!next) return;
    const ai: Settings['ai'] = {
      ...settings.ai,
      provider: next.id,
      baseURL: next.llmBaseURL,
      model: next.llmModels[0]?.id ?? settings.ai.model,
    };
    // 之前语音识别和文字模型是同一家 → 一起跟着换；否则保持用户已经选好的那家。
    if (sttSameAsLlm && next.sttBaseURL && next.sttModels?.length) {
      ai.sttProvider = next.id;
      ai.sttBaseURL = next.sttBaseURL;
      ai.sttModel = next.sttModels[0].id;
    }
    await guard(() => update({ ai }));
    if (!next.sttBaseURL) {
      setNotice(
        `${next.label}只提供文字模型，不提供语音识别。字幕需要另配一家支持「语音转文字」的服务商。`,
      );
    }
  };

  /** 把语音识别切到推荐服务商（硅基流动），解决「这家不做语音」的问题。 */
  const useRecommendedStt = async () => {
    const fallback = recommendedProvider();
    await guard(() =>
      update({
        ai: {
          ...settings.ai,
          sttProvider: fallback.id,
          sttBaseURL: fallback.sttBaseURL ?? fallback.llmBaseURL,
          sttModel: fallback.sttModels?.[0]?.id ?? settings.ai.sttModel,
        },
      }),
    );
    setNotice(`语音识别已切到 ${fallback.label}，用同一个 Key 就行。`);
  };

  const applySttProvider = async (id: string) => {
    if (id === CUSTOM_PROVIDER_ID) {
      await guard(() => update({ ai: { ...settings.ai, sttProvider: CUSTOM_PROVIDER_ID } }));
      return;
    }
    const next = findProvider(id);
    if (!next) return;
    await guard(() =>
      update({
        ai: {
          ...settings.ai,
          sttProvider: next.id,
          sttBaseURL: next.sttBaseURL ?? next.llmBaseURL,
          sttModel: next.sttModels?.[0]?.id ?? settings.ai.sttModel,
        },
      }),
    );
  };

  const saveLlmKey = async () => {
    const value = llmKey.trim();
    await guard(async () => {
      await window.copilot.setApiKey(value, 'llm');
      setLlmKeySaved(true);
      setLlmKey('');
      await refreshKeys();
    });
  };

  const saveSttKey = async () => {
    const value = sttKey.trim();
    await guard(async () => {
      await window.copilot.setApiKey(value, 'stt');
      setSttKeySaved(true);
      setSttKey('');
      await refreshKeys();
    });
  };

  const refreshModelList = async () => {
    setLoadingModels(true);
    setError(null);
    try {
      const result = await window.copilot.aiModels();
      if (result.ok) {
        setModels(result.models);
        setNotice(`拿到 ${result.models.length} 个可用模型，已加进下拉列表。`);
      } else {
        setError(result.message ?? '拉取模型列表失败');
      }
    } finally {
      setLoadingModels(false);
    }
  };

  // ---- 下拉选项 ----------------------------------------------------------
  const modelOptions = useMemo(() => {
    const preset = (provider?.llmModels ?? []).map((item) => ({
      value: item.id,
      label: item.free ? `${item.label} ✓免费` : item.label,
    }));
    const extra = models
      .filter((id) => !preset.some((option) => option.value === id))
      .slice(0, 60)
      .map((id) => ({ value: id, label: id }));
    const all = [...preset, ...extra];
    if (settings.ai.model && !all.some((option) => option.value === settings.ai.model)) {
      all.unshift({ value: settings.ai.model, label: settings.ai.model });
    }
    return all;
  }, [provider, models, settings.ai.model]);

  const sttModelOptions = useMemo(() => {
    const preset = (sttProvider?.sttModels ?? []).map((item) => ({
      value: item.id,
      label: item.free ? `${item.label} ✓免费` : item.label,
    }));
    const extra = models
      .filter((id) => !preset.some((option) => option.value === id))
      .filter((id) => /whisper|sensevoice|asr|speech|audio/i.test(id))
      .slice(0, 20)
      .map((id) => ({ value: id, label: id }));
    const all = [...preset, ...extra];
    if (settings.ai.sttModel && !all.some((option) => option.value === settings.ai.sttModel)) {
      all.unshift({ value: settings.ai.sttModel, label: settings.ai.sttModel });
    }
    return all;
  }, [sttProvider, models, settings.ai.sttModel]);

  const providerOptions = [
    ...DOMESTIC_PROVIDERS.map((item) => ({
      value: item.id,
      label: item.recommended ? `${item.label}（推荐）` : item.label,
    })),
    { value: CUSTOM_PROVIDER_ID, label: '自定义（仅限国内）' },
  ];

  const sttProviderOptions = [
    ...DOMESTIC_PROVIDERS.filter((item) => item.sttBaseURL).map((item) => ({
      value: item.id,
      label: item.recommended ? `${item.label}（推荐）` : item.label,
    })),
    { value: CUSTOM_PROVIDER_ID, label: '自定义（仅限国内）' },
  ];

  const urlCheck = checkDomesticURL(settings.ai.baseURL);
  const sttUrlCheck = checkDomesticURL(settings.ai.sttBaseURL);

  // ---- 顶部状态卡 --------------------------------------------------------
  /*
   * 「Key 不属于这家」要单独一档。
   *
   * 安全修复之后，切换服务商时旧 Key 会被主动扣下来不再发送。如果界面还写
   * 「还没有配置 API Key」，用户会以为自己白填了、反复重填同一把旧 Key。
   * 所以先判 mismatch，明确说清楚「它还在，但属于上一家」。
   */
  const statusTone = keyInfo?.unknown || keyInfo?.mismatch
    ? 'danger'
    : !keyInfo?.llm
      ? 'warn'
      : test?.ok
        ? 'ok'
        : test && !test.ok
          ? 'danger'
          : 'neutral';
  const statusTitle = keyInfo?.unknown
    ? '这把 Key 没有归属记录，已暂停使用'
    : keyInfo?.mismatch
      ? '换了服务商，已保存的 Key 属于上一家'
      : !keyInfo?.llm
        ? '还没有配置 API Key'
        : test?.ok
          ? test.title
          : test && !test.ok
            ? test.title
            : '已经填了 Key，点「测试连接」确认一下';
  const statusHint = keyInfo?.unknown
    ? '不确定这把 Key 原本属于哪台服务器（可能来自更早的版本）。为安全起见这次不会发送，请在下面重新粘贴一次。'
    : keyInfo?.mismatch
      ? '为了不把旧 Key 发给新的服务商，这次不会发送它。请在下面重新粘贴这家服务商的 Key。'
      : keyInfo?.ephemeral
        ? '系统加密不可用：Key 只保存在内存里，关掉软件后需要重新粘贴（不会再以明文写进磁盘）。'
        : test?.ok
          ? test.hint
          : test && !test.ok
            ? test.hint
            : '全程只用国内模型。填错任何一项都不用猜——测试连接会告诉你是哪一步。';

  return (
    <>
      <div
        data-ai-status={statusTone}
        className={`mb-3 rounded-xl border px-2.5 py-2 ${
          statusTone === 'ok'
            ? 'border-ok/25 bg-ok/[0.08]'
            : statusTone === 'danger'
              ? 'border-danger/25 bg-danger/[0.08]'
              : statusTone === 'warn'
                ? 'border-warn/25 bg-warn/[0.08]'
                : 'border-line-soft bg-ink-850'
        }`}
      >
        <div className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              statusTone === 'ok'
                ? 'bg-ok'
                : statusTone === 'danger'
                  ? 'bg-danger'
                  : statusTone === 'warn'
                    ? 'bg-warn'
                    : 'bg-white/40'
            }`}
          />
          <span className="text-[12px] font-medium text-white/90">{statusTitle}</span>
        </div>
        <p className="mt-1 text-[10.5px] leading-relaxed text-white/55">
          {statusHint}
        </p>
        {test?.endpoint && !test.ok && (
          <p className="mt-1 break-all font-mono text-[9.5px] text-white/30">{test.endpoint}</p>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button
            variant="primary"
            dataAttr="data-api-test"
            disabled={testing}
            onClick={() => void runTest()}
          >
            {testing ? '正在测试…' : '测试连接'}
          </Button>
          <Button dataAttr="data-tutorial-btn" onClick={() => void window.copilot.openDoc('tutorial')}>
            图文教程（新手必看）
          </Button>
        </div>
        <p className="mt-1.5 text-[10px] text-white/40">
          字幕状态：
          {keyInfo?.sttReady ? (
            <span className="text-ok/90/90">可用</span>
          ) : (
            <span className="text-warn/90/90">还缺语音识别的 Key，字幕无法生成</span>
          )}
        </p>
      </div>

      {error && (
        <div
          data-api-error
          className="mb-3 rounded-xl border border-danger/25 bg-danger/10 px-2.5 py-2 text-[11px] leading-relaxed text-danger"
        >
          {error}
        </div>
      )}

      {/* ① 选服务商 */}
      <Section title="第 1 步 · 选一家国内模型服务商">
        <Select
          value={settings.ai.provider}
          options={providerOptions}
          width="w-full"
          dataAttr="data-provider-select"
          onChange={(value) => void applyProvider(value)}
        />
        {provider ? (
          <>
            <p className="text-[11px] leading-relaxed text-white/55">{provider.blurb}</p>
            <p className="text-[10px] leading-relaxed text-ok/90/70">{provider.freeNote}</p>
            {provider.hint && (
              <p className="text-[10px] leading-relaxed text-warn/90/70">注意：{provider.hint}</p>
            )}
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              <Button
                variant="soft"
                dataAttr="data-key-guide-btn"
                onClick={() =>
                  void window.copilot.openDoc(
                    'tutorial',
                    provider ? `provider-${provider.id}` : undefined,
                  )
                }
              >
                怎么申请 Key？
              </Button>
            </div>
          </>
        ) : (
          <p className="text-[10.5px] leading-relaxed text-white/45">
            自定义模式：只允许填国内地址（域名以 .cn 结尾，或本机 localhost）。
          </p>
        )}
      </Section>

      {/* ② 填 Key */}
      <Section
        title="第 2 步 · 粘贴 API Key"
        aside={
          keyInfo?.llm ? (
            <span data-key-saved className="text-[10px] text-ok/90/80">
              已保存
            </span>
          ) : (
            <span className="text-[10px] text-white/30">未保存</span>
          )
        }
      >
        <div className="flex items-center gap-1.5">
          <input
            type="password"
            value={llmKey}
            onChange={(event) => {
              setLlmKey(event.target.value);
              setLlmKeySaved(false);
            }}
            placeholder="粘贴 Key（sk- 开头的一长串）"
            className="no-drag min-w-0 flex-1 rounded-lg border border-line-soft bg-ink-800 px-2 py-1 text-[11px] text-white/90 placeholder:text-white/25 focus:border-accent/50 focus:outline-none"
          />
          <Button variant="soft" onClick={() => void saveLlmKey()} disabled={!llmKey.trim()}>
            {llmKeySaved ? '已保存' : '保存'}
          </Button>
        </div>
        <Hint>
          Key 用 Windows 系统加密（DPAPI）存在你这台电脑上，不会上传、不会同步。
          换电脑或重装系统后需要重新填。
        </Hint>
      </Section>

      {/* ③ 选模型 */}
      <Section
        title="第 3 步 · 选模型"
        aside={
          <button
            onClick={() => void refreshModelList()}
            disabled={loadingModels}
            className="no-drag text-[10px] text-accent-soft/80 hover:text-accent-soft disabled:opacity-40"
          >
            {loadingModels ? '读取中…' : '刷新可用模型'}
          </button>
        }
      >
        <Select
          value={settings.ai.model}
          options={modelOptions.length ? modelOptions : [{ value: '', label: '（先选服务商）' }]}
          width="w-full"
          dataAttr="data-model-select"
          onChange={(value) => void guard(() => update({ ai: { ...settings.ai, model: value } }))}
        />
        <Hint>
          带「免费」字样的模型不花钱，先拿它试；觉得反应慢再换成付费的大模型。
        </Hint>
      </Section>

      {/* ④ 语音识别 */}
      <Section title="语音识别（字幕靠它）">
        {sttSameAsLlm ? (
          <p className="text-[10.5px] leading-relaxed text-white/50">
            现在和文字模型是同一家（{sttProvider?.label ?? settings.ai.sttBaseURL}），
            自动共用上面那一个 Key，不用再填一次。
          </p>
        ) : (
          <>
            <Row label="识别服务商">
              <Select
                value={settings.ai.sttProvider}
                options={sttProviderOptions}
                onChange={(value) => void applySttProvider(value)}
              />
            </Row>
            <Row label="识别模型">
              <Select
                value={settings.ai.sttModel}
                options={sttModelOptions.length ? sttModelOptions : [{ value: '', label: '（先选服务商）' }]}
                onChange={(value) =>
                  void guard(() => update({ ai: { ...settings.ai, sttModel: value } }))
                }
              />
            </Row>
            <div className="flex items-center gap-1.5">
              <input
                type="password"
                value={sttKey}
                onChange={(event) => {
                  setSttKey(event.target.value);
                  setSttKeySaved(false);
                }}
                placeholder="语音识别的 Key（和上面不是同一家时才需要）"
                className="no-drag min-w-0 flex-1 rounded-lg border border-line-soft bg-ink-800 px-2 py-1 text-[11px] text-white/90 placeholder:text-white/25 focus:border-accent/50 focus:outline-none"
              />
              <Button variant="soft" onClick={() => void saveSttKey()} disabled={!sttKey.trim()}>
                {sttKeySaved ? '已保存' : '保存'}
              </Button>
            </div>
          </>
        )}

        {!keyInfo?.sttReady && (
          <div className="mt-1 rounded-lg border border-warn/20 bg-warn/[0.08] px-2 py-1.5">
            <p className="text-[10.5px] leading-relaxed text-warn/85">
              {sttSameAsLlm
                ? '声音能听到（音量条会动），但还没填 API Key，所以字幕暂时生成不了。把上面的 Key 填上就好了。'
                : '现在没有能用的语音识别 Key，字幕生成不了（声音还是能听到，音量条会动）。'}
            </p>
            {!sttSameAsLlm && (
              <div className="mt-1.5">
                <Button variant="primary" onClick={() => void useRecommendedStt()}>
                  用 {recommendedProvider().label} 做语音识别（免费）
                </Button>
              </div>
            )}
          </div>
        )}

        {!!notice && <p className="text-[10px] leading-relaxed text-warn/90/80">{notice}</p>}
      </Section>

      {/* ⑤ 没有 Key 也能玩 */}
      <Section title="没有 Key 也能先体验">
        <Toggle
          label="演示模式（不连模型、不出字幕）"
          value={settings.mockMode}
          onChange={(value) => void guard(() => update({ mockMode: value }))}
          hint="只播放内置示例对话，用来预览界面。要看电影 / 网课的声音，请关掉它。"
        />
        <Toggle
          label="自动播放示例对话"
          value={settings.demoAutoPlay}
          onChange={(value) => void guard(() => update({ demoAutoPlay: value }))}
        />
      </Section>

      {/* ⑥ 高级 */}
      <Section
        title="高级设置"
        aside={
          <button
            onClick={() => setShowAdvanced((value) => !value)}
            className="no-drag text-[10px] text-white/45 hover:text-white/80"
          >
            {showAdvanced ? '收起' : '展开'}
          </button>
        }
      >
        {showAdvanced ? (
          <>
            <p className="text-[10px] leading-relaxed text-white/35">
              如果你有公司内部的国内网关，或者想微调，可以在这里改。改完必须点右边的「保存」，
              软件会立刻校验是不是国内地址。
            </p>
            <Row label="接口地址">
              <div className="flex items-center gap-1">
                <input
                  value={urlDraft}
                  onChange={(event) => setUrlDraft(event.target.value)}
                  className="no-drag w-[190px] rounded-md border border-line-soft bg-ink-800 px-2 py-1 text-[10.5px] text-white/90 focus:border-accent/50 focus:outline-none"
                />
                <Button
                  variant="soft"
                  onClick={() =>
                    void guard(async () => {
                      await update({ ai: { ...settings.ai, baseURL: urlDraft } });
                      setNotice('接口地址已保存。');
                    })
                  }
                >
                  保存
                </Button>
              </div>
            </Row>
            {!urlCheck.ok && (
              <p data-url-error className="text-[10px] leading-relaxed text-danger/85/90">
                {urlCheck.reason}
              </p>
            )}
            {/*
              本机服务要「明确标识」。
              公网地址一律强制 https，只有 localhost / 内网允许 http ——
              但用户必须知道自己现在连的是本机：这种配置换台电脑就失效，
              而且它和「网上某家服务商」在安全含义上完全不同。
            */}
            {urlCheck.ok && urlCheck.local && (
              <p data-local-endpoint className="text-[10px] leading-relaxed text-warn/80">
                本机服务（{urlCheck.host}）：只在这台电脑内部通信，不会走出网卡。
                这种地址没有 HTTPS 证书也能用，但换一台电脑就要改成那台电脑的地址。
              </p>
            )}
            <Row label="语音识别地址">
              <div className="flex items-center gap-1">
                <input
                  value={sttUrlDraft}
                  onChange={(event) => setSttUrlDraft(event.target.value)}
                  className="no-drag w-[190px] rounded-md border border-line-soft bg-ink-800 px-2 py-1 text-[10.5px] text-white/90 focus:border-accent/50 focus:outline-none"
                />
                <Button
                  variant="soft"
                  onClick={() =>
                    void guard(async () => {
                      await update({ ai: { ...settings.ai, sttBaseURL: sttUrlDraft } });
                      setNotice('语音识别地址已保存。');
                    })
                  }
                >
                  保存
                </Button>
              </div>
            </Row>
            {!sttUrlCheck.ok && (
              <p className="text-[10px] leading-relaxed text-danger/85/90">{sttUrlCheck.reason}</p>
            )}
            <Row label="朗读方式">
              <Select
                value={settings.ai.ttsProvider}
                options={[
                  { value: 'web-speech', label: '系统语音（免费）' },
                  { value: 'openai', label: '云端 TTS（需国内支持）' },
                ]}
                onChange={(value) =>
                  void guard(() =>
                    update({
                      ai: { ...settings.ai, ttsProvider: value as 'web-speech' | 'openai' },
                    }),
                  )
                }
              />
            </Row>
            <Row label={`朗读速度 ${settings.ai.ttsSpeed.toFixed(1)}x`}>
              <input
                type="range"
                min={0.7}
                max={1.2}
                step={0.1}
                value={settings.ai.ttsSpeed}
                onChange={(event) =>
                  void guard(() =>
                    update({ ai: { ...settings.ai, ttsSpeed: Number(event.target.value) } }),
                  )
                }
                className="no-drag w-28 accent-accent"
              />
            </Row>
          </>
        ) : (
          <p className="text-[10px] leading-relaxed text-white/35">
            当前地址：<span className="font-mono text-white/50">{settings.ai.baseURL}</span>
          </p>
        )}
      </Section>
    </>
  );
}
