/**
 * 组装「随安装包一起发给朋友」的便携 Python 音频运行时。
 *
 * 为什么需要它
 * ------------
 * 软件靠一个 Python 小程序抓系统声音（WASAPI 回环）。开发机上 Python 是
 * 现装的，但朋友的电脑上没有 —— 那就变成「软件装好了，音量条却永远不动」
 * 这种最难解释的故障。所以这里把一份便携版 Python + 采集用的几个库一起
 * 打进安装包，朋友那边什么都不用装。
 *
 * 产物：vendor/python-runtime/
 *   python.exe            便携解释器（无注册表、无安装、可随包分发）
 *   python313.zip         标准库
 *   python313._pth        路径配置（把 Lib/site-packages 加进搜索路径）
 *   Lib/site-packages/    numpy / soundcard / cffi / pycparser
 *   msvcp140.dll 等       VC++ 运行库（numpy 的 C 扩展要用）
 *
 * 实现说明：整条流程只用 Node 内置能力（fetch + zlib 自解 zip + fs），
 * 不 spawn 任何外部进程。宿主沙箱会拦掉子进程创建（EBUSY），脚本一旦
 * 依赖外部命令在这里就完全跑不了。
 *
 * 用法：
 *   node scripts/prepare-python-runtime.js            # 已存在则跳过
 *   node scripts/prepare-python-runtime.js --force    # 强制重新组装
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PY_VERSION = '3.13.7';
const PY_SHORT = PY_VERSION.split('.').slice(0, 2).join(''); // "313"

/** 国内镜像优先：python.org 在国内经常只有几十 KB/s。 */
const DOWNLOAD_URLS = [
  `https://mirrors.aliyun.com/python-release/windows/python-${PY_VERSION}-embed-amd64.zip`,
  `https://registry.npmmirror.com/-/binary/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`,
  `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`,
];

/** 采集只用这几个包，其余（PIL / streamlit / altair…）一律不带。 */
const PACKAGES = ['numpy', 'numpy.libs', 'soundcard', 'cffi', 'pycparser'];
/** 带 ABI 标签的扩展模块（cffi 的 .pyd 直接放在 site-packages 根）。 */
const LOOSE_PATTERNS = [/^_cffi_backend\..*\.pyd$/i];
/** numpy / cffi 的 C 扩展依赖 VC++ 运行库，embeddable 包里通常只带一半。 */
const VC_DLLS = [
  'msvcp140.dll',
  'msvcp140_1.dll',
  'msvcp140_2.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'concrt140.dll',
];

const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, 'vendor', 'python-runtime');
const siteDir = path.join(runtimeDir, 'Lib', 'site-packages');
const force = process.argv.includes('--force');

// --------------------------------------------------------------------------- //
// zip 解压（纯 JS，不调用外部命令）
// --------------------------------------------------------------------------- //

/** 读 ZIP 中央目录，返回条目列表。 */
function readZipEntries(buffer) {
  let eocd = -1;
  const scanFrom = Math.max(0, buffer.length - 66000);
  for (let i = buffer.length - 22; i >= scanFrom; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractZip(buffer, destDir) {
  let files = 0;
  for (const entry of readZipEntries(buffer)) {
    if (entry.name.endsWith('/')) continue;
    const header = entry.localOffset;
    if (buffer.readUInt32LE(header) !== 0x04034b50) throw new Error('zip 本地头损坏');
    const nameLen = buffer.readUInt16LE(header + 26);
    const extraLen = buffer.readUInt16LE(header + 28);
    const dataStart = header + 30 + nameLen + extraLen;
    const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    const data = entry.method === 0 ? raw : zlib.inflateRawSync(raw);
    const target = path.join(destDir, entry.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    files += 1;
  }
  return files;
}

// --------------------------------------------------------------------------- //
// 依赖来源 / 杂项
// --------------------------------------------------------------------------- //

/** 已经装好 numpy + soundcard 的 site-packages（从本机现成环境里搬）。 */
function findSourceSitePackages() {
  const candidates = [
    process.env.PY_SITE,
    'C:/Users/25344/.workbuddy/binaries/python/envs/default/Lib/site-packages',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, 'numpy')) &&
      fs.existsSync(path.join(candidate, 'soundcard'))
    ) {
      return candidate;
    }
  }
  return null;
}

async function download(urls) {
  let lastError = '';
  for (const url of urls) {
    try {
      process.stdout.write(`[py-runtime] 下载 ${url}\n`);
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 5_000_000) {
        lastError = `文件过小（${buffer.length} 字节），疑似被劫持`;
        continue;
      }
      process.stdout.write(`[py-runtime] 已下载 ${(buffer.length / 1048576).toFixed(1)}MB\n`);
      return buffer;
    } catch (error) {
      lastError = String(error);
    }
  }
  throw new Error(`全部下载源失败：${lastError}`);
}

/** 删掉包内的 tests 目录：运行时不加载，能省十几 MB。 */
function pruneTests(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === 'tests') {
      fs.rmSync(full, { recursive: true, force: true });
      continue;
    }
    pruneTests(full);
  }
}

/**
 * 递归复制。
 *
 * 不用 `fs.cpSync(..., { recursive: true })`：在宿主沙箱里它对**目录**会
 * 静默什么都不做（不报错、也不建目标），单文件才正常 —— 这种「悄悄失败」
 * 最坑，所以自己走 readdir + copyFile，每一步都可验证。
 */
function copyTree(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      copyTree(path.join(from, entry.name), path.join(to, entry.name));
    }
    return;
  }
  fs.copyFileSync(from, to);
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

(async () => {
  const stamp = path.join(runtimeDir, '.ready');
  if (fs.existsSync(stamp) && !force) {
    const mb = (dirSize(runtimeDir) / 1048576).toFixed(1);
    console.log(`[py-runtime] 已就绪（${mb}MB），跳过。要重装请加 --force`);
    return;
  }

  const source = findSourceSitePackages();
  if (!source) {
    throw new Error(
      '找不到装好 numpy + soundcard 的 site-packages。请先 pip install soundcard numpy，或用 PY_SITE 指定。',
    );
  }
  console.log(`[py-runtime] 依赖来源: ${source}`);

  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const zipBuffer = await download(DOWNLOAD_URLS);
  const files = extractZip(zipBuffer, runtimeDir);
  console.log(`[py-runtime] 已解压 ${files} 个文件`);

  // ---- 依赖包 -------------------------------------------------------- //
  fs.mkdirSync(siteDir, { recursive: true });
  for (const pkg of PACKAGES) {
    const from = path.join(source, pkg);
    if (!fs.existsSync(from)) {
      console.warn(`[py-runtime] 跳过（源里没有）：${pkg}`);
      continue;
    }
    copyTree(from, path.join(siteDir, pkg));
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (LOOSE_PATTERNS.some((re) => re.test(entry.name))) {
      fs.copyFileSync(path.join(source, entry.name), path.join(siteDir, entry.name));
    }
  }

  pruneTests(siteDir);

  // ---- VC++ 运行库（numpy 的 .pyd 依赖） ----------------------------- //
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  for (const dll of VC_DLLS) {
    const from = path.join(system32, dll);
    const to = path.join(runtimeDir, dll);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      try {
        fs.copyFileSync(from, to);
      } catch (error) {
        console.warn(`[py-runtime] 复制 ${dll} 失败（可忽略）：${String(error)}`);
      }
    }
  }

  // ---- 搜索路径 ------------------------------------------------------ //
  // embeddable 版默认不启用 site，也不认识 Lib/site-packages —— 必须显式写进去。
  fs.writeFileSync(
    path.join(runtimeDir, `python${PY_SHORT}._pth`),
    [`python${PY_SHORT}.zip`, '.', 'Lib\\site-packages', ''].join('\n'),
    'utf8',
  );

  const mb = (dirSize(runtimeDir) / 1048576).toFixed(1);
  fs.writeFileSync(stamp, `${PY_VERSION} ${new Date().toISOString()}\n`, 'utf8');
  console.log(`[py-runtime] 完成：${runtimeDir}（${mb}MB）`);
  console.log(
    `[py-runtime] 请手动自检一次：\n  "${path.join(runtimeDir, 'python.exe')}" -c "import numpy, soundcard; print('OK', numpy.__version__)"`,
  );
})().catch((error) => {
  console.error(`[py-runtime] 失败：${error.message}`);
  process.exit(1);
});
