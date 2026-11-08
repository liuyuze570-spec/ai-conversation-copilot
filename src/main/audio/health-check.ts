import type { HealthItem, HealthReport } from '../../shared/health';
import { keyInfo, testAIConnection } from '../ai-service';
import { getSettingsStore } from '../settings-store';
import { probeAudio, pythonAvailability, resetPythonDiscovery } from './python-engine';

/**
 * 「推理型」模型的识别正则（与 settings-store 里那次自动换模型用的是同一组关键词）。
 * 这类模型一版回复要 10 秒以上，对「3 秒内把话说出口」来说是直接报废。
 */
const SLOW_MODEL = /qwen3|qwq|glm-z1|hunyuan-t1|deepseek-r1|reasoner/i;

/**
 * 一键体检：把「为什么没有字幕 / 为什么回复很慢」拆成一条条能查的东西。
 *
 * 顺序是照用户实际会遇到的顺序排的：音频组件 → 设备 → 有没有声音 → Key → 模型。
 * 前面的坏了，后面的就不用看了。
 *
 * 刻意**不**检查系统音量 / 静音：实测 WASAPI 回环的取样点在端点音量之前，
 * 「电脑静音」完全不影响采集。把它列成检查项只会让用户去修一个没坏的东西。
 */
export async function runSystemCheck(): Promise<HealthReport> {
  const settings = getSettingsStore().get();
  const items: HealthItem[] = [];

  // ---- 1. 演示模式：听不到电脑的声音，这是最常见的一句误解 ----------------
  if (settings.mockMode) {
    items.push({
      id: 'mock',
      level: 'warn',
      title: '当前是演示模式，听到的是内置示例',
      detail: '演示模式只播内置对话，不采集扬声器，所以任何软件的声音都进不来。',
      fix: '点「开始监听系统声音」，或到设置里关掉演示模式。',
    });
  }

  // ---- 2. 采集开关 -------------------------------------------------------
  if (!settings.audio.captureSystemAudio) {
    items.push({
      id: 'capture',
      level: 'warn',
      title: '「捕获系统声音」是关着的',
      detail: '这样只会听麦克风，对方的声音不会进来。',
      fix: '设置 → 音频 → 打开「捕获系统声音（对方）」。',
    });
  }

  // ---- 3. 音频组件 + 设备 + 有没有声音 -----------------------------------
  // 演示模式不走 Python 采集，查了只会平白多报一条「组件没起来」。
  if (!settings.mockMode) {
    resetPythonDiscovery();
    const python = pythonAvailability();
    if (!python.available) {
      items.push({
        id: 'python',
        level: 'fail',
        title: '音频组件没有起来',
        detail: '软件自带的音频运行环境没找到，常见于被杀毒软件拦截或安装不完整。',
        fix: '重新安装本软件；或在 设置 → 音频 里手动指定 python.exe 的路径。',
      });
    } else {
      items.push({ id: 'python', level: 'ok', title: '音频组件正常' });

      const probe = await probeAudio('loopback', 2.5);
      if (!probe.ok) {
        items.push({
          id: 'device',
          level: 'fail',
          title: '打不开默认扬声器',
          detail: probe.message || '设备可能被别的软件独占，或驱动异常。',
          fix: '换一个输出设备后在 设置 → 音频 里指定，再重新诊断。',
        });
      } else {
        items.push({
          id: 'device',
          level: 'ok',
          title: probe.device ? `扬声器可用：${probe.device}` : '扬声器可用',
        });
        if (probe.rate > 0 && probe.rate < 16000) {
          items.push({
            id: 'rate',
            level: 'warn',
            title: `采样率偏低（${probe.rate}Hz）`,
            detail: '识别模型按 16kHz 工作，采样率太低会让字变得含糊。',
            fix: '在 Windows 声音设置里把默认扬声器改成 16kHz 或以上。',
          });
        }
        if (!probe.hasSignal) {
          items.push({
            id: 'signal',
            level: 'warn',
            title: '这 2.5 秒里没有听到声音',
            detail: '设备已经打开，但采到的是一片安静 —— 要么没东西在放，要么送错了设备。',
            fix:
              '确认视频正在播放、播放软件自己没被静音、它的输出设备和系统默认一致。' +
              '（系统静音不影响采集，不用管那个旋钮。）',
          });
        } else {
          items.push({ id: 'signal', level: 'ok', title: '能听到声音' });
        }
      }
    }
  }

  // ---- 4. Key -----------------------------------------------------------
  const keys = keyInfo();
  if (!keys.sttReady) {
    items.push({
      id: 'stt-key',
      level: 'fail',
      title: '没有可用的语音识别 Key',
      detail: '没有它就只能听到声音、出不了字幕。',
      fix: '设置 → API 功能 → 填一个识别 Key（跟着新手教程走，全程免费）。',
    });
  } else {
    items.push({ id: 'stt-key', level: 'ok', title: '识别 Key 已配置' });
  }
  if (!keys.llm) {
    items.push({
      id: 'llm-key',
      level: 'fail',
      title: '没有可用的文字模型 Key',
      detail: '翻译和「帮我回复」都靠它。',
      fix: '设置 → API 功能 → 填一个文字模型 Key。',
    });
  } else {
    items.push({ id: 'llm-key', level: 'ok', title: '文字模型 Key 已配置' });
  }

  // ---- 5. 真的发一次请求：Key 存在 ≠ Key 能用 -----------------------------
  //
  // 这一条是整套体检里最值钱的：本机实测遇到过「Key 填了、设备也正常，但服务商
  // 账户余额不足」—— 采集、切句、识别全都在跑，就是一句字幕都出不来。光看配置
  // 永远发现不了，只能真打一次。
  if (keys.llm) {
    const result = await Promise.race([
      testAIConnection(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
    ]).catch(() => null);

    if (result === null) {
      items.push({
        id: 'api',
        level: 'warn',
        title: '模型 12 秒没有响应',
        detail: '地址和 Key 都在，但请求超时了 —— 可能是网络，也可能是服务商在排队。',
        fix: '过一会儿再点一次诊断；一直超时就换一家服务商。',
      });
    } else if (!result.ok) {
      items.push({
        id: 'api',
        level: 'fail',
        title: result.title,
        detail: `${result.hint}（字幕和回复用的是同一个账户，所以会一起失败。）`,
        fix: '去服务商控制台确认余额 / 额度，或者换一个带「免费」字样的模型。',
      });
    } else {
      items.push({
        id: 'api',
        level: 'ok',
        title: `模型可用：${result.model}（${result.latencyMs ?? 0} 毫秒）`,
      });
    }
  }

  // ---- 6. 模型是否适合实时 ----------------------------------------------
  if (SLOW_MODEL.test(settings.ai.model || '')) {
    items.push({
      id: 'model',
      level: 'warn',
      title: `现在的模型「${settings.ai.model}」是推理型，出话很慢`,
      detail: '这类模型实测一版回复要 10 秒以上，接话时对方早就等不下去了。',
      fix: '设置 → API 功能 → 换一个不带 R1 / Qwen3 字样的普通模型。',
    });
  }

  return { checkedAt: Date.now(), items };
}
