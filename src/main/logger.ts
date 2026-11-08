import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { LogEntry, LogLevel } from '../shared/types';

const MAX_MEMORY_ENTRIES = 500;
const MAX_FILE_BYTES = 1024 * 512;

let logDir: string | null = null;
let logFile: string | null = null;
const memory: LogEntry[] = [];

function ensureLogFile(): string {
  if (logFile) return logFile;
  logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  logFile = path.join(logDir, 'app.log');
  return logFile;
}

/** Never log secrets: strip anything that looks like an API key. */
function sanitize(message: string): string {
  return message.replace(/(sk-[A-Za-z0-9_-]{6,})/g, 'sk-***');
}

/**
 * 把一个异常压成「只够定位、不泄露内容」的一小段。
 *
 * 为什么不能直接 `String(error)`：
 * - 服务商报错时会把**请求体**回显在响应里（400/422 很常见），那里面有
 *   用户说的话和译文；`HttpError` 的 message 是 `HTTP_402: <detail>`，
 *   一打印就等于把对话写进了 app.log。
 * - 审计要求日志「只记录状态、错误码、字符数和耗时」。
 *
 * 所以：有状态码就只留状态码（402 没钱、401 Key 错、429 限流 —— 定位够用），
 * 其余错误留 name + 截断 message。给用户看的详细原因走界面提示，不进日志。
 */
export function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return `HTTP_${status}`;
    const name = (error as { name?: unknown }).name;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      const label = typeof name === 'string' ? name : 'Error';
      return `${label}: ${message.slice(0, 80)}`;
    }
  }
  return String(error).slice(0, 80);
}

function write(entry: LogEntry) {
  memory.push(entry);
  if (memory.length > MAX_MEMORY_ENTRIES) memory.shift();

  try {
    const file = ensureLogFile();
    const line = `${new Date(entry.timestamp).toISOString()} [${entry.level}] [${entry.scope}] ${entry.message}\n`;
    fs.appendFileSync(file, line, 'utf8');
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) {
      const content = fs.readFileSync(file, 'utf8').split('\n');
      fs.writeFileSync(file, content.slice(-200).join('\n'), 'utf8');
    }
  } catch {
    // Logging must never break the app.
  }

  const prefix = `[${entry.level}] [${entry.scope}]`;
  if (entry.level === 'ERROR') console.error(prefix, entry.message);
  else if (entry.level === 'WARN') console.warn(prefix, entry.message);
  else console.log(prefix, entry.message);
}

export function log(level: LogLevel, scope: string, message: string) {
  write({ level, scope, message: sanitize(message), timestamp: Date.now() });
}

export const logger = {
  info: (scope: string, message: string) => log('INFO', scope, message),
  warn: (scope: string, message: string) => log('WARN', scope, message),
  error: (scope: string, message: string) => log('ERROR', scope, message),
  /**
   * 只进控制台，**不写 app.log**。
   *
   * 给「每条噪声都要说一句」的碎日志用（例如短噪声被丢弃）。这类信息在
   * 开发时有用，但正式日志里一天能刷几千行，把真正的问题埋掉 ——
   * 而正式日志现在还要满足「不含对话正文」的隐私要求，越短越好。
   */
  debug: (scope: string, message: string) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[DEBUG] [${scope}]`, sanitize(message));
    }
  },
  tail: (count = 100): LogEntry[] => memory.slice(-count),
  logDir: () => logDir,
};
