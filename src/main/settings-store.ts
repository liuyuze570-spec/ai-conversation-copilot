import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { DEFAULT_SETTINGS, type EnglishGrade, type Settings } from '../shared/types';
import { isKnownLevel, levelFor } from '../shared/levels';
import {
  normalizeBaseURL,
  checkDomesticURL,
  enforceHttps,
  recommendedProvider,
  findProvider,
} from '../shared/providers';
import {
  bindingHostOf,
  bindingOriginOf,
  followSchemeUpgrade,
  keyOwnership,
  maskKey,
  originOfBinding,
  ownershipMessage,
  type KeyBinding,
  type KeyOwnership,
} from '../shared/key-binding';
import { logger } from './logger';
import {
  clampFont,
  ORIGINAL_FONT_DEFAULT,
  ROMANIZATION_FONT_DEFAULT,
  TRANSLATION_FONT_DEFAULT,
} from '../shared/reading';
import {
  COMPREHENSION_LANGUAGES,
  HINT_SYSTEMS,
  bcp47For,
  defaultHintSystem,
  type ComprehensionLanguage,
} from '../shared/languages';

const STORE_FILE = 'settings.json';
/** 文字模型（LLM）的 Key。保留旧字段名，老用户的 Key 不会丢。 */
const KEY_FIELD = 'apiKeyEncrypted';
/** 语音识别（STT）的 Key。只有 STT 换了别家时才会用到。 */
const STT_KEY_FIELD = 'sttApiKeyEncrypted';

export type KeyTarget = 'llm' | 'stt';

/**
 * 错误只留「叫什么」。
 *
 * 加解密失败时 `String(error)` 可能带出被解密的字节片段，而这段字节就是
 * 密钥的明文。日志里出现一次就等于密钥泄露到磁盘，所以这里一律只记名字。
 */
function errorCode(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return typeof error === 'string' ? 'Error' : 'unknown';
}

/** 两个密钥字段的名字（用字面量类型，才能安全地索引 StoredShape）。 */
type KeyField = typeof KEY_FIELD | typeof STT_KEY_FIELD;

/** 密钥属于哪台服务器、哪个服务商。老版本没有这个字段。 */
interface KeyBindings {
  llm?: KeyBinding;
  stt?: KeyBinding;
}

type StoredShape = Settings & {
  [KEY_FIELD]?: string;
  [STT_KEY_FIELD]?: string;
  keyBindings?: KeyBindings;
};

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    if (
      current &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(
        current as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

class SettingsStore {
  private data: StoredShape;
  private filePath: string;
  private encryptionAvailable: boolean;
  /**
   * 系统加密不可用时，Key 只活在这个 Map 里。
   *
   * 旧实现在 `safeStorage` 不可用（部分精简版 Windows、某些虚拟桌面）时，
   * 直接把 Key 以 `plain:sk-xxx` 写进 settings.json —— 用户完全不知情，
   * 而那个文件就躺在 AppData 里，随便一个程序都能读到。
   * 现在宁可用起来麻烦一点（重启要重填），也不落盘明文。
   */
  private sessionKeys = new Map<KeyTarget, string>();
  /** 哪些 Key 是「只在本次运行有效」的（界面要提示用户）。 */
  private ephemeralKeys = new Set<KeyTarget>();
  /**
   * settings.json 里**真的写过**的顶层字段名。
   *
   * 迁移必须能区分「用户选过 hanzi」和「从没写过这个字段、只是被默认值填上
   * 了 hanzi」。只看合并后的值，一个日语使用者升级上来就会永远看到汉字谐音。
   */
  private provided = new Set<string>();
  /**
   * 已经就「Key 不属于这家」告过警的组合。
   *
   * `getApiKey` 是每次请求都会走的高频路径，绑定不匹配时如果每次都写日志，
   * 一场对话能刷出上百行，真正的问题反而被埋了。同一个 (target, host) 只报一次。
   */
  private warnedMismatch = new Set<string>();

  constructor() {
    this.filePath = path.join(app.getPath('userData'), STORE_FILE);
    this.encryptionAvailable = safeStorage.isEncryptionAvailable();
    this.data = deepMerge(
      DEFAULT_SETTINGS as unknown as Record<string, unknown>,
      {},
    ) as unknown as StoredShape;
    this.load();
    // 密钥迁移必须排在「写盘」的任何一步之前：它负责把明文搬进内存，
    // 而 persist() 一旦先跑，明文就会被当成待清理的脏数据。
    this.migrateKeyStorage();
    this.migrateEndpoints();
    this.migrateLanguageLevels();
    this.migrateAudioDefaults();
    this.migrateReading();
    this.migrateLanguageDirection();
    this.migrateSlowModel();
    logger.info(
      'Settings',
      `loaded from ${this.filePath} (encryption=${this.encryptionAvailable})`,
    );
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<StoredShape>;
        this.provided = new Set(Object.keys(parsed));
        this.data = deepMerge(
          DEFAULT_SETTINGS as unknown as Record<string, unknown>,
          parsed as Record<string, unknown>,
        ) as unknown as StoredShape;
      }
    } catch (error) {
      // 这个文件里就是加密后的密钥：JSON.parse 的报错会把文件片段带进 message，
      // 所以只能记错误名，绝不能 String(error)。
      logger.error('Settings', `failed to read settings: ${errorCode(error)}`);
    }
  }

  /**
   * 只允许国内接口，且公网必须 https。
   *
   * 老版本默认写的是 OpenAI，海外接口在国内既不稳定也不合规；升级后
   * 如果发现存的是境外地址（或空地址），自动换回国内默认服务商，
   * 用户不需要手动改任何东西。
   *
   * 但如果只是「公网地址写成了 http」，**不能**换服务商 —— 那会把模型和
   * Key 一起废掉。这种情况只把 scheme 升级成 https，用户的配置原封不动。
   */
  private migrateEndpoints(): void {
    let changed = false;
    const ai = this.data.ai;
    if (!ai || typeof ai !== 'object') {
      this.data.ai = { ...DEFAULT_SETTINGS.ai };
      changed = true;
    } else {
      const llm = this.normalizeEndpoint(ai, 'baseURL', 'LLM');
      const stt = this.normalizeEndpoint(ai, 'sttBaseURL', 'STT');
      changed = changed || llm || stt;
    }

    /*
     * 地址被升级（公网 http → https）之后，把绑定一起跟上去。
     *
     * 不做这一步就会出现一个很冤枉的情况：用户配置里写的是
     * `http://api.siliconflow.cn/v1`，Key 在 `migrateKeyStorage()` 里被绑定到
     * `http://api.siliconflow.cn`；紧接着这里把地址升级成 https，严格比对就
     * 变成「不匹配」，Key 被停用 —— 可用户根本没换服务商。
     *
     * 跟随规则本身是纯函数 `followSchemeUpgrade()`：只认同一主机的 http → https，
     * 反方向绝不跟随（那是降级，等于明文发 Key）。
     */
    for (const target of ['llm', 'stt'] as KeyTarget[]) {
      const binding = this.bindingOf(target);
      if (!binding) continue;
      const next = followSchemeUpgrade(binding, this.originFor(target));
      if (!next) continue;
      binding.origin = next;
      delete binding.host;
      changed = true;
      logger.info('Settings', `${target} 的 Key 绑定随地址升级为 ${next}`);
    }

    if (changed) this.persist();
  }

  /**
   * 归一化一个接口地址字段。返回是否改动过。
   *
   * 顺序是「先补全 → 再判 http → 再判合规」：直接拿用户手写的原文去判，
   * 会把「没写 https:// 的域名」误判成不合规。
   */
  private normalizeEndpoint(
    ai: Settings['ai'],
    field: 'baseURL' | 'sttBaseURL',
    label: string,
  ): boolean {
    const original = ai[field] ?? '';
    let next = normalizeBaseURL(original);
    const check = checkDomesticURL(next);

    if (!check.ok && check.insecure) {
      next = normalizeBaseURL(enforceHttps(next));
      logger.warn('Settings', `${label} 接口 ${check.host} 是 http 明文，已自动升级为 https`);
    }

    const final = checkDomesticURL(next);
    if (!final.ok) {
      const fallback = recommendedProvider();
      logger.warn(
        'Settings',
        `${label} endpoint "${final.host || '(空)'}" 不是国内接口，已自动切换到 ${fallback.label}`,
      );
      if (field === 'baseURL') {
        ai.provider = fallback.id;
        ai.baseURL = fallback.llmBaseURL;
        ai.model = fallback.llmModels[0]?.id ?? ai.model;
      } else {
        ai.sttProvider = fallback.id;
        ai.sttBaseURL = fallback.sttBaseURL ?? fallback.llmBaseURL;
        ai.sttModel = fallback.sttModels?.[0]?.id ?? ai.sttModel;
      }
      return true;
    }

    if (next !== normalizeBaseURL(original)) {
      ai[field] = next;
      return true;
    }
    return false;
  }

  /**
   * 密钥存储的迁移。
   *
   * 两件事：
   * 1. 老版本在加密不可用时会写 `plain:xxx` 明文。读到就搬进内存、从文件里删掉
   *    —— 明文留在磁盘上等于没有加密。
   * 2. 老版本的 Key 没有「属于谁」的记录。绑定到**当前**配置的 host 上：
   *    这最接近它一直以来的用法；此后一旦换服务商就会被拦住。
   */
  private migrateKeyStorage(): void {
    let changed = false;

    for (const target of ['llm', 'stt'] as KeyTarget[]) {
      const field = this.fieldFor(target);
      const raw = this.data[field];
      /*
       * **迁移前**先把「原接口身份」记下来。
       *
       * 这一步必须在 `migrateEndpoints()` 之前完成（构造函数里的顺序已经保证）：
       * 端点迁移可能会因为「境外地址」把服务商整个换掉，等到那时候再取
       * origin，绑上去的就已经是新服务商了 —— 旧 Key 会被正确绑定到错误的
       * 地方，等于没修。
       *
       * 用的是完整 origin（协议 + 主机 + 端口），不是主机名：换端口就是另一台
       * 服务，https 降成 http 更是直接把 Key 暴露在链路上。
       */
      const origin = this.originFor(target);

      if (typeof raw === 'string' && raw.startsWith('plain:')) {
        const value = raw.slice(6);
        if (value) {
          this.sessionKeys.set(target, value);
          this.ephemeralKeys.add(target);
          /*
           * 0.3.6 的 bug 就在这一行缺失上：明文被搬进内存、字段被删掉之后，
           * 下面那个 `if (this.data[field] && ...)` 永远为 false，于是这把
           * 内存里的 Key 从来没有绑定 —— `keyBelongsTo(undefined, ...)` 当时
           * 返回 true，端点自动切换后就把它发给了新服务商。现在无论 Key 存在
           * 哪里（内存还是密文），都统一绑到迁移前记录的那个 origin 上。
           */
          if (origin) {
            this.bindKey(target, origin);
            changed = true;
          }
        }
        delete this.data[field];
        changed = true;
        logger.warn(
          'Settings',
          `${target} 的 Key 之前是以明文存在 settings.json 里的，已从磁盘移除；` +
            '本次运行仍可用，重启后需要重新粘贴。',
        );
        continue;
      }

      if (raw && !this.bindingOf(target)) {
        if (origin) {
          this.bindKey(target, origin);
          changed = true;
        }
      } else if (raw && this.upgradeLegacyBinding(target, origin)) {
        changed = true;
      }
    }

    if (changed) this.persist();
  }

  /**
   * 0.3.6 的绑定只有 `host`（没有协议和端口）。这里换成完整 origin。
   *
   * 主机名和当前地址一致 → 直接用当前 origin（协议端口都能确定）；
   * 不一致 → 说明用户已经换过服务商，只补成 `https://host`，让它继续被拦住
   * （**不能**补成当前 origin，那等于替用户「认领」了一把不属于这家的 Key）。
   */
  private upgradeLegacyBinding(target: KeyTarget, currentOrigin: string): boolean {
    const binding = this.bindingOf(target);
    if (!binding || binding.origin) return false;
    const legacyHost = (binding.host ?? '').toLowerCase();
    if (!legacyHost) return false;
    const sameHost = legacyHost === bindingHostOf(currentOrigin);
    binding.origin = sameHost ? currentOrigin : `https://${legacyHost}`;
    logger.info('Settings', `${target} 的 Key 绑定已升级为 ${binding.origin}`);
    return true;
  }

  private bindings(): KeyBindings {
    if (!this.data.keyBindings) this.data.keyBindings = {};
    return this.data.keyBindings;
  }

  private bindingOf(target: KeyTarget): KeyBinding | undefined {
    return this.data.keyBindings?.[target];
  }

  private bindKey(target: KeyTarget, origin = this.originFor(target)): void {
    if (!origin) return;
    this.bindings()[target] = {
      origin,
      providerId:
        target === 'stt'
          ? (this.data.ai?.sttProvider ?? this.data.ai?.provider ?? 'custom')
          : (this.data.ai?.provider ?? 'custom'),
      at: Date.now(),
    };
  }

  /**
   * 这个 target 现在应该对哪台服务器负责（完整 origin）。
   *
   * 地址为空时退回推荐服务商 —— 这正是 `migrateEndpoints()` 接下来会把它换成
   * 的地址。绑到一个「即将生效」的地址，比绑到空串、让密钥变成「归属未知」
   * 再被拦住要合理得多。
   */
  private originFor(target: KeyTarget): string {
    const ai = this.data.ai;
    const fallback = recommendedProvider();
    if (target === 'stt') {
      if (ai?.sttBaseURL) return bindingOriginOf(ai.sttBaseURL);
      if (ai?.baseURL) return bindingOriginOf(ai.baseURL);
      return bindingOriginOf(fallback.sttBaseURL ?? fallback.llmBaseURL);
    }
    return bindingOriginOf(ai?.baseURL || fallback.llmBaseURL);
  }

  /**
   * 语言水平的迁移与归一。
   *
   * 历史的坑有两个：
   * 1. 更早的版本记的是 CEFR（A1 / A2 / B1 / B2 / C1）—— 中国用户基本只在驾照上
   *    见过这种写法，已换成国内英语考试等级，旧值在这里翻译一次，用户原来的水平
   *    设置不会丢。
   * 2. 现在的「语言水平」按对话语言分开记（英语 / 俄语 / 日语 / 韩语各一套）。
   *    老设置文件只有 `englishLevel` 一个字段，这里把它搬进 `languageLevels.English`；
   *    其它三种语言没有历史值，用各自默认档（多数人的水平）。
   *
   * 判断顺序很重要：**先看 languageLevels.English 是否已经合法**。如果反过来先看
   * 旧的 englishLevel，那么用户把英语改成六级之后，只要 englishLevel 还是旧值，
   * 每次启动都会被改回去。
   */
  private migrateLanguageLevels(): void {
    const legacy: Record<string, string> = {
      A1: 'pretcoB',
      A2: 'pretcoB',
      B1: 'cet4',
      B2: 'cet6',
      C1: 'tem8',
    };
    const existing = (this.data.languageLevels ?? {}) as Record<string, string>;
    const rawEnglish = (this.data.englishLevel as string | undefined) ?? '';
    const mappedLegacy = legacy[rawEnglish] ?? rawEnglish;

    const english =
      existing.English && isKnownLevel('English', existing.English)
        ? existing.English
        : levelFor({ English: mappedLegacy }, 'English');

    const next = {
      English: english,
      Russian: levelFor(existing, 'Russian'),
      Japanese: levelFor(existing, 'Japanese'),
      Korean: levelFor(existing, 'Korean'),
    };

    if (mappedLegacy !== rawEnglish && rawEnglish) {
      logger.info('Settings', `语言水平 ${rawEnglish} → ${english}（改用国内英语等级）`);
    }

    const changed =
      !this.data.languageLevels ||
      (Object.keys(next) as (keyof typeof next)[]).some(
        (key) => this.data.languageLevels?.[key] !== next[key],
      );
    if (changed) {
      this.data.languageLevels = next;
      this.persist();
    }
    // 让落盘的 englishLevel 也保持同步，方便回退版本或直接看文件时不出错。
    if (this.data.englishLevel !== english) {
      this.data.englishLevel = english as EnglishGrade;
      this.persist();
    }
  }

  /**
   * 音频的旧默认值升级。
   *
   * `vadSilenceMs` 的旧默认是 900ms：一句话里的自然换气就会被判成「说完了」，
   * 切出来的半句各翻一次，读起来就对不上（用户反馈的核心问题之一）。
   * 只有「还是旧默认值」的配置才动它，用户自己调过的值一律保留。
   */
  private migrateAudioDefaults(): void {
    const audio = this.data.audio;
    if (!audio || typeof audio !== 'object') return;
    if (audio.vadSilenceMs === 900) {
      audio.vadSilenceMs = DEFAULT_SETTINGS.audio.vadSilenceMs;
      logger.info('Settings', `静音判定 900ms → ${audio.vadSilenceMs}ms（减少半句切分）`);
      this.persist();
    }
    /*
     * 音源用途。
     *
     * 老设置里没有这个字段。按「当时实际在采什么」推断，而不是一律给 online：
     * 只开麦克风（系统声音关着）的用户显然是在现场用麦克风听人说话，
     * 给他 online 会让麦克风被当成「自己说话」，一句都不翻译 —— 功能直接没了。
     */
    if (audio.sourceMode !== 'online' && audio.sourceMode !== 'onsite') {
      const inferred =
        audio.captureMicrophone && !audio.captureSystemAudio ? 'onsite' : 'online';
      audio.sourceMode = inferred;
      logger.info('Settings', `音源用途推断为 ${inferred}`);
      this.persist();
    }
  }

  /**
   * 字幕字号：从「一个字号」迁到「原文 / 译文分开」。
   *
   * 老版本只有一个 `subtitle.fontSize`（默认 15），译文固定减 2 并且压到
   * 45% 不透明度。升级时**不能**把 15 直接当译文 —— 那等于把最难读的那个值
   * 原样搬进新版本。规则：
   * - 原文沿用老字号（用户可能已经调到 20，别给他改小）；
   * - 译文从 24 起；
   * - 谐音没有历史值，从 18 起；
   * - 三类都钳到 12–64（这一版统一了范围，不再各自一套）。
   */
  private migrateReading(): void {
    const subtitle = this.data.subtitle;
    if (!subtitle || typeof subtitle !== 'object') return;
    let changed = false;

    const legacy = typeof subtitle.fontSize === 'number' ? subtitle.fontSize : 15;
    if (typeof subtitle.originalFontSize !== 'number') {
      subtitle.originalFontSize = clampFont(legacy);
      changed = true;
    } else {
      const clamped = clampFont(subtitle.originalFontSize);
      if (clamped !== subtitle.originalFontSize) {
        subtitle.originalFontSize = clamped;
        changed = true;
      }
    }
    if (typeof subtitle.translationFontSize !== 'number') {
      subtitle.translationFontSize = clampFont(legacy > 15 ? legacy + 6 : 24);
      changed = true;
    } else {
      const clamped = clampFont(subtitle.translationFontSize);
      if (clamped !== subtitle.translationFontSize) {
        subtitle.translationFontSize = clamped;
        changed = true;
      }
    }
    if (typeof subtitle.romanizationFontSize !== 'number') {
      subtitle.romanizationFontSize = ROMANIZATION_FONT_DEFAULT;
      changed = true;
    } else {
      const clamped = clampFont(subtitle.romanizationFontSize);
      if (clamped !== subtitle.romanizationFontSize) {
        subtitle.romanizationFontSize = clamped;
        changed = true;
      }
    }
    if (subtitle.readingMode !== 'both' && subtitle.readingMode !== 'translation-first' && subtitle.readingMode !== 'original-only') {
      subtitle.readingMode = 'both';
      changed = true;
    }
    if (typeof subtitle.highContrast !== 'boolean') {
      subtitle.highContrast = false;
      changed = true;
    }

    /*
     * 15→18 / 23→24 **只做一次**。
     *
     * 0.5.0 把这段逻辑放在 `readingPrefs()` 里，于是每次渲染都在迁移：
     * 用户主动把原文调成 15px（想在 460×640 里多显示两行），下次启动又被
     * 改成 18 —— 他调的东西自己弹回去了，而界面没有任何提示。
     *
     * 现在用 `readingVersion` 当闸门：只有「从没迁移过」的设置才改一次，
     * 之后 15 和 23 都是合法值，一律原样保留。
     */
    const version = typeof this.data.readingVersion === 'number' ? this.data.readingVersion : 0;
    if (version < 2) {
      if (subtitle.originalFontSize === 15) {
        subtitle.originalFontSize = ORIGINAL_FONT_DEFAULT;
        changed = true;
      }
      if (subtitle.translationFontSize === 23) {
        subtitle.translationFontSize = TRANSLATION_FONT_DEFAULT;
        changed = true;
      }
      this.data.readingVersion = 2;
      changed = true;
    }

    if (changed) {
      logger.info(
        'Settings',
        `字幕字号迁移：原文 ${subtitle.originalFontSize}px / 译文 ${subtitle.translationFontSize}px / 谐音 ${subtitle.romanizationFontSize}px`,
      );
      this.persist();
    }
  }

  /**
   * 语言方向字段的迁移。
   *
   * 老设置里只有 `nativeLanguage`（当时叫「母语」）和 `targetLanguage`，
   * 没有「读音提示体系」和「口音」。这里按理解语言补一个**起点**，
   * 用户之后可以自己改。
   *
   * 关键：`hintSystem` 不能硬编码成 'hanzi' —— 一个理解语言已经是日语的
   * 用户，默认应该是片假名，否则他又会看到一行汉字谐音。
   */
  private migrateLanguageDirection(): void {
    let changed = false;
    if (!this.data.uiLanguage) {
      this.data.uiLanguage = 'zh-CN';
      changed = true;
    }
    const comprehension = (this.data.nativeLanguage ?? 'Chinese') as ComprehensionLanguage;
    if (!COMPREHENSION_LANGUAGES.some((item) => item.value === comprehension)) {
      this.data.nativeLanguage = 'Chinese';
      changed = true;
    }
    /*
     * `hintSystem` 只在「文件里从来没写过」或「写得不是一个合法值」时才重算。
     *
     * 为什么不能只看值：`DEFAULT_SETTINGS.hintSystem` 是 'hanzi'，一份日语
     * 使用者的旧设置读进来会被默认值填成 hanzi —— 值合法，于是迁移什么都不做，
     * 他升级之后看到的仍然是「哈喽」这种对他毫无意义的汉字近音。
     *
     * 也不能无条件重算：用户可能明确给英语选了汉字近音，那必须保留。
     */
    const hintProvided = this.provided.has('hintSystem');
    if (
      !this.data.hintSystem ||
      !HINT_SYSTEMS.some((item) => item.value === this.data.hintSystem) ||
      !hintProvided
    ) {
      this.data.hintSystem = defaultHintSystem(
        (this.data.nativeLanguage ?? 'Chinese') as ComprehensionLanguage,
        this.data.targetLanguage,
      );
      changed = true;
    }
    // 口音和提示体系同理：没写过就按目标语言给一个，写过了就不动。
    if (!this.data.accent || !this.provided.has('accent')) {
      this.data.accent = bcp47For(this.data.targetLanguage);
      changed = true;
    }
    const pronunciation = this.data.pronunciation;
    if (pronunciation && typeof pronunciation === 'object') {
      if (typeof pronunciation.readingHint !== 'boolean') {
        // 老设置里只有 chinesePronunciation；它就是「显示读音提示」那个开关。
        pronunciation.readingHint = pronunciation.chinesePronunciation !== false;
        pronunciation.chinesePronunciation = pronunciation.readingHint;
        changed = true;
      }
    }
    if (changed) {
      logger.info(
        'Settings',
        `语言方向：理解=${this.data.nativeLanguage} 目标=${this.data.targetLanguage} 提示=${this.data.hintSystem} 口音=${this.data.accent}`,
      );
      this.persist();
    }
  }

  /**
   * 推理型模型不适合实时场景。
   *
   * 实测 Qwen3-8B 生成一版回复要 10–20 秒（思考链占绝大部分），而这个产品的
   * 核心承诺是「3 秒内把话说出口」。新手从下拉里挑第二个「免费」的很容易挑中
   * 它，所以这里自动换回该服务商的首选（最快）模型，并在日志里说明原因。
   */
  private migrateSlowModel(): void {
    const ai = this.data.ai;
    if (!ai?.model) return;
    if (!/qwen3|qwq|glm-z1|hunyuan-t1|deepseek-r1|reasoner/i.test(ai.model)) return;
    const fallback = findProvider(ai.provider)?.llmModels[0]?.id;
    if (!fallback || fallback === ai.model) return;
    logger.warn(
      'Settings',
      `模型 ${ai.model} 是推理型（实测一版回复要 10 秒以上），已自动换成 ${fallback}`,
    );
    ai.model = fallback;
    this.persist();
  }

  private persist() {
    try {
      /*
       * 双保险：任何代码路径都不可能把明文 Key 写进磁盘。
       *
       * 但**不能只是删**：老用户的 `plain:xxx` 就是他们唯一的一份 Key，直接
       * 删掉等于静默丢钥匙。这里先把它搬进内存（本次运行仍可用），再从
       * 落盘数据里移除。这一步曾经写反过顺序 —— 迁移还没跑，persist 就把它
       * 删了，结果是「升级后 Key 没了，而且没有任何提示」。
       */
      for (const field of [KEY_FIELD, STT_KEY_FIELD] as KeyField[]) {
        const raw = this.data[field];
        if (typeof raw !== 'string' || !raw.startsWith('plain:')) continue;
        const target: KeyTarget = field === STT_KEY_FIELD ? 'stt' : 'llm';
        const value = raw.slice(6);
        if (value) {
          if (!this.sessionKeys.get(target)) this.sessionKeys.set(target, value);
          this.ephemeralKeys.add(target);
        }
        delete this.data[field];
      }
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (error) {
      logger.error('Settings', `failed to write settings: ${errorCode(error)}`);
    }
  }

  /** Settings without any secret material, safe to send to the renderer. */
  get(): Settings {
    const { [KEY_FIELD]: _llm, [STT_KEY_FIELD]: _stt, keyBindings: _bindings, ...rest } =
      this.data;
    const languageLevels = rest.languageLevels ?? DEFAULT_SETTINGS.languageLevels;
    return {
      ...rest,
      languageLevels,
      // 单一真相是 languageLevels，englishLevel 只是它的投影。
      englishLevel: languageLevels.English as EnglishGrade,
    } as Settings;
  }

  update(patch: Partial<Settings>): Settings {
    const next: Partial<Settings> = { ...patch };
    // 老调用点（以及回退版本的界面）还在写 `englishLevel`：统一折进
    // languageLevels.English，避免两个字段各说各话。
    if (patch.englishLevel && !patch.languageLevels?.English) {
      next.languageLevels = {
        ...(this.data.languageLevels ?? DEFAULT_SETTINGS.languageLevels),
        English: patch.englishLevel,
      };
    }
    this.data = deepMerge(
      this.data as unknown as Record<string, unknown>,
      next as Record<string, unknown>,
    ) as unknown as StoredShape;
    if (this.data.ai) {
      this.data.ai.baseURL = normalizeBaseURL(this.data.ai.baseURL ?? '');
      this.data.ai.sttBaseURL = normalizeBaseURL(this.data.ai.sttBaseURL ?? '');
    }
    this.persist();
    return this.get();
  }

  private fieldFor(target: KeyTarget): KeyField {
    return target === 'stt' ? STT_KEY_FIELD : KEY_FIELD;
  }

  /**
   * 保存 API Key（Windows DPAPI 加密）。
   *
   * 三种落点：
   * - 有系统加密 → 加密后写盘（正常情况）；
   * - 没有系统加密 → **只放内存**，不写盘，重启后需重填；
   * - 空字符串 → 删除，并清掉绑定。
   */
  setApiKey(apiKey: string, target: KeyTarget = 'llm'): boolean {
    const field = this.fieldFor(target);
    try {
      const value = (apiKey ?? '').trim();

      if (!value) {
        delete this.data[field];
        this.sessionKeys.delete(target);
        this.ephemeralKeys.delete(target);
        if (this.data.keyBindings) delete this.data.keyBindings[target];
        this.persist();
        return true;
      }

      if (this.encryptionAvailable) {
        const encrypted = safeStorage.encryptString(value).toString('base64');
        this.data[field] = `enc:${encrypted}`;
        this.sessionKeys.delete(target);
        this.ephemeralKeys.delete(target);
      } else {
        // 宁可用起来麻烦，也不留明文。
        delete this.data[field];
        this.sessionKeys.set(target, value);
        this.ephemeralKeys.add(target);
        logger.warn(
          'Settings',
          '系统加密不可用：这把 Key 只保存在内存里，不会写入磁盘（重启后需要重新粘贴）。',
        );
      }

      // 记下「这把 Key 属于哪台服务器」，切换服务商时据此拦截。
      this.bindKey(target);
      // 重新绑定过，之前那条「不匹配」的提醒要能再报一次。
      this.warnedMismatch.clear();
      this.persist();
      return true;
    } catch (error) {
      logger.error('Settings', `setApiKey failed: ${errorCode(error)}`);
      return false;
    }
  }

  /**
   * 取出原始 Key（**不**做绑定校验）。
   *
   * 只给内部做「这把 Key 到底属于谁」的判断用；真正要拿去发请求的地方一律
   * 走 `getApiKey()`，否则就绕过了绑定检查。
   */
  private readKey(target: KeyTarget): string {
    const cached = this.sessionKeys.get(target);
    if (cached) return cached;

    const raw = this.data[this.fieldFor(target)];
    if (!raw) return '';
    try {
      if (raw.startsWith('enc:')) {
        const buffer = Buffer.from(raw.slice(4), 'base64');
        return safeStorage.decryptString(buffer);
      }
      if (raw.startsWith('plain:')) {
        // 理论上迁移时已经处理干净；万一还有（比如外部手改过文件），
        // 读出来之后就搬进内存、把明文从盘上删掉。
        const value = raw.slice(6);
        if (value) {
          this.sessionKeys.set(target, value);
          this.ephemeralKeys.add(target);
          delete this.data[this.fieldFor(target)];
          this.persist();
          logger.warn('Settings', `发现明文 Key（${target}），已从磁盘移除并改为仅内存保存。`);
        }
        return value;
      }
    } catch (error) {
      logger.error('Settings', `getApiKey failed: ${errorCode(error)}`);
    }
    return '';
  }

  /**
   * 取可用于发请求的 Key。
   *
   * **绑定了别的服务商就返回空串** —— 这是这次安全修复的重点：旧 Key 不允许
   * 被发到新服务商那里去。返回空之后，上层会报「还没有填 Key」，用户自然会
   * 重新粘贴，而不是收到一个莫名其妙的 401。
   */
  getApiKey(target: KeyTarget = 'llm'): string {
    const key = this.readKey(target);
    if (!key) return '';
    const binding = this.bindingOf(target);
    const origin = this.originFor(target);
    const ownership = keyOwnership(binding, origin);
    if (ownership !== 'ok') {
      const signature = `${target}|${originOfBinding(binding)}|${origin}|${ownership}`;
      if (!this.warnedMismatch.has(signature)) {
        this.warnedMismatch.add(signature);
        // 只记 origin 和原因，不记 Key 本身。
        logger.warn(
          'Settings',
          `${target} 的 Key ${ownership === 'unknown' ? '没有归属记录' : `属于 ${originOfBinding(binding)}`}，` +
            `当前接口是 ${origin}，已阻止发送`,
        );
      }
      return '';
    }
    return key;
  }

  hasApiKey(target: KeyTarget = 'llm'): boolean {
    return Boolean(this.getApiKey(target));
  }

  /**
   * 给界面用的密钥状态：有没有、是不是给现在这家用的、会不会重启就没了。
   *
   * 不再回传完整 Key —— 渲染层不需要它（所有请求都在主进程发），
   * 回传只会扩大暴露面。
   */
  keyStatus(target: KeyTarget = 'llm'): {
    present: boolean;
    masked: string;
    boundOrigin: string;
    currentOrigin: string;
    ownership: KeyOwnership;
    mismatch: boolean;
    unknown: boolean;
    ephemeral: boolean;
    message: string;
  } {
    const key = this.readKey(target);
    const binding = this.bindingOf(target);
    const origin = this.originFor(target);
    const ownership = keyOwnership(binding, origin);
    return {
      present: Boolean(key) && ownership === 'ok',
      masked: maskKey(key),
      boundOrigin: originOfBinding(binding),
      currentOrigin: origin,
      ownership,
      mismatch: Boolean(key) && ownership === 'mismatch',
      unknown: Boolean(key) && ownership === 'unknown',
      ephemeral: this.ephemeralKeys.has(target),
      // 归属有问题时给一句能照做的话（界面直接显示，不再自己拼文案）。
      message: key && ownership !== 'ok' ? ownershipMessage(ownership, originOfBinding(binding), origin) : '',
    };
  }

  /**
   * 语音识别用哪把 Key：
   * - 如果 STT 和 LLM 是同一台服务器（比如都用硅基流动），直接共用 LLM 的 Key；
   * - 否则用单独保存的 STT Key。
   */
  resolveSttKey(): string {
    const ai = this.data.ai;
    const sameServer =
      normalizeBaseURL(ai?.sttBaseURL ?? '') === normalizeBaseURL(ai?.baseURL ?? '');
    const sttKey = this.getApiKey('stt');
    if (sttKey) return sttKey;
    if (sameServer) return this.getApiKey('llm');
    return '';
  }

  keyInfo(): {
    llm: boolean;
    stt: boolean;
    sttShared: boolean;
    sttReady: boolean;
    encrypted: boolean;
    ephemeral: boolean;
    mismatch: boolean;
    unknown: boolean;
  } {
    const ai = this.data.ai;
    const sttShared =
      normalizeBaseURL(ai?.sttBaseURL ?? '') === normalizeBaseURL(ai?.baseURL ?? '');
    const llmStatus = this.keyStatus('llm');
    const sttStatus = this.keyStatus('stt');
    return {
      llm: llmStatus.present,
      stt: sttStatus.present,
      sttShared,
      // 注意：这里不能再 `|| sttShared`。
      // sttShared 只说明「语音识别和文字模型是同一台服务器，可以共用一把 Key」，
      // 不代表 Key 真的存在——否则一把 Key 都没填，界面也会显示「字幕可用」。
      // resolveSttKey() 已经包含「同源则回退到 LLM 的 Key」的逻辑。
      sttReady: Boolean(this.resolveSttKey()),
      encrypted: this.encryptionAvailable,
      ephemeral: this.ephemeralKeys.size > 0,
      mismatch: llmStatus.mismatch || sttStatus.mismatch,
      unknown: llmStatus.unknown || sttStatus.unknown,
    };
  }
}

let instance: SettingsStore | null = null;

export function getSettingsStore(): SettingsStore {
  if (!instance) instance = new SettingsStore();
  return instance;
}
