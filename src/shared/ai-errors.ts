/**
 * 把各种网络 / 接口错误翻译成「新手看得懂」的中文。
 *
 * 原来用户看到的是一行 `LLM_HTTP_401: {"error":...}`，等于没说。
 * 现在统一转成「哪里错了 + 怎么办」。
 */

export interface AiErrorInfo {
  /** 机器可读的分类，用于界面上的图标 / 颜色。 */
  code:
    | 'no-key'
    | 'timeout'
    | 'network'
    | 'auth'
    | 'not-found'
    | 'bad-request'
    | 'payment'
    | 'rate-limit'
    | 'server'
    | 'empty'
    | 'blocked'
    | 'unknown';
  /** 一句话说清是什么问题。 */
  title: string;
  /** 怎么解决。 */
  hint: string;
  /** 原始错误文本（折叠显示，方便排查）。 */
  raw: string;
}

function rawOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export function describeAiError(error: unknown): AiErrorInfo {
  const raw = rawOf(error);
  const upper = raw.toUpperCase();

  const statusMatch = upper.match(/(?:LLM_HTTP_|STT_HTTP_|HTTP_)\s*(\d{3})/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;

  const make = (code: AiErrorInfo['code'], title: string, hint: string): AiErrorInfo => ({
    code,
    title,
    hint,
    raw,
  });

  if (upper.includes('MISSING_API_KEY') || upper.includes('NO_API_KEY')) {
    return make('no-key', '还没有填 API Key', '打开「设置 → API 功能」，选一家国内服务商，把 Key 粘贴进去再保存。');
  }

  if (upper.includes('TIMEOUT') || upper.includes('ABORT')) {
    return make(
      'timeout',
      '等太久没反应（网络超时）',
      '检查电脑能不能上网；如果开了代理，先把代理关掉试试——国内接口直连更快。',
    );
  }

  if (upper.includes('FOREIGN_ENDPOINT')) {
    return make('blocked', '这个接口不是国内的', '本软件只允许连接国内模型服务商，请在「API 功能」里从列表中选择一家。');
  }

  if (upper.includes('FETCH FAILED') || upper.includes('ECONNREFUSED') || upper.includes('ENOTFOUND') || upper.includes('NETWORK')) {
    return make(
      'network',
      '连不上服务器',
      '先确认电脑能上网；再检查「接口地址」有没有打错（多一个字母都会连不上）；如果开着 VPN / 代理，请关掉。',
    );
  }

  if (status === 401 || status === 403) {
    return make(
      'auth',
      'Key 不对，或者这个 Key 没有权限',
      '最可能的原因：Key 复制时漏了字符、Key 和「接口地址」不是同一家（比如拿着智谱的 Key 去连硅基流动）。重新复制一次 Key 再试。',
    );
  }
  if (status === 402) {
    return make('payment', '账户余额不足', '去服务商官网看一下余额，或者换一个免费模型（模型名里带「免费」的那种）。');
  }
  if (status === 404) {
    return make(
      'not-found',
      '接口地址或模型名不对（404）',
      '检查两处：①「接口地址」必须是服务商给的那个（例如 https://api.siliconflow.cn/v1）；②「模型」要从下拉列表里选，不要手打。',
    );
  }
  if (status === 400 || status === 422) {
    return make(
      'bad-request',
      '服务商不接受这次请求（400）',
      '绝大多数情况是「模型名」写错了。请在下拉列表里重新选一个模型再试。',
    );
  }
  if (status === 429) {
    return make(
      'rate-limit',
      '请求太快了，或者免费额度用完了',
      '等一分钟再试；如果一直这样，说明免费额度到期了，可以换一家（例如硅基流动 / 魔搭 / 智谱 glm-4-flash）。',
    );
  }
  if (status >= 500) {
    return make(
      'server',
      '服务商那边暂时不稳定（' + status + '）',
      '已经自动重试过了。等几分钟再试；如果一直失败，换一家服务商试试。',
    );
  }

  if (upper.includes('LLM_EMPTY_RESPONSE') || upper.includes('EMPTY_RESPONSE')) {
    return make('empty', '服务商返回了空内容', '换一个模型试试；有些小模型不太会按格式回答。');
  }

  // 忠实转译时，模型把金额 / 日期 / 币种说错了（例如把「不是540」写成 540、
  // 把「周五」写成 Thursday）。这些卡字系正确、事实却错了，整批被拦下。
  if (upper.includes('LLM_UNFAITHFUL')) {
    return make(
      'bad-request',
      '这次翻译把金额或日期说错了',
      '已自动拦下，不会把错的信息给你。点「重试」再生成一次；如果反复出现，说明这个模型对小金额/日期不太稳，换一个模型试试。',
    );
  }

  // 模型回来的不是合法 JSON（免费小模型常把值漏了引号）。已经自动尝试修复过一次，
  // 仍然失败就说明这一版回复真的坏了，重来一次基本就好。
  if (
    upper.includes('NOT VALID JSON') ||
    upper.includes('INVALID JSON') ||
    upper.includes('UNEXPECTED TOKEN') ||
    upper.includes('JSON.PARSE')
  ) {
    return make(
      'bad-request',
      '模型这次没按格式回答',
      '免费小模型偶尔会写坏 JSON，再点一次「帮我回复」通常就好了；如果经常出现，在设置 → API 功能里把模型换成「Qwen2.5-7B（免费）」。',
    );
  }

  return make('unknown', '连接失败', '先点「重新试一次」；还不行就在设置 → API 功能里点「测试连接」，那里会逐步告诉你卡在哪一步。');
}

/**
 * 给普通用户看的部分：**只有分类、标题、怎么办**。
 *
 * 原始错误（`raw`）里经常夹着服务商回显的请求体 —— 也就是用户说的那句话 ——
 * 或者整段 JSON / 堆栈。这些不该出现在字幕卡上，更不该进日志。
 * 想排查的人可以走「设置 → 性能 / 测试连接」，那里有单独的折叠区。
 */
export interface UserError {
  code: AiErrorInfo['code'];
  title: string;
  hint: string;
}

export function toUserError(info: AiErrorInfo): UserError {
  return { code: info.code, title: info.title, hint: info.hint };
}

/** 直接把一个 unknown 错误折成给用户看的三句话。 */
export function userErrorOf(error: unknown): UserError {
  return toUserError(describeAiError(error));
}
