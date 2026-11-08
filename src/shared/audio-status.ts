import type { ListeningStatus } from './types';

/**
 * 「对方停顿就自动生成回复」的看门狗，前置条件到底该是什么？
 *
 * 这个判断被单独抽出来，是因为它是「第一轮之后第二轮就再也不自动回应」的
 * 直接原因。旧实现写的是 `status === 'listening'`，把 `no-audio` 排除在外 ——
 * 而 `no-audio` 的含义只是「这一会儿没听到声音」，采集链路其实是好的。
 *
 * 后果是致命的：sidecar 只要在开机头几秒（还没开始播视频）上报过一次
 * `silent`，状态就永久停在 `no-audio`。于是等用户真的开始看视频、真的出现
 * 停顿，看门狗一次都不会触发 —— 表现为「只有第一轮手动暂停能用，之后再也
 * 不自动回应」。所以：**只要还在采集，就允许看门狗工作**。
 */
export function canWatchForPause(status: ListeningStatus): boolean {
  return status === 'listening' || status === 'no-audio';
}
