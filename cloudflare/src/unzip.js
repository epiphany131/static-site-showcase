// ZIP 解压：fflate 流式解压 + 移植自 lib/extract.js 的安全限制。
// 差异说明：Workers isolate 内存有限，解压后总量上限为 48 MiB（Node 版 200 MiB）；
// 其余限制（2000 条目 / 单条目 25 MiB / 压缩比 250 / 路径穿越防护 / 单层目录展开）语义一致。
import { Unzip, UnzipInflate } from 'fflate';

export const MAX_ENTRIES = 2000;
export const MAX_ENTRY_SIZE = 25 * 1024 * 1024;
export const MAX_EXTRACTED_SIZE = 48 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 250;

function zipError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 解析 ZIP 中央目录（EOCD 定位），取得每个条目的名称与压缩/原始大小，
 * 用于在解压前完成全部限制校验与单层目录展开判定。
 * @param {Uint8Array} data
 */
export function parseCentralDirectory(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  const minEocd = Math.max(0, data.length - 22 - 0xffff);
  for (let index = data.length - 22; index >= minEocd; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw zipError('ZIP_INVALID', '压缩包格式无效或文件不完整');
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > data.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw zipError('ZIP_INVALID', '压缩包格式无效或文件不完整');
    }
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const rawName = data.subarray(offset + 46, offset + 46 + nameLength);
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(rawName); } catch {
      name = new TextDecoder('utf-8').decode(rawName);
    }
    entries.push({ name, compressedSize, uncompressedSize });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * 移植自 extract.js 的 safeJoin：拒绝绝对路径、盘符与目录穿越，
 * 返回目标 R2 key（已带前缀），非法路径返回 null。
 * @param {string} prefix @param {string} entryPath
 */
export function safeTargetKey(prefix, entryPath) {
  const cleaned = entryPath.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(cleaned) || cleaned.startsWith('/')) return null;
  const segments = cleaned.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '..' || segment === '.')) return null;
  const resolved = [prefix.replace(/\/+$/, ''), ...segments].filter(Boolean).join('/');
  return `${resolved}`;
}

/**
 * 单层目录展开判定（移植自 flattenSingleRoot）：
 * 顶层可见项（排除 __MACOSX 与点开头）只有一个目录且其中含 index.html 时返回该目录名。
 * @param {Array<{ name: string }>} entries
 */
export function detectSingleRoot(entries) {
  const topLevel = new Map();
  for (const entry of entries) {
    const segments = entry.name.replace(/\\/g, '/').split('/').filter(Boolean);
    if (!segments.length) continue;
    const head = segments[0];
    if (head === '__MACOSX' || head.startsWith('.')) continue;
    topLevel.set(head, (topLevel.get(head) || 0) + 1);
  }
  if (topLevel.size !== 1) return null;
  const root = [...topLevel.keys()][0];
  const hasIndex = entries.some((entry) => {
    const normalized = entry.name.replace(/\\/g, '/');
    return normalized === `${root}/index.html`;
  });
  return hasIndex ? root : null;
}

/**
 * 解压 ZIP 到 R2 前缀。
 * @param {R2Bucket} bucket
 * @param {Uint8Array} data 完整 ZIP 字节（来自 formData 的 File）
 * @param {string} prefix 目标前缀，如 `sites/<id>`
 * @returns {Promise<{ written: number, skipped: string[], extractedSize: number, flattenedRoot: string | null }>}
 */
export async function extractZipToStorage(bucket, data, prefix) {
  const entries = parseCentralDirectory(data);
  const fileEntries = entries.filter((entry) => !entry.name.endsWith('/'));
  if (fileEntries.length > MAX_ENTRIES) {
    throw zipError('ZIP_TOO_MANY_FILES', `压缩包文件数量超过 ${MAX_ENTRIES} 个`);
  }
  let totalSize = 0;
  const skipped = [];
  for (const entry of fileEntries) {
    if (entry.uncompressedSize > MAX_ENTRY_SIZE) {
      throw zipError('ZIP_ENTRY_TOO_LARGE', `文件 ${entry.name} 解压后过大`);
    }
    const ratio = entry.compressedSize > 0 ? entry.uncompressedSize / entry.compressedSize : entry.uncompressedSize;
    if (ratio > MAX_COMPRESSION_RATIO) {
      throw zipError('ZIP_RATIO_TOO_HIGH', `文件 ${entry.name} 压缩比异常`);
    }
    totalSize += entry.uncompressedSize;
    if (totalSize > MAX_EXTRACTED_SIZE) {
      throw zipError('ZIP_TOO_LARGE', '压缩包解压后的总大小超过限制');
    }
    if (!safeTargetKey(prefix, entry.name)) skipped.push(entry.name);
  }

  const flattenedRoot = detectSingleRoot(entries);
  const targets = new Map();
  let written = 0;
  let extractedSize = 0;
  let writeChain = Promise.resolve();

  const unzipper = new Unzip((file) => {
    if (file.name.endsWith('/')) return;
    const name = file.name.replace(/\\/g, '/');
    const relative = flattenedRoot && name.startsWith(`${flattenedRoot}/`)
      ? name.slice(flattenedRoot.length + 1)
      : name;
    const key = safeTargetKey(prefix, relative);
    if (!key) return;
    targets.set(name, key);
    const chunks = [];
    let received = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      chunks.push(chunk);
      received += chunk.length;
      if (received > MAX_ENTRY_SIZE) {
        throw zipError('ZIP_ENTRY_TOO_LARGE', `文件 ${name} 解压后过大`);
      }
      if (final) {
        const content = new Uint8Array(received);
        let cursor = 0;
        for (const chunkItem of chunks) {
          content.set(chunkItem, cursor);
          cursor += chunkItem.length;
        }
        chunks.length = 0;
        writeChain = writeChain.then(async () => {
          await bucket.put(key, content, { httpMetadata: { contentType: 'application/octet-stream' } });
          written += 1;
          extractedSize += content.length;
        });
      }
    };
    file.start();
  });
  unzipper.register(UnzipInflate);
  try {
    unzipper.push(data, true);
  } catch (error) {
    if (error?.code?.startsWith('ZIP_')) throw error;
    throw zipError('ZIP_INVALID', '压缩包格式无效或文件不完整');
  }
  await writeChain;
  return { written, skipped, extractedSize, flattenedRoot };
}

export async function hasRootIndex(bucket, prefix) {
  const object = await bucket.head(`${prefix.replace(/\/+$/, '')}/index.html`);
  return Boolean(object);
}
