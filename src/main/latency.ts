/**
 * 全链路时延的收集器。
 *
 * 刻意做成「纯数据模块」：不认识 Electron、不碰网络、不写文件 —— 这样它既能被
 * python-engine 直接调用，也能被单元测试直接 import 验证（本项目的真实音频
 * 链路在沙箱里跑不起来，规则抽成纯函数是唯一能证明「逻辑是对的」的办法）。
 *
 * 数据只在内存里，环形覆盖，不落盘。
 */

import type { LatencyRecord, LatencySnapshot } from '../shared/latency';

const MAX_RECORDS = 80;
const MAX_REPLIES = 24;
const MAX_PROBES = 8;

const records: LatencyRecord[] = [];
const byTrace = new Map<string, LatencyRecord>();
const replies: number[] = [];
const probes: number[] = [];
const listeners = new Set<() => void>();
let counter = 0;

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 监听者（通知界面）出错绝不能影响音频采集。
    }
  }
}

/** 开始计时一轮。返回的 traceId 要一路带到翻译那一跳，才能算真正的端到端。 */
export function beginTrace(): string {
  counter += 1;
  return `t${Date.now().toString(36)}${counter.toString(36)}`;
}

export function recordStt(input: {
  traceId: string;
  speaker: 'foreign' | 'user';
  partial: boolean;
  /** 这一段音频本身有多长（毫秒）。 */
  audioMs: number;
  /** 识别花了多久（毫秒）。 */
  sttMs: number;
  chars: number;
}): void {
  const record: LatencyRecord = {
    traceId: input.traceId,
    at: Date.now(),
    speaker: input.speaker,
    partial: input.partial,
    audioMs: Math.round(input.audioMs),
    sttMs: Math.round(input.sttMs),
    chars: input.chars,
  };
  records.push(record);
  byTrace.set(record.traceId, record);
  // 环形覆盖：只留最近的，内存占用恒定。
  if (records.length > MAX_RECORDS) {
    const dropped = records.shift();
    if (dropped) byTrace.delete(dropped.traceId);
  }
  notify();
}

/** 翻译回来之后把耗时补到同一轮记录上。找不到那一轮就忽略。 */
export function recordTranslate(traceId: string | undefined, translateMs: number): void {
  if (!traceId) return;
  const record = byTrace.get(traceId);
  if (!record) return;
  record.translateMs = Math.round(translateMs);
  notify();
}

/** 生成回复的耗时（毫秒）。回复不属于某一轮识别，单独存。 */
export function recordReply(replyMs: number): void {
  replies.unshift(Math.round(replyMs));
  if (replies.length > MAX_REPLIES) replies.length = MAX_REPLIES;
  notify();
}

/**
 * 「测一次」量到的真实识别往返耗时（毫秒）。
 *
 * 留着历次结果是因为它波动极大（实测 381ms ~ 11177ms），只留最新一次会让界面
 * 变成一台随机数发生器 —— 点一次说「很快」，再点一次说「很慢」，用户无从判断。
 */
export function recordProbe(probeMs: number): void {
  if (!(probeMs > 0)) return;
  probes.unshift(Math.round(probeMs));
  if (probes.length > MAX_PROBES) probes.length = MAX_PROBES;
  notify();
}

export function latencySnapshot(): LatencySnapshot {
  return {
    records: records.map((record) => ({ ...record })),
    replyMs: [...replies],
    probeMs: [...probes],
  };
}

export function clearLatency(): LatencySnapshot {
  records.length = 0;
  byTrace.clear();
  replies.length = 0;
  probes.length = 0;
  notify();
  return latencySnapshot();
}

/** 订阅变化（用来把最新快照推给界面）。返回取消订阅的函数。 */
export function onLatencyChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
