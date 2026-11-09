/**
 * 接口级回归：真实模型译文 → 关键信息一致性 → 事实卡 → 确认句。
 *
 * 为什么单独有这个脚本：单测用的是固定字符串，能证明「检查函数对给定输入
 * 判断正确」，但不能证明「模型现在这批输出会被正确判断」。2026-11-08 出现
 * 过的两个问题恰好都在接缝上：
 *   1. 译文写成 `12 000`（空格千分位），金额正则认不出 → 事实卡错配；
 *   2. `valueNumbers` 读不出 `twelve thousand` → 确认句被判「没有可确认的内容」。
 *
 * 用法（需要本机服务已启动）：
 *   node webapp/e2e/api-facts.mjs [http://127.0.0.1:8000]
 *
 * 退出码 0 表示：所有应当能生成确认句的句子都生成出来了，且没有把已否定的
 * 旧值当成当前理解。报警一致性问题不算失败（那正是功能该做的事），但会逐条打印。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const { extractFactsWithRules, planConfirmSentence } = require(
  path.join(root, 'dist/shared/facts.js'),
);
const { checkNumericConsistency } = require(path.join(root, 'dist/shared/numeric-check.js'));

const base = process.argv[2] || 'http://127.0.0.1:8000';

/** 这四句必须能出确认句；前后两句是比赛中被指出问题的原句。 */
const CASES = [
  { text: 'The budget is twelve thousand, not twenty thousand.', mustConfirm: true },
  { text: 'The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m.', mustConfirm: true },
  { text: 'Please send the report by 3 p.m. tomorrow.', mustConfirm: true },
  { text: 'The train leaves at seven forty-five from platform two.', mustConfirm: false },
  { text: 'The delivery is not on Friday. It will arrive next Monday at 9 a.m.', mustConfirm: true },
];

async function session() {
  const res = await fetch(`${base}/api/session`, { method: 'POST' });
  if (!res.ok) throw new Error(`session ${res.status}`);
  const cookie = res.headers.get('set-cookie');
  if (!cookie) throw new Error('没有拿到会话 Cookie');
  return cookie.split(';')[0];
}

async function translate(cookie, text) {
  const res = await fetch(`${base}/api/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ text, from: 'en', to: 'zh' }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

function summarizeFact(f) {
  return `${f.kind}=${f.value}${f.negated ? '(否定)' : ''}/${f.sourceField}`;
}

const failures = [];
const lines = [];

const cookie = await session();
for (const c of CASES) {
  const out = await translate(cookie, c.text);
  const zh = out.translation;
  const facts = extractFactsWithRules({ originalText: c.text, translatedText: zh });
  const numeric = checkNumericConsistency(c.text, zh);

  const current = facts
    .filter((f) => !f.negated)
    .map((f) => ({
      id: `${f.kind}-${f.value}`,
      kind: f.kind,
      value: f.value,
      sourceText: f.sourceText,
      negated: Boolean(f.negated),
      certainty: f.certainty,
    }));
  const plan = planConfirmSentence(current, 'zh', 'Chinese');

  lines.push('');
  lines.push(`原文  ${c.text}`);
  lines.push(`译文  ${zh}   (${out.elapsed_ms}ms, ${out.mode})`);
  lines.push(`事实  ${facts.map(summarizeFact).join(' | ') || '（无）'}`);
  lines.push(`一致性  ${numeric.level}${numeric.message ? ` — ${numeric.message}` : ''}`);
  lines.push(`确认句  ${plan.ok ? plan.sentence : `生成不了：${plan.message}`}`);
  if (plan.ok && plan.meaning) lines.push(`释义  ${plan.meaning}`);

  if (c.mustConfirm && !plan.ok) {
    failures.push(`「${c.text}」应当能出确认句，实际：${plan.message}`);
  }
  // 已否定的旧值绝对不能出现在确认句里（原文说了「不是两万」，就不能念两万）。
  for (const f of facts.filter((x) => x.negated)) {
    if (plan.sentence.includes(f.value)) {
      failures.push(`「${c.text}」确认句里出现了被否定的旧值 ${f.value}：${plan.sentence}`);
    }
  }
  // 数值对应关系：原文里的每个数值都该在译文里找得到（找不到就说明译文丢了信息）。
  for (const missing of numeric.numbers.missing) {
    lines.push(`  · 译文里缺少数值 ${missing}`);
  }
}

console.log(lines.join('\n'));
console.log('');
if (failures.length) {
  console.log(`RESULT FAIL ${failures.length}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`RESULT PASS ${CASES.length}/${CASES.length}`);
