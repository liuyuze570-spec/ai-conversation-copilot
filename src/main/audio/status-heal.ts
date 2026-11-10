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
 * 现在识别失败（网络抖 / 额度不足 / 超时）**不再把设备状态写成 error**——
 * 设备还在采集，状态一直保持 listening，识别失败只在字幕里留标记（见
 * python-engine.ts 的 runTranscribe）。所以 `error` 只剩真正的设备级错误
 * （fail()），那类错误不会有下一次成功来「自愈」，这里保留 error 分支只是
 * 防御性的。
 *
 * `no-audio` 仍需自愈：设备活着但暂时没收到声音，一次成功识别就是
 * 「链路是活的」最硬的证据。
 * `paused` 不在此列 —— 那是用户主动停的，不能被一次识别结果推翻。
 */
export function healsAfterSuccess(lastStatus: string): boolean {
  return lastStatus === 'error' || lastStatus === 'no-audio';
}
