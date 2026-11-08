/**
 * 「新一批回复到了，要不要把用户手里打开的面板收掉？」
 *
 * 这条规则来自一个真实缺陷：用户在设置页把「回复风格」从自然改成幽默，界面会按
 * 新风格重出三张卡；十几秒后新卡返回，为了「让回复可见」把设置面板关掉 —— 用户
 * 下一项还没改完，面板自己消失了。静默看门狗那条路径早就挡住了「开始生成」
 * （shared/audio-status + useCopilot 里的面板判断），但挡不住「已经发出去的请求
 * 返回」。
 *
 * 所以规则是：只有用户主动要的回复（快捷键、按钮）才配把面板抢走；自己送上门来
 * 的（静默看门狗、改了风格后的重出）不许抢，回复就在面板底下等着，用户退出设置
 * 自然看得到。
 */

export interface PanelVisibility {
  showSettings: boolean;
  showRecords: boolean;
}

/**
 * @param current       当前的面板开合状态
 * @param suggestionCount 这一批回复有几张卡
 * @param reveal        是不是用户主动要的（默认 true，保持原有行为）
 */
export function panelsAfterReplies(
  current: PanelVisibility,
  suggestionCount: number,
  reveal = true,
): PanelVisibility {
  // 清空回复（关面板）不该反过来改动任何东西 —— 原实现就是这个语义。
  if (suggestionCount <= 0 || !reveal) return current;
  return { showSettings: false, showRecords: false };
}
