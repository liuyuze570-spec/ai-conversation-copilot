/**
 * 侧car 报过「听不到声音」之后，什么时候把状态捞回 `listening`？
 *
 * 抽成纯函数是为了能被测试钉死。规则本身很朴素，但漏掉的代价很大：状态一旦
 * 停在 `no-audio` 回不来，renderer 里那只看门狗（见 shared/audio-status.ts）
 * 就会整场对话失效 —— 用户看到的现象是「第一轮之后第二轮怎么也听不到了」。
 *
 * 判据用「说话中」或「电平高于 -60dB」两条，是为了兼容两种真实情况：
 * 麦克风/回环的 `speaking` 标记有 200ms 的采样粒度，而人声通常远高于 -60dB；
 * 宁可早一点恢复，也好过永久卡死。
 */
export function signalHealsStatus(
  reportedNoAudio: boolean,
  payload: { speaking: boolean; db: number },
): boolean {
  return reportedNoAudio && (payload.speaking || payload.db > -60);
}

/**
 * 识别**成功**之后，哪些状态应该被捞回 `listening`？
 *
 * 这是「识别失败一次，整场自动回复就废了」的正解。原来的自愈只覆盖
 * `no-audio`（靠 `reportedNoAudio` 标记），漏掉了 `error`：
 *
 *   · 网络抖一下 → `runTranscribe` catch → status = 'error'
 *   · 下一句识别成功 → 只是正常写字幕，没人去改状态
 *   · renderer 的停顿看门狗门槛是 `listening | no-audio`（见 audio-status.ts）
 *   · 于是整场对话的「对方停顿就自动出回复」永久失效
 *
 * 一次成功请求本身就是「链路是活的」最硬的证据，所以 error 也该被它治好好。
 * `paused` 不在此列 —— 那是用户主动停的，不能被一次识别结果推翻。
 */
export function healsAfterSuccess(lastStatus: string): boolean {
  return lastStatus === 'error' || lastStatus === 'no-audio';
}
