/**
 * 国内大模型服务商预设目录 + 「只允许国内接口」的校验规则。
 *
 * 为什么单独抽一个文件：
 * 1. 新手根本不知道该往「Base URL」里填什么，也记不住模型名。这里把
 *    国内主流服务商的地址、可用模型、申请 Key 的入口都固化下来，一键填充。
 * 2. 产品要求只允许连接国内服务商（国内直连、无需代理、连接更稳定，
 *    也避免把音频/对话内容发到境外）。
 * 3. 主进程与渲染层都要用到同一套规则，所以放在 shared。
 */

export interface ProviderModel {
  /** 接口里真正要填的 model 名字。 */
  id: string;
  /** 界面上显示的名字。 */
  label: string;
  /** 是否免费（或长期有大额免费额度）。 */
  free?: boolean;
  note?: string;
}

export interface DomesticProvider {
  id: string;
  /** 厂商名。 */
  label: string;
  /** 一句话介绍，给完全不懂的人看。 */
  blurb: string;
  llmBaseURL: string;
  llmModels: ProviderModel[];
  /** 语音识别（字幕靠它）。没有就说明这家只做文字，需要另配 STT。 */
  sttBaseURL?: string;
  sttModels?: ProviderModel[];
  /** 申请 Key 的页面。 */
  keyURL: string;
  /** 官网 / 注册页。 */
  signupURL: string;
  /** 免费额度说明。 */
  freeNote: string;
  /** 特殊注意事项（例如要填接入点 ID、Key 是两段拼起来的）。 */
  hint?: string;
  /** 首推服务商。 */
  recommended?: boolean;
}

/**
 * 国内服务商目录。
 *
 * 选择标准：原生兼容 OpenAI 的 /chat/completions 协议（这样一套代码通吃），
 * 并且国内直连可达。按「新手友好度 / 免费额度」排序。
 */
export const DOMESTIC_PROVIDERS: DomesticProvider[] = [
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    blurb: '一站式国产模型超市，小模型长期免费，还能做语音识别——一个 Key 就够用。',
    llmBaseURL: 'https://api.siliconflow.cn/v1',
    llmModels: [
      { id: 'Qwen/Qwen2.5-7B-Instruct', label: 'Qwen2.5-7B（免费 · 接话最快）', free: true },
      { id: 'THUDM/GLM-4-9B-0414', label: 'GLM-4-9B（免费 · 中文稳）', free: true },
      { id: 'Qwen/Qwen3-8B', label: 'Qwen3-8B（免费 · 推理型，稍慢）', free: true },
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek-V3（付费，很便宜）', free: false },
    ],
    sttBaseURL: 'https://api.siliconflow.cn/v1',
    sttModels: [
      { id: 'FunAudioLLM/SenseVoiceSmall', label: 'SenseVoice 小模型（免费）', free: true },
      { id: 'whisper-large-v3', label: 'Whisper large-v3（付费）', free: false },
    ],
    keyURL: 'https://cloud.siliconflow.cn/account/ak',
    signupURL: 'https://cloud.siliconflow.cn/',
    freeNote: '注册送额金，9B 以下小模型长期免费；本软件的「对话」和「语音识别」都能用。',
    recommended: true,
  },
  {
    id: 'modelscope',
    label: '魔搭 ModelScope（阿里）',
    blurb: '阿里旗下，每天有免费调用额度，适合完全不想花钱的人。',
    llmBaseURL: 'https://api-inference.modelscope.cn/v1',
    llmModels: [
      { id: 'Qwen/Qwen2.5-7B-Instruct', label: 'Qwen2.5-7B（免费额度）', free: true },
      { id: 'Qwen/Qwen3-8B', label: 'Qwen3-8B（免费额度 · 推理型，稍慢）', free: true },
    ],
    sttBaseURL: 'https://api-inference.modelscope.cn/v1',
    sttModels: [
      { id: 'iic/SenseVoiceSmall', label: 'SenseVoice 小模型（免费额度）', free: true },
    ],
    keyURL: 'https://modelscope.cn/my/myaccesstoken',
    signupURL: 'https://modelscope.cn/',
    freeNote: '每天刷新免费调用次数，用不完。Key 在「访问令牌」页面里拿。',
  },
  {
    id: 'zhipu',
    label: '智谱 AI GLM',
    blurb: '中文本事好，glm-4-flash 完全免费，注册最简单。',
    llmBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
    llmModels: [
      { id: 'glm-4-flash', label: 'glm-4-flash（免费 · 接话最快）', free: true },
      { id: 'glm-4.7-flash', label: 'glm-4.7-flash（免费 · 更聪明）', free: true },
      { id: 'glm-4-flashx', label: 'glm-4-flashx（便宜）', free: false },
      { id: 'glm-4-air', label: 'glm-4-air', free: false },
      { id: 'glm-4-plus', label: 'glm-4-plus', free: false },
    ],
    keyURL: 'https://open.bigmodel.cn/usercenter/apikeys',
    signupURL: 'https://open.bigmodel.cn/',
    freeNote: 'glm-4-flash 免费。注意：这家只做文字，字幕需要的语音识别要另配（选硅基流动）。',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    blurb: '长文本强，界面友好，适合阅读和长对话。',
    llmBaseURL: 'https://api.moonshot.cn/v1',
    llmModels: [
      { id: 'moonshot-v1-8k', label: 'moonshot-v1-8k', free: false },
      { id: 'moonshot-v1-32k', label: 'moonshot-v1-32k', free: false },
      { id: 'kimi-latest', label: 'kimi-latest', free: false },
    ],
    keyURL: 'https://platform.moonshot.cn/console/api-keys',
    signupURL: 'https://platform.moonshot.cn/',
    freeNote: '新账号有赠送额度。这家也只做文字，语音识别要另配。',
  },
  {
    id: 'deepseek',
    label: '深度求索 DeepSeek',
    blurb: '性价比高、推理强，中文回答自然。',
    llmBaseURL: 'https://api.deepseek.com/v1',
    llmModels: [
      { id: 'deepseek-chat', label: 'deepseek-chat', free: false },
      { id: 'deepseek-reasoner', label: 'deepseek-reasoner（推理更强）', free: false },
    ],
    keyURL: 'https://platform.deepseek.com/api_keys',
    signupURL: 'https://platform.deepseek.com/',
    freeNote: '充值后按量计费，很便宜。这家只做文字，语音识别要另配。',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（通义千问）',
    blurb: '阿里官方，模型全、稳定，有免费额度，也支持语音识别。',
    llmBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    llmModels: [
      { id: 'qwen-turbo', label: 'qwen-turbo（有免费额度）', free: true },
      { id: 'qwen-flash', label: 'qwen-flash（便宜）', free: true },
      { id: 'qwen-plus', label: 'qwen-plus', free: false },
      { id: 'qwen-max', label: 'qwen-max', free: false },
    ],
    sttBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    sttModels: [
      { id: 'qwen3-asr-flash', label: 'qwen3-asr-flash（有免费额度）', free: true },
    ],
    keyURL: 'https://bailian.console.aliyun.com/?apiKey=1',
    signupURL: 'https://bailian.console.aliyun.com/',
    freeNote: '开通后每个模型都有免费额度，用完才计费。',
  },
  {
    id: 'hunyuan',
    label: '腾讯混元',
    blurb: '腾讯官方接口，国内直连稳定。',
    llmBaseURL: 'https://api.hunyuan.cloud.tencent.com/v1',
    llmModels: [
      { id: 'hunyuan-turbos-latest', label: 'hunyuan-turbos-latest（快）', free: false },
      { id: 'hunyuan-lite', label: 'hunyuan-lite（免费）', free: true },
    ],
    keyURL: 'https://console.cloud.tencent.com/hunyuan/api-key',
    signupURL: 'https://console.cloud.tencent.com/hunyuan',
    freeNote: 'hunyuan-lite 免费。这家只做文字，语音识别要另配。',
  },
  {
    id: 'volces',
    label: '火山方舟（豆包）',
    blurb: '字节跳动的豆包模型，速度快。',
    llmBaseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    llmModels: [
      { id: 'doubao-seed-1-6-flash-250715', label: '豆包 Seed 1.6 Flash', free: false },
      { id: 'doubao-pro-32k', label: '豆包 Pro 32k', free: false },
    ],
    keyURL: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    signupURL: 'https://console.volcengine.com/ark',
    freeNote: '新用户每个模型有免费额度。',
    hint: '火山方舟需要先在控制台创建「接入点」，把 ep- 开头的接入点 ID 填到模型名里。',
  },
  {
    id: 'stepfun',
    label: '阶跃星辰 StepFun',
    blurb: '国产新锐，接口兼容 OpenAI。',
    llmBaseURL: 'https://api.stepfun.com/v1',
    llmModels: [
      { id: 'step-1-flash', label: 'step-1-flash（便宜）', free: false },
      { id: 'step-2-mini', label: 'step-2-mini', free: false },
    ],
    keyURL: 'https://platform.stepfun.com/interface-key',
    signupURL: 'https://platform.stepfun.com/',
    freeNote: '注册有赠送额度。这家只做文字，语音识别要另配。',
  },
];

/** 「自定义」——用户可以填自己的国内网关，但仍然必须通过下面的域名校验。 */
export const CUSTOM_PROVIDER_ID = 'custom';

export function findProvider(id: string): DomesticProvider | undefined {
  return DOMESTIC_PROVIDERS.find((item) => item.id === id);
}

/** 推荐给新手的默认服务商。 */
export function recommendedProvider(): DomesticProvider {
  return DOMESTIC_PROVIDERS.find((item) => item.recommended) ?? DOMESTIC_PROVIDERS[0];
}

/** 所有「能顺便做语音识别」的服务商。 */
export function providersWithStt(): DomesticProvider[] {
  return DOMESTIC_PROVIDERS.filter((item) => Boolean(item.sttBaseURL && item.sttModels?.length));
}

/**
 * 国内域名白名单（后缀匹配）。
 *
 * 规则：host === 后缀 或 host.endsWith('.' + 后缀)。
 * 只要是 .cn / .com.cn 结尾的域名也会被放行（国内备案域名的兜底）。
 */
const DOMESTIC_HOST_SUFFIXES = [
  // 模型服务商
  'siliconflow.cn',
  'siliconflow.com',
  'modelscope.cn',
  'bigmodel.cn',
  'zhipuai.cn',
  'z.ai',
  'moonshot.cn',
  'kimi.com',
  'deepseek.com',
  'aliyuncs.com',
  'aliyun.com',
  'baidubce.com',
  'baidu.com',
  'xf-yun.com',
  'xfyun.cn',
  'tencentcloudapi.com',
  'tencentcloud.com',
  'hunyuan.cloud.tencent.com',
  'volces.com',
  'volcengine.com',
  'volcengineapi.com',
  'lingyiwanwu.com',
  'minimaxi.com',
  'minimax.chat',
  'stepfun.com',
  'baichuan-ai.com',
  'sensenova.cn',
  'infini-ai.com',
  'shanghai-ai.com',
  // 常见国内云厂商网关
  'qcloud.com',
  'huaweicloud.com',
  'myhuaweicloud.com',
];

/** 明确要拦掉的境外服务商（给出更具体的提示语）。 */
const FOREIGN_HOST_SUFFIXES = [
  'openai.com',
  'openai.azure.com',
  'anthropic.com',
  'claude.ai',
  'groq.com',
  'googleapis.com',
  'google.com',
  'generativelanguage.googleapis.com',
  'mistral.ai',
  'cohere.ai',
  'cohere.com',
  'together.xyz',
  'together.ai',
  'fireworks.ai',
  'openrouter.ai',
  'perplexity.ai',
  'x.ai',
  'azure.com',
  'aws.amazon.com',
  'amazonaws.com',
  'huggingface.co',
  'replicate.com',
  'voyageai.com',
  'deepinfra.com',
  'anyscale.com',
  'lepton.ai',
  'nvidia.com',
  'github.com',
  'openai.com.cn',
];

export interface UrlCheckResult {
  ok: boolean;
  /** 解析出来的 host（小写，去掉端口）。解析失败时为空串。 */
  host: string;
  /** 不通过时的中文原因。 */
  reason?: string;
  /** 是否是一个「本地地址」（localhost / 内网），本地永远放行。 */
  local?: boolean;
  /**
   * 这次不通过**仅仅**是因为用了 http 明文。
   *
   * 单独标出来，是为了让迁移逻辑能「把 http 改成 https 就好」，而不是像
   * 别的失败那样直接把用户的服务商整个换掉 —— 换服务商等于把 Key 也一起废了。
   */
  insecure?: boolean;
}

function matchSuffix(host: string, suffixes: string[]): string | null {
  for (const suffix of suffixes) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return suffix;
  }
  return null;
}

/** `https://a.b/c` → 'https'；没写协议时视为 https（normalizeBaseURL 会补）；写错返回 null。 */
function schemeOf(raw: string): 'http' | 'https' | null {
  const value = (raw || '').trim();
  if (!value) return null;
  const match = value.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (!match) return 'https';
  const scheme = match[1].toLowerCase();
  if (scheme === 'http') return 'http';
  if (scheme === 'https') return 'https';
  return null;
}

function isLocalHost(host: string): boolean {
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') {
    return true;
  }
  if (host.endsWith('.local') || host.endsWith('.localhost')) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

function hostOf(raw: string): string {
  let value = (raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 校验一个接口地址是否允许使用（只允许国内 / 本地）。
 * 渲染层用它给出即时提示，主进程用它做最终把关。
 */
export function checkDomesticURL(raw: string): UrlCheckResult {
  const value = (raw || '').trim();
  if (!value) {
    return { ok: false, host: '', reason: '还没有填接口地址' };
  }
  const host = hostOf(value);
  if (!host) {
    return { ok: false, host: '', reason: '这个地址看不懂，请像这样填：https://api.siliconflow.cn/v1' };
  }
  const local = isLocalHost(host);
  const scheme = schemeOf(value);
  if (!scheme) {
    return { ok: false, host, reason: '只支持 http:// 或 https:// 开头的地址。' };
  }
  // 本机 / 内网：允许 http（本机不给别人发包，明文没有链路风险；而且很多
  // 本地推理服务（Ollama、自家网关）默认就没有证书）。
  if (local) {
    return { ok: true, host, local: true };
  }
  /*
   * 公网一律强制 https。
   *
   * Authorization 头里是明文的 API Key，http 下沿途任何一个环节（公共 WiFi、
   * 公司网关、运营商缓存）都能直接看到并复用。这类事故不会报错，用户永远
   * 不会知道 —— 所以只能在这里硬拦，并且给一句能自己动手改的提示。
   */
  if (scheme === 'http') {
    return {
      ok: false,
      host,
      insecure: true,
      reason:
        `${host} 用的是 http 明文连接，API Key 和对话内容会以明文经过网络，` +
        '可能被中途窃听。请把开头改成 https://。' +
        '（如果这是你自己电脑上的服务，请改用「本机服务」选项。）',
    };
  }
  if (matchSuffix(host, FOREIGN_HOST_SUFFIXES)) {
    return {
      ok: false,
      host,
      reason: `${host} 是国外接口，本软件只允许连接国内模型服务商。请在上面的列表里选一家（推荐硅基流动）。`,
    };
  }
  if (matchSuffix(host, DOMESTIC_HOST_SUFFIXES)) {
    return { ok: true, host };
  }
  if (host.endsWith('.cn') || host.endsWith('.com.cn')) {
    return { ok: true, host };
  }
  return {
    ok: false,
    host,
    reason: `暂时无法确认 ${host} 是国内服务商。为了保证在国内能连得上、连得稳，只允许国内接口；如果你的地址确实是国内的，请选「自定义」并确认域名以 .cn 结尾。`,
  };
}

/**
 * 把「只是用了 http 的公网地址」升级成 https，别的一律原样返回。
 *
 * 给设置迁移用：老用户存的是 `http://api.xxx.cn/v1`，直接判失败会把他的
 * 服务商和模型一起换掉（连带 Key 失效）。改成 https 才是他真正想要的。
 */
export function enforceHttps(raw: string): string {
  const value = (raw || '').trim();
  if (!schemeOf(value) || schemeOf(value) !== 'http') return raw;
  const host = hostOf(value);
  if (!host || isLocalHost(host)) return raw;
  return value.replace(/^http:\/\//i, 'https://');
}

export function isDomesticURL(raw: string): boolean {
  return checkDomesticURL(raw).ok;
}

/**
 * 把用户随手填的地址整理成能直接用的 Base URL。
 *
 * - 没写 http(s):// 就补上
 * - 去掉末尾的斜杠
 * - 只填了域名（没有路径）时补上 /v1 —— 绝大多数网关都要这一段，
 *   新手漏掉它就会 404。
 */
export function normalizeBaseURL(raw: string, fallbackPath = '/v1'): string {
  let value = (raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const match = value.match(/^(https?:\/\/[^/?#]+)([^?#]*)/i);
  if (!match) return value.replace(/\/+$/, '');
  const origin = match[1];
  let pathname = (match[2] ?? '').replace(/\/+$/, '');
  if (!pathname || pathname === '/') pathname = fallbackPath;
  return `${origin}${pathname}`;
}

/** 两个地址是否指向同一台服务器（用同一把 Key 就够了）。 */
export function sameHost(a: string, b: string): boolean {
  const hostA = hostOf(a);
  const hostB = hostOf(b);
  return Boolean(hostA) && hostA === hostB;
}
