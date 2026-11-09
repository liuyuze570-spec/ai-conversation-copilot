/**
 * 「忠实中文转外语」输出闸门 + 数字近音 的回归单测。
 *
 * 背景（2026-11-10 真实三卡输出）：
 *   用户输入「请确认定金是450欧元，不是540欧元，余款周五支付。」，App 生成的三卡里
 *   第 2 条 english 字段整个是中文（`450欧元的定金，周五前付清尾款，确认了没？`），
 *   第 3 条还额外加了原文没有的追问 `When will you be here?`；近音行 450/540 是裸数字。
 *
 * 这两个问题的根因：
 *   1. parseReplyDrafts 只做结构校验（字段是不是字符串），不校验「字符串是不是对的语言」；
 *   2. readWord 把纯数字原样返回，绕过了 soundForNumberToken 的数字读法。
 *
 * 本文件钉住修复后的行为：
 *   A. 英文目标的 english 字段混进中文 → 整条卡被语言闸门丢掉；
 *   B. 数字 450/540 的近音不再是裸数字，而是「佛 汉卓德 菲夫提」这类汉字读音。
 *
 * import dist/ 里的产物 = 验证的就是真正会跑在用户机器上的那份代码。
 * 用法：node .dev/reply-fidelity-unit.mjs
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { replyInWrongLanguage, dropWrongLanguageDrafts } = require('../dist/services/llm/reply-parse.js');
const { buildHintPlan } = require('../dist/services/pronunciation.js');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass += 1;
  else { fail += 1; console.error(`  ✗ ${msg}`); }
}
function eq(a, b, msg) {
  ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，得到 ${JSON.stringify(a)}）`);
}

// ---- A. 目标语言闸门：英文正文里混进中文必须被拒 ----
eq(replyInWrongLanguage('450欧元的定金，周五前付清尾款，确认了没？', 'English'), true,
  'A 英文目标里整句中文 → 判语言错');
eq(replyInWrongLanguage('Got it, 450 euros for the deposit, not 540, and the balance by Friday?', 'English'), false,
  'A 英文目标里正常英文 → 判语言对');
eq(replyInWrongLanguage('Please confirm 450 euros, not 540 euros.', 'English'), false,
  'A 英文目标里含数字的英文 → 判语言对');
eq(replyInWrongLanguage('確認ですが、450ユーロで合っていますか。', 'Japanese'), false,
  'A 日语目标里日文 → 判语言对');
eq(replyInWrongLanguage('This is not Japanese', 'Japanese'), true,
  'A 日语目标里纯英文 → 判语言错');

// 三卡里混一张中文卡 → 只丢掉那张，保留其余英文卡
{
  const drafts = [
    { english: 'Got it, 450 euros for the deposit, not 540, and the balance by Friday?' },
    { english: '450欧元的定金，周五前付清尾款，确认了没？' },
    { english: 'Just to confirm: 450 euros as the deposit, and the rest by Friday.' },
  ];
  const { kept, dropped } = dropWrongLanguageDrafts(drafts, 'English');
  eq(kept.length, 2, 'A 三卡混一张中文 → 保留 2 张英文');
  eq(dropped, 1, 'A 丢掉的中文卡数 = 1');
  ok(!kept.some((d) => /[\u4e00-\u9fff]/.test(d.english)), 'A 保留的卡里没有中文');
}

// 全中文 → 全丢，调用方据此报错重试
{
  const drafts = [
    { english: '450欧元的定金' },
    { english: '余款周五支付' },
  ];
  const { kept, dropped } = dropWrongLanguageDrafts(drafts, 'English');
  eq(kept.length, 0, 'A 全中文 → 全丢');
  eq(dropped, 2, 'A 全中文丢 2 张');
}

// ---- B. 数字近音：450/540 不再是裸数字 ----
{
  const plan = buildHintPlan(
    'Please confirm the deposit is 450 euros, not 540 euros, and the balance is due Friday.',
    'English',
    'hanzi',
  );
  const seg450 = plan.segments.find((s) => s.source === '450');
  const seg540 = plan.segments.find((s) => s.source === '540');
  ok(seg450 && seg450.hint !== '450', 'B 450 不再是裸数字，有汉字读音');
  ok(seg540 && seg540.hint !== '540', 'B 540 不再是裸数字，有汉字读音');
  ok(/[\u4e00-\u9fff]/.test(seg450?.hint ?? ''), `B 450 近音是汉字（${seg450?.hint}）`);
  ok(/[\u4e00-\u9fff]/.test(seg540?.hint ?? ''), `B 540 近音是汉字（${seg540?.hint}）`);
  eq(seg450?.hint, '佛 汉卓德 菲夫提', 'B 450 → four hundred fifty');
  eq(seg540?.hint, '法伊夫 汉卓德 佛提', 'B 540 → five hundred forty');
}

// 时间数字也读对：`4:20` 会被分词成 `4` 和 `20` 两段，各自读成「佛」「特温提」
{
  const plan = buildHintPlan('The appointment is at 4:20 p.m.', 'English', 'hanzi');
  const four = plan.segments.find((s) => s.source === '4');
  const twenty = plan.segments.find((s) => s.source === '20');
  eq(four?.hint, '佛', 'B 4:20 的 4 读成「佛」');
  eq(twenty?.hint, '特温提', 'B 4:20 的 20 读成「特温提」');
  ok(plan.text.includes('佛 特温提'), `B 4:20 整句近音里有「佛 特温提」（${plan.text}）`);
}

console.log(`reply-fidelity: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
