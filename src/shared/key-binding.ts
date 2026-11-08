/**
 * 密钥与服务商的绑定规则。
 *
 * 为什么需要它：Key 是「按服务商发的」，把智谱的 Key 发给硅基流动，对方只
 * 会回 401。而旧实现只按 `llm` / `stt` 两个槽位存 Key，**完全不记这把 Key
 * 属于谁** —— 用户从 A 家切到 B 家，旧 Key 照样被塞进 Authorization 头发出去。
 *
 * 后果有两层：
 * 1. 功能上必然报「Key 不对」，用户以为是 Key 复制错了。
 * 2. 隐私上更糟：这把本来只该给 A 家的凭证，被主动送给了 B 家。
 *
 * ## 为什么用完整 origin 而不是主机名
 *
 * 0.3.6 只比对了 `hostname`。同一条主机名换个端口就是**另一台服务**
 * （`127.0.0.1:11434` 是 Ollama、`127.0.0.1:8000` 可能是别人的网关），
 * 而协议从 https 降到 http 更是把 Key 直接暴露在链路上。所以绑定和比对都用
 * `scheme://host[:port]`。
 *
 * 规则抽成纯函数，是为了能用单测钉死（见 .dev/reliability-unit.mjs B 段）。
 */

export interface KeyBinding {
  /**
   * 保存 Key 时接口地址的完整 origin，例如 `https://api.siliconflow.cn`
   * 或 `http://127.0.0.1:11434`（本机服务才会是 http）。
   */
  origin: string;
  /** 保存 Key 时的服务商 id（自定义网关就是 'custom'）。 */
  providerId: string;
  /** 保存时间（毫秒时间戳）。 */
  at: number;
  /**
   * 旧字段（0.3.6 及以前）：只有主机名，没有协议和端口。
   * 读到时由 `originOfBinding()` 换算，写回时不再产生它。
   */
  host?: string;
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

/**
 * 把用户随手写的地址规范化成 `scheme://host[:port]`。
 *
 * - 没写协议 → 按 https 处理（和界面上的默认值一致）
 * - 主机名小写
 * - 默认端口（http:80 / https:443）省略，避免 `https://a` 和 `https://a:443`
 *   被当成两台不同的机器
 * - 解析不出来返回空串
 */
export function bindingOriginOf(raw: string): string {
  const value = (raw || '').trim();
  if (!value) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    const host = url.hostname.toLowerCase();
    if (!host) return '';
    const port = url.port && url.port !== DEFAULT_PORTS[url.protocol] ? `:${url.port}` : '';
    return `${url.protocol}//${host}${port}`;
  } catch {
    return '';
  }
}

/** 只要主机名（给界面展示 / 日志用）。 */
export function bindingHostOf(raw: string): string {
  const origin = bindingOriginOf(raw);
  if (!origin) return '';
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}

/**
 * 一个已存的绑定对应哪个 origin。
 *
 * 兼容 0.3.6 的 `{host}` 写法：那时没记协议，只能按 https + 默认端口推断。
 * 迁移时如果主机名和当前地址一致，会直接用当前 origin 覆盖它。
 */
export function originOfBinding(binding: KeyBinding | undefined): string {
  if (!binding) return '';
  if (binding.origin) return binding.origin;
  if (binding.host) return `https://${binding.host.toLowerCase()}`;
  return '';
}

export type KeyOwnership =
  /** 有绑定且与当前地址一致。 */
  | 'ok'
  /** 有绑定，但属于另一台服务器。 */
  | 'mismatch'
  /** 有 Key 但没有任何归属记录（早期版本 / 手工改过配置）。 */
  | 'unknown';

/**
 * 这把 Key 现在能不能用。
 *
 * `unknown` 也算不能用 —— 审计要求「密钥归属未知或不匹配时停止使用」。
 * 迁移逻辑会在启动时把已知归属补齐，所以正常升级的用户不会落到这一档。
 *
 * 比对保持**严格**（协议、主机、端口全都要一致）。唯一的例外在迁移阶段处理：
 * `followSchemeUpgrade()` 会把「同一个主机的 http 绑定」改写成 https，之后
 * 仍旧按严格 origin 比对 —— 这样规则本身没有被放宽。
 */
export function keyOwnership(
  binding: KeyBinding | undefined,
  currentOrigin: string,
): KeyOwnership {
  const bound = originOfBinding(binding);
  if (!bound) return 'unknown';
  const current = bindingOriginOf(currentOrigin);
  if (!current) return 'mismatch';
  return bound === current ? 'ok' : 'mismatch';
}

/** 兼容旧调用：能不能用。 */
export function keyBelongsTo(binding: KeyBinding | undefined, currentOrigin: string): boolean {
  return keyOwnership(binding, currentOrigin) === 'ok';
}

function splitOrigin(origin: string): { scheme: string; host: string; port: string } | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    const scheme = url.protocol.replace(':', '').toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;
    const port = url.port && url.port !== DEFAULT_PORTS[url.protocol] ? url.port : '';
    return { scheme, host: url.hostname.toLowerCase(), port };
  } catch {
    return null;
  }
}

/**
 * 绑定是否可以「跟随一次 scheme 升级」。
 *
 * 场景：老版本配置里写的是 `http://api.siliconflow.cn/v1`，Key 被绑定到
 * `http://api.siliconflow.cn`。启动时 `migrateEndpoints()` 会把公网明文地址
 * 升级成 https（这一步本身是对的），于是当前 origin 变成
 * `https://api.siliconflow.cn` —— 按严格比对就成了「不匹配」，用户明明没换
 * 服务商，Key 却被停用，提示还写着同一台机器，看起来像 bug。
 *
 * 所以这里只放行 **http → https、主机和端口都不变** 这一种情况：往同一个
 * 服务器的加密连接上发 Key 不会多暴露一点，而绑定记录也会被就地改写成 https，
 * 之后仍旧按严格 origin 比对。
 *
 * **反方向（https → http）永远不跟随**：那是降级，等于把 Key 明文发上链路。
 *
 * 返回要写回的新 origin；不需要改写时返回空串。
 */
export function followSchemeUpgrade(
  binding: KeyBinding | undefined,
  currentOrigin: string,
): string {
  const bound = splitOrigin(originOfBinding(binding));
  const current = splitOrigin(bindingOriginOf(currentOrigin));
  if (!bound || !current) return '';
  if (bound.scheme !== 'http' || current.scheme !== 'https') return '';
  if (bound.host !== current.host || bound.port !== current.port) return '';
  return `${current.scheme}://${current.host}${current.port ? ':' + current.port : ''}`;
}

/**
 * 给界面看的脱敏 Key。
 *
 * 原则：只露「够你认出是哪一把」的字符数，永远不回传完整 Key 到渲染层。
 * 渲染层根本不需要完整 Key（所有网络请求都在主进程发），回传只会扩大暴露面。
 */
export function maskKey(key: string): string {
  const value = (key || '').trim();
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/** Key 不能用的原因，给用户看的一句话。 */
export function ownershipMessage(
  ownership: KeyOwnership,
  boundOrigin: string,
  currentOrigin: string,
): string {
  if (ownership === 'unknown') {
    return (
      '这把 Key 没有归属记录（可能来自更早的版本，或设置文件被手工改过）。' +
      '为了避免把它发到不确定的服务器，这次不会发送 —— 请在「设置 → API 功能」里重新粘贴一次。'
    );
  }
  return (
    `已保存的 Key 属于 ${boundOrigin || '另一家服务商'}，而你现在的接口地址是 ` +
    `${currentOrigin || '(空)'}。为了避免把旧 Key 发给新的服务商，这次不会发送它 —— ` +
    `请重新粘贴这家服务商的 Key。`
  );
}

/** 保留旧名字，避免调用点散落修改。 */
export function mismatchMessage(boundOrigin: string, currentOrigin: string): string {
  return ownershipMessage('mismatch', boundOrigin, currentOrigin);
}
