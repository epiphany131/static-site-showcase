// 流式 ZIP 构建器：移植自 lib/zip.js 的 crc32、字节布局与敏感文件过滤。
// Node 版用 worker_threads + zlib + 落盘；Workers 版改为异步 generator，
// 逐文件从 R2 惰性读取（≤25MiB），经 CompressionStream('deflate-raw') 压缩，
// 以 ReadableStream 输出，内存占用恒定。

export const MAX_ENTRIES = 2000;
export const MAX_FILE_SIZE = 25 * 1024 * 1024;
export const MAX_TOTAL_SIZE = 200 * 1024 * 1024;

const BLOCKED_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.keystore', '.jks',
  '.crt', '.cer', '.der',
  '.map',
  '.lock',
]);

const BLOCKED_FILENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'poetry.lock',
]);

const BLOCKED_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

/** @param {Uint8Array} buffer */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function isSensitivePath(relPath) {
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment.startsWith('.')) return true;
  }
  const base = segments[segments.length - 1].toLowerCase();
  if (BLOCKED_FILENAMES.has(base)) return true;
  if (BLOCKED_PREFIXES.some((prefix) => base === prefix || base.startsWith(`${prefix}.`))) return true;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
  if (BLOCKED_EXTENSIONS.has(ext)) return true;
  return false;
}

export function sanitizeEntryName(relPath) {
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = cleaned.split('/').filter((segment) => segment && segment !== '.' && segment !== '..');
  return segments.join('/').replace(/[\x00-\x1f]/g, '_');
}

function extensionOf(base) {
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

/**
 * 从 R2 对象列表中筛选可打包文件并执行限制检查。
 * @param {Array<{ key: string, size: number }>} entries R2 list 结果（key 为 sites/<id>/... 前缀内的相对路径之外还带前缀，由调用方先剥离）
 * @param {{ includeFilter?: (relPath: string) => boolean }} options
 */
export function selectZipFiles(entries, options = {}) {
  const includeFilter = typeof options.includeFilter === 'function' ? options.includeFilter : null;
  const files = [];
  const skipped = [];
  let totalSize = 0;
  for (const entry of entries) {
    const relPath = entry.key.replace(/\\/g, '/');
    if (isSensitivePath(relPath) || (includeFilter && !includeFilter(relPath))) {
      skipped.push(relPath);
      continue;
    }
    if (files.length >= MAX_ENTRIES) {
      throw zipError('ZIP_TOO_MANY_FILES', `打包文件数量超过 ${MAX_ENTRIES} 个`);
    }
    if (entry.size > MAX_FILE_SIZE) {
      throw zipError('ZIP_FILE_TOO_LARGE', `文件超过 ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}MB 限制: ${relPath}`);
    }
    totalSize += entry.size;
    if (totalSize > MAX_TOTAL_SIZE) {
      throw zipError('ZIP_TOTAL_TOO_LARGE', `打包总大小超过 ${Math.floor(MAX_TOTAL_SIZE / 1024 / 1024)}MB`);
    }
    files.push({ key: entry.key, relPath, size: entry.size });
  }
  return { files, skipped };
}

function u16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { dosTime, dosDate };
}

/** @param {Uint8Array} data */
async function deflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 流式生成 ZIP 字节。files 的 data() 惰性加载，逐文件处理。
 * @param {Array<{ relPath: string, size: number, data: () => Promise<Uint8Array> }>} files
 * @returns {ReadableStream<Uint8Array>}
 */
export function zipStream(files) {
  const encoder = new TextEncoder();
  async function* generate() {
    const centralRecords = [];
    let offset = 0;
    let count = 0;
    for (const file of files) {
      const data = await file.data();
      if (data.length !== file.size) {
        throw zipError('ZIP_SOURCE_CHANGED', `打包期间文件发生变化: ${file.relPath}`);
      }
      const compressed = await deflateRaw(data);
      const crc = crc32(data);
      const nameBuffer = encoder.encode(sanitizeEntryName(file.relPath));
      if (nameBuffer.length === 0 || nameBuffer.length > 0xffff) {
        throw zipError('ZIP_INVALID_NAME', `文件名无效: ${file.relPath}`);
      }
      const { dosTime, dosDate } = dosDateTime(new Date());

      const header = new Uint8Array(30);
      const headerView = new DataView(header.buffer);
      headerView.setUint32(0, 0x04034b50, true);
      headerView.setUint16(4, 20, true);
      headerView.setUint16(6, 0x0800, true);
      headerView.setUint16(8, 8, true);
      headerView.setUint16(10, dosTime, true);
      headerView.setUint16(12, dosDate, true);
      headerView.setUint32(14, crc, true);
      headerView.setUint32(18, compressed.length, true);
      headerView.setUint32(22, data.length, true);
      headerView.setUint16(26, nameBuffer.length, true);
      headerView.setUint16(28, 0, true);
      yield header;

      yield nameBuffer;
      yield compressed;

      const central = new Uint8Array(46);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 8, true);
      centralView.setUint16(12, dosTime, true);
      centralView.setUint16(14, dosDate, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, compressed.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, nameBuffer.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, offset, true);
      centralRecords.push(central, nameBuffer.slice());

      offset += header.length + nameBuffer.length + compressed.length;
      count += 1;
    }

    const centralSize = centralRecords.reduce((sum, buf) => sum + buf.length, 0);
    for (const record of centralRecords) yield record;

    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(4, 0, true);
    eocdView.setUint16(6, 0, true);
    eocdView.setUint16(8, count, true);
    eocdView.setUint16(10, count, true);
    eocdView.setUint32(12, centralSize, true);
    eocdView.setUint32(16, offset, true);
    eocdView.setUint16(20, 0, true);
    yield eocd;
  }

  const iterator = generate();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    }
  });
}
