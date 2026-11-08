import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';
import { findProvider } from '../../shared/providers';
import { IconLock } from './icons';

/**
 * 第一次打开时到底要告诉用户什么？
 *
 * 只写「我们很注重隐私」没有用。用户真正需要判断的是四件事：
 *   ① 它听什么（系统声音 / 麦克风）
 *   ② 这些内容发给了谁（具体到服务商名字，而不是「第三方」）
 *   ③ 需要什么条件才能用（联网 + 自己的 Key，本机不识别）
 *   ④ 怎么让它停下来（必须给一个他能立刻做的动作）
 * 所以这几条放在最前面。
 *
 * 措辞纪律：这里不写「绝对安全」「永久免费」这类无法核验的承诺。
 * 能说清的都是事实 —— 音频不落盘、正文不写日志、除服务商外不转发。
 */
const POINTS = [
  '不录像，不保存视频；原始录音用完即弃，不写入磁盘',
  '识别出来的文字（原文、译文、谐音）会保存在这台电脑上，关掉 / 重启 / 升级都不会删',
  '记录可以逐段删除、可以整体导出；导出和备份都由你自己发起，不会自动上传',
  '本地保存不等于加密：能用你这台电脑的人，也能直接读到记录文件',
  '日志只记耗时、字数、错误码，不写对话内容',
  '除了上面那家服务商，不会再发给任何第三方',
];

export function PrivacyNotice() {
  const update = useSettingsStore((state) => state.update);
  const setShowPrivacy = useUiStore((state) => state.setShowPrivacy);
  const settings = useSettingsStore((state) => state.settings);

  const providerName =
    findProvider(settings.ai.provider)?.label ?? '你选定的国内服务商';
  const onsite = settings.audio.sourceMode === 'onsite';
  const captures = onsite
    ? ['麦克风里对方说的话']
    : [
        settings.audio.captureSystemAudio ? '电脑正在播放的声音（对方）' : '',
        settings.audio.captureMicrophone ? '麦克风里你自己的声音' : '',
      ].filter(Boolean);

  const accept = () => {
    void update({ privacyAccepted: true });
    setShowPrivacy(false);
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end bg-ink-950/[0.97] p-4 backdrop-blur-xl">
      <div className="animate-fade-in-up">
        <span className="mb-3 grid h-9 w-9 place-items-center rounded-2xl bg-accent/15 text-accent-soft">
          <IconLock size={16} />
        </span>
        <h2 className="text-[15px] font-semibold tracking-[0.01em] text-white/95">
          英语沟通字幕助手
        </h2>

        {/* ① 听什么 */}
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/45">
          它只处理
          <b className="text-white/70"> {captures.join('和') || '电脑正在播放的声音'} </b>
          （不是屏幕画面，也不碰你的摄像头）。
        </p>

        {/* ② 发给谁 */}
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/45">
          声音片段会发到
          <b className="text-white/70"> {providerName} </b>
          做识别，字幕和参考回复也由它生成。换服务商在「设置 → API 功能」里改。
        </p>

        {/* ③ 需要什么条件 —— 这条以前没写，用户会以为装完就能离线用 */}
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/45">
          需要<b className="text-white/70">联网</b>，并且要有自己的 API Key（在「设置 →
          API 功能」里填）。本机的 Python 只负责<b className="text-white/70">采集声音</b>，
          识别和翻译都在云端完成 —— 断网时它听得到，但出不了字幕。
        </p>

        {/* ④ 怎么停 */}
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/45">
          想让它停：按
          <kbd className="mx-1 rounded border border-line bg-ink-800 px-1 py-[1px] text-[10px] text-white/70">
            Alt + P
          </kbd>
          暂停，或点标题栏的暂停键；关掉窗口会立刻停止采集。
        </p>

        <ul className="mt-3 space-y-1.5">
          {POINTS.map((point) => (
            <li key={point} className="flex items-start gap-2 text-[11.5px] leading-snug text-white/55">
              <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-accent-soft/70" />
              {point}
            </li>
          ))}
        </ul>

        <p className="mt-2 text-[10.5px] leading-relaxed text-white/30">
          记录文件在「设置 → 通用 → 记录」里能看到完整路径，也可以一键打开所在文件夹。
          API Key 用 Windows 系统加密后只保存在这台电脑上；系统不支持加密时只放在内存里，重启需要重填。
        </p>

        <button
          type="button"
          data-privacy-accept
          onClick={accept}
          className="btn-primary mt-4 w-full !py-2.5 !text-[13px]"
        >
          我明白了，开始使用
        </button>
        <p className="mt-2.5 text-center text-[10px] leading-relaxed text-white/25">
          第一次用？打开「设置 → API 功能」，里面有一份 3 分钟图文教程
        </p>
      </div>
    </div>
  );
}
