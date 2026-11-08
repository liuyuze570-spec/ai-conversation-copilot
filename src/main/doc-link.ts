import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 给随包分发的教学文档拼出「带小节锚点」的 file URL。
 *
 * 为什么需要它：
 * 1. 教程是一整页长文档（十几屏），新手点「怎么申请 Key？」时如果不带锚点，
 *    要自己在上万字里翻找自己选的那一家 —— 这正是最容易劝退的一步。
 * 2. 浏览器只认规范的 `file:///C:/...` 形式，直接拿 Windows 路径拼 `file://`
 *    会得到 `file:///C:\...`（反斜杠没转义），Chromium 直接报 ERR_FAILED。
 *    所以统一走 `pathToFileURL`，中文文件名也会被正确百分号编码。
 * 3. 锚点必须是 ASCII（教程里用 `provider-zhipu` 这种 id），这里仍做一次
 *    `encodeURIComponent` 兜底，避免以后加中文 id 时拼出非法 URL。
 */
export function docFileUrl(docPath: string, anchor?: string): string {
  const base = pathToFileURL(path.resolve(docPath)).href;
  const trimmed = (anchor ?? '').trim();
  return trimmed ? `${base}#${encodeURIComponent(trimmed)}` : base;
}
