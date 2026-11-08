import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const { docFileUrl } = require('../dist/main/doc-link.js');

let n = 0;
let fail = 0;
const eq = (actual, expected, msg) => {
  n++;
  try { assert.strictEqual(actual, expected); }
  catch { fail++; console.log(`  FAIL ${msg}\n    实际: ${actual}\n    期望: ${expected}`); }
};
const ok = (cond, msg, extra) => {
  n++;
  if (!cond) { fail++; console.log(`  FAIL ${msg}${extra ? ' -> ' + extra : ''}`); }
};

const doc = 'F://3D打印Rhino 7.0\\2026-09-30-23-01-15\\docs\\新手连接免费模型教程.html';

// 1) 基本形态
const plain = docFileUrl(doc);
ok(plain.startsWith('file:///'), '以 file:/// 开头（三个斜杠）', plain.slice(0, 12));
ok(!plain.includes('\\'), '不出现反斜杠（旧的 ERR_FAILED 根因）', plain);
ok(!plain.includes('#'), '不带锚点时没有 #');
ok(plain.endsWith('.html'), '以 .html 结尾');

// 2) 中文文件名被百分号编码
ok(plain.includes('%E6%96%B0%E6%89%8B'), '中文文件名已编码', plain.slice(-60));
eq(decodeURIComponent(plain.split('/').pop()), '新手连接免费模型教程.html', '解码后文件名不变');

// 3) 锚点
const withAnchor = docFileUrl(doc, 'provider-zhipu');
eq(withAnchor, plain + '#provider-zhipu', 'ASCII 锚点原样拼接');
const parsed = new URL(withAnchor);
eq(parsed.hash, '#provider-zhipu', '浏览器解析出的 hash 正确');
eq(parsed.protocol, 'file:', '协议是 file:');

// 4) 特殊字符与空格
const spaced = docFileUrl(doc, '  provider-volces  ');
eq(new URL(spaced).hash, '#provider-volces', '锚点首尾空格被 trim');
eq(docFileUrl(doc, 'a b').split('#')[1], 'a%20b', '空格被编码');
eq(decodeURIComponent(new URL(docFileUrl(doc, 'a b')).hash.slice(1)), 'a b', '解码回到原锚点');

// 5) 空锚点等于不带锚点
eq(docFileUrl(doc, ''), plain, '空串锚点 = 纯文件地址');
eq(docFileUrl(doc, '   '), plain, '纯空格锚点 = 纯文件地址');

// 6) 九家服务商 id 都能生成合法 URL（与 providers.ts 一致）
const ids = ['siliconflow','modelscope','zhipu','moonshot','deepseek','dashscope','hunyuan','volces','stepfun'];
for (const id of ids) {
  const u = docFileUrl(doc, `provider-${id}`);
  ok(u.startsWith('file:///') && u.endsWith(`#provider-${id}`) && !u.includes('\\'), `服务商 ${id} 的链接合法`);
}

// 7) 相对路径也能归一成绝对路径（防以后有人传相对路径）
const rel = docFileUrl('docs/x.html', 'a');
eq(new URL(rel).protocol, 'file:', '相对路径也被解析成 file URL');
ok(path.isAbsolute(decodeURIComponent(new URL(rel).pathname.replace(/^\//, ''))), '相对路径已转成绝对路径', rel);

console.log(fail === 0 ? `RESULT PASS ${n}/${n}` : `RESULT FAIL ${fail}/${n}`);
process.exit(fail === 0 ? 0 : 1);
