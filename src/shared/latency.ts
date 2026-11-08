/**
 * 全链路时延埋点。
 *
 * 为什么非要有这个：整条 AI 链路的每一跳都是「全有或全无」——
 * 语音识别整段返回、翻译整段返回、回复整段返回。而演示模式用的是本地 mock，
 * 毫秒级就返回，所以「跑起来挺流畅」是假象。真实 Key 之下到底慢在哪一段，
 * 没有数字就只能靠猜，一猜就容易优化错地方。
 *
 * 这个模块只做一件事：把每一段的耗时老老实实记下来，并算成人能读懂的结论。
 * 全部是纯函数 + 内存态，不落盘、不上传。
 */

export interface LatencyRecord {
  /** 一轮对话的关联 id：识别时产生，翻译时沿用，用来把两段合成一轮。 */
  traceId: string;
  /** 记录完成时刻（毫秒时间戳）。 */
  at: number;
  speaker: 'foreign' | 'user';
  partial: boolean;
  /** 送去做识别的这段音频本身有多长（毫秒）。 */
  audioMs: number;
  /** 语音识别耗时（毫秒）。 */
  sttMs: number;
  /** 翻译耗时（毫秒）。中途译文没翻的话就是 undefined。 */
  translateMs?: number;
  /** 识别出来的字符数。 */
  chars: number;
  /*
   * 这里**不存句子内容**。
   *
   * 0.3.6 及以前有一个 `preview` 字段（识别文本前 24 个字符）并一路传到界面。
   * 虽然只在内存里，但它就是「对话正文」，和「记录只保存在内存」这种承诺
   * 混在一起解释只会让人误解 —— 直接不存最清楚。定位「是哪一句慢」用
   * 「第几条 + 角色 + 字数」已经够了。
   */
}

export interface LatencySnapshot {
  /** 最近的识别 + 翻译记录，从旧到新。 */
  records: LatencyRecord[];
  /** 最近若干次「生成回复」的耗时（毫秒），从新到旧。 */
  replyMs: number[];
  /**
   * 「真实识别测速」的历次结果（毫秒），从新到旧。
   *
   * 为什么要把历次都留着：同一个模型、同一台机器，实测 381ms ~ 11177ms（差 29 倍）。
   * 只看一次的结果会得出完全相反的结论（0.13 倍 = 绰绰有余；3.73 倍 = 彻底跟不上），
   * 所以「测一次」必须能看到分布，而不是一个孤零零的数字。
   */
  probeMs: number[];
}

export interface LatencySummary {
  /** 参与统计的整句样本数（中途结果不计入）。 */
  count: number;
  audioAvg: number;
  sttAvg: number;
  sttP95: number;
  translateAvg: number;
  translateP95: number;
  translateSamples: number;
  /**
   * 实时率（real-time factor）：识别耗时 ÷ 音频时长。
   *
   * 这是整套指标里最关键的一个。它 >= 1 意味着「识别一段 3 秒的话要花超过
   * 3 秒」——那么字幕必然越落越远，再怎么优化交互都没用，必须先换模型或缩短
   * 音频段。它跟网络绝对速度无关，只跟「能不能跟上」有关。
   */
  rtfAvg: number;
  rtfWorst: number;
  /** 从「说完」到「译文可用」的估计耗时（识别 + 翻译）。 */
  e2eAvg: number;
  e2eP95: number;
  replyAvg: number;
  replyP95: number;
  replySamples: number;
  /** 真实识别测速的样本数 / 最新一次 / 最快 / 最慢（毫秒）。没测过时全为 0。 */
  probeSamples: number;
  probeLatest: number;
  probeFastest: number;
  probeSlowest: number;
}

export interface LatencyVerdict {
  level: 'idle' | 'ok' | 'watch' | 'bad';
  title: string;
  hint: string;
}

export function emptySnapshot(): LatencySnapshot {
  return { records: [], replyMs: [], probeMs: [] };
}

/** 取第 p 百分位（p 传 0~100）。空数组返回 0。 */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index];
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeLatency(snapshot: LatencySnapshot): LatencySummary {
  // 中途结果只是让字幕先动起来，它的耗时不代表最终体验，所以统计只认整句。
  const finals = snapshot.records.filter((record) => !record.partial);
  const stt = finals.map((record) => record.sttMs);
  const audio = finals.map((record) => record.audioMs);

  const translated = finals.filter(
    (record): record is LatencyRecord & { translateMs: number } =>
      typeof record.translateMs === 'number',
  );
  const translate = translated.map((record) => record.translateMs);
  const e2e = translated.map((record) => record.sttMs + record.translateMs);

  const rtf = finals
    .filter((record) => record.audioMs > 0)
    .map((record) => record.sttMs / record.audioMs);

  const replies = snapshot.replyMs;
  // 老快照可能没有这个字段（防御性），别让它变成 NaN。
  const probes = (snapshot.probeMs ?? []).filter((value) => value > 0);

  return {
    count: finals.length,
    audioAvg: Math.round(mean(audio)),
    sttAvg: Math.round(mean(stt)),
    sttP95: Math.round(percentile(stt, 95)),
    translateAvg: Math.round(mean(translate)),
    translateP95: Math.round(percentile(translate, 95)),
    translateSamples: translated.length,
    rtfAvg: rtf.length ? Number(mean(rtf).toFixed(2)) : 0,
    rtfWorst: rtf.length ? Number(Math.max(...rtf).toFixed(2)) : 0,
    e2eAvg: Math.round(mean(e2e)),
    e2eP95: Math.round(percentile(e2e, 95)),
    replyAvg: Math.round(mean(replies)),
    replyP95: Math.round(percentile(replies, 95)),
    replySamples: replies.length,
    probeSamples: probes.length,
    probeLatest: probes.length ? Math.round(probes[0]) : 0,
    probeFastest: probes.length ? Math.round(Math.min(...probes)) : 0,
    probeSlowest: probes.length ? Math.round(Math.max(...probes)) : 0,
  };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} 秒`;
}

/**
 * 生成回复慢到这个程度就不算「够用」了。
 *
 * 为什么单独给回复设门槛：这是个「接话」工具，对方停下来等你的时候，
 * 7 秒过去话题早凉了。实测在真实模型上「生成回复」平均能到 7 秒左右，
 * 而它恰恰是唯一一个「等的时候人是僵在那儿的」环节。
 */
export const SLOW_REPLY_MS = 6000;
const WATCH_REPLY_MS = 2500;

/**
 * 「测一次」用的音频长度。放在共享层是为了让面板、测速逻辑和体检结论用同一个数
 * —— 三处各写一个 3000，改一处就会算错实时率。
 */
export const PROBE_AUDIO_MS = 3000;

/**
 * 识别测速的分布说明。
 *
 * 必须报分布而不是单点：实测同一个模型、同一台机器，3 秒音频的往返是 381ms ~
 * 11177ms（29 倍）。测到 381ms 会得出「绰绰有余」，测到 11177ms 会得出「彻底
 * 跟不上」—— 两个结论都不算错，但只报一个就是在误导人。
 */
function probeSpreadNote(summary: LatencySummary): string {
  if (summary.probeSamples < 2) return '';
  const { probeFastest, probeSlowest } = summary;
  return `测速（3 秒音频）：历次最快 ${probeFastest} 毫秒、最慢 ${probeSlowest} 毫秒 —— 同一个模型也会差这么多，别拿一次的结果下结论。`;
}

/**
 * 回复这条链路最怕的不是平均值，而是「偶尔卡住一分钟」。
 *
 * 实测样本里有 3.2 秒的，也有 52.7 秒的（45 秒超时 + 重试），平均下来是 7 秒 ——
 * 只看平均值会以为「大概 7 秒」，实际体验是「有时候几秒，有时候一分钟没有反应」。
 * 对于「下一句该说什么」这种事，卡住的那一次才是致命的，所以要单独点出来。
 */
function replyTailNote(summary: LatencySummary): string {
  const { replyP95, replyAvg, replySamples } = summary;
  if (replySamples < 3 || replyP95 < 10_000 || replyP95 < replyAvg * 1.6) return '';
  return `最慢的那几次等到了 ${seconds(replyP95)} —— 这种时候界面只会一直转，用户等不到任何反馈。`;
}

/**
 * 把一堆数字翻译成一句人话。
 *
 * 顺序是有意的：先看实时率（跟不上就一切都白搭），再看端到端（用户实际等待的
 * 时间），最后才看单段耗时。这样界面上的结论永远先说最要命的那个问题。
 */
export function latencyVerdict(summary: LatencySummary): LatencyVerdict {
  if (summary.count === 0) {
    // 还没有字幕样本时，别急着说「没有样本」：用户第一次打开这一页大概率就是
    // 这个状态，而「测一次」和「生成回复」的样本可能已经有了。手里有数字就把
    // 它说出来，否则这一页等于什么都没告诉他。
    const probeSlowestRtf = summary.probeSlowest / PROBE_AUDIO_MS;
    if (summary.probeSamples > 0 && probeSlowestRtf >= 1) {
      return {
        level: 'bad',
        title: `识别最慢一次比音频还长 ${probeSlowestRtf.toFixed(2)} 倍`,
        hint: `没有放视频也能看出来：这一段是「测一次」量出来的真实往返。最慢的时候字幕会整体落后，先换一个更快的识别模型再谈别的。 ${probeSpreadNote(summary)}`,
      };
    }

    if (summary.replySamples > 0) {
      const reply = seconds(summary.replyAvg);
      const extra = [replyTailNote(summary), probeSpreadNote(summary)].filter(Boolean).join(' ');
      const suffix = extra ? ` ${extra}` : '';
      if (summary.replyAvg >= SLOW_REPLY_MS) {
        return {
          level: 'bad',
          title: `生成回复平均 ${reply}`,
          hint: `还没听到外语，但回复这一环已经偏慢 —— 对方停下来等你的时候，等这么久话题早就过去了。这是优先要优化的一段。${suffix}`,
        };
      }
      if (summary.replyAvg >= WATCH_REPLY_MS) {
        return {
          level: 'watch',
          title: `生成回复平均 ${reply}`,
          hint: `能用，但还有余量。放一段外语视频，这里还会补上识别和翻译各花多久。${suffix}`,
        };
      }
      return {
        level: 'ok',
        title: `生成回复平均 ${reply}`,
        hint: `回复速度看着没问题。放一段外语视频，这里就会补上识别和翻译各花多久。${suffix}`,
      };
    }

    if (summary.probeSamples > 0) {
      return {
        level: probeSlowestRtf >= 0.6 ? 'watch' : 'ok',
        title: `识别 3 秒音频最慢 ${summary.probeSlowest} 毫秒`,
        hint: `这是「测一次」的真实往返，还没放视频。实时率按最慢的一次算是 ${probeSlowestRtf.toFixed(2)}，小于 1 才能跟上。 ${probeSpreadNote(summary)}`,
      };
    }

    return {
      level: 'idle',
      title: '还没有样本',
      hint: '开始监听后说几句外语，这里会显示每一段实际花了多少毫秒。',
    };
  }

  if (summary.rtfAvg >= 1.15) {
    return {
      level: 'bad',
      title: `识别比说话还慢 ${summary.rtfAvg.toFixed(2)} 倍`,
      hint: '识别一段话花的时间已经超过这段话本身的长度，字幕会越落越远。优先换更快的识别模型，或者把每段音频切短一点。',
    };
  }

  if (summary.e2eAvg >= 3500) {
    return {
      level: 'bad',
      title: `说完到看到译文约 ${seconds(summary.e2eAvg)}`,
      hint: '真实对话里这个速度跟不上：对方早就说下一句了。把翻译改成流式输出，能明显改善。',
    };
  }

  // 字幕本身够快，但轮到「我该说什么」时要等很久 —— 对使用体验来说同样致命。
  if (summary.replySamples > 0 && summary.replyAvg >= SLOW_REPLY_MS) {
    const tail = replyTailNote(summary);
    return {
      level: 'bad',
      title: `生成回复平均 ${seconds(summary.replyAvg)}`,
      hint: `译文来得够快，但轮到帮你接话时要等这么久，对方已经等不下去了。回复这一环是现在的瓶颈。${tail ? ` ${tail}` : ''}`,
    };
  }

  if (summary.e2eAvg >= 2000) {
    return {
      level: 'watch',
      title: `说完到看到译文约 ${seconds(summary.e2eAvg)}`,
      hint: '能用，但还有余量。翻译改成流式输出通常能砍掉一半时间。',
    };
  }

  if (summary.replySamples > 0 && summary.replyAvg >= WATCH_REPLY_MS) {
    return {
      level: 'watch',
      title: `生成回复平均 ${seconds(summary.replyAvg)}`,
      hint: '字幕够快，回复还有点慢 —— 真到要接话的时候会感觉停顿了一下。',
    };
  }

  return {
    level: 'ok',
    title: `说完到看到译文约 ${seconds(summary.e2eAvg)}`,
    hint: '这个速度在真实对话里是够用的。',
  };
}
