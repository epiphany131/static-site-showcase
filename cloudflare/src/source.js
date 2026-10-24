// 源码在线浏览：过滤规则与限制从 lib/source.js 原样移植，I/O 层改为 R2。
const MAX_FILES = 300;
const MAX_DEPTH = 8;
export const MAX_SOURCE_FILE_SIZE = 512 * 1024;

const ALLOWED_EXTENSIONS = new Map([
  ['.html', 'html'], ['.htm', 'html'], ['.css', 'css'], ['.scss', 'scss'],
  ['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'],
  ['.ts', 'typescript'], ['.tsx', 'typescript'], ['.jsx', 'javascript'],
  ['.json', 'json'], ['.md', 'markdown'], ['.txt', 'plaintext'],
  ['.svg', 'xml'], ['.xml', 'xml'], ['.yml', 'yaml'], ['.yaml', 'yaml']
]);
const BLOCKED_NAMES = new Set([
  '.env', '.env.local', '.env.production', '.env.development',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'
]);
const BLOCKED_EXTENSIONS = new Set([
  '.map', '.pem', '.key', '.crt', '.cer', '.p12', '.pfx', '.jks', '.keystore'
]);

function sourceError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/** @param {string} value */
export function normalizeSourcePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw sourceError('INVALID_PATH', '无效的文件路径');
  }
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw sourceError('INVALID_PATH', '无效的文件路径');
  }
  const segments = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) throw sourceError('INVALID_PATH', '无效的文件路径');
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const clean = segments.join('/');
  if (!clean) throw sourceError('INVALID_PATH', '无效的文件路径');
  return clean;
}

/** @param {string} relativePath */
export function inspectPath(relativePath) {
  const clean = normalizeSourcePath(relativePath);
  const segments = clean.split('/');
  const fileName = segments[segments.length - 1].toLowerCase();
  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 ? fileName.slice(dot) : '';
  if (segments.length > MAX_DEPTH || segments.some((segment) => segment.startsWith('.'))) {
    return { allowed: false, clean };
  }
  if (BLOCKED_NAMES.has(fileName) || BLOCKED_EXTENSIONS.has(extension)) {
    return { allowed: false, clean };
  }
  const language = ALLOWED_EXTENSIONS.get(extension);
  return { allowed: Boolean(language), clean, language };
}

function extensionOf(name) {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot > 0 ? lower.slice(dot) : '';
}

/**
 * 列出可展示的源码文件。
 * @param {R2Bucket} bucket @param {string} sitePrefix 如 `sites/<id>`
 */
export async function listSourceFiles(bucket, sitePrefix) {
  const files = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: `${sitePrefix.replace(/\/+$/, '')}/`, cursor, limit: 1000 });
    for (const object of page.objects) {
      if (files.length >= MAX_FILES) break;
      const relative = object.key.slice(sitePrefix.length + 1);
      if (!relative || relative.split('/').some((segment) => segment.startsWith('.'))) continue;
      const inspected = inspectPath(relative);
      if (!inspected.allowed) continue;
      if (object.size <= MAX_SOURCE_FILE_SIZE) {
        files.push({ path: inspected.clean, language: inspected.language, size: object.size });
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && files.length < MAX_FILES);

  files.sort((a, b) => {
    if (a.path === 'index.html') return -1;
    if (b.path === 'index.html') return 1;
    return a.path.localeCompare(b.path);
  });
  return files.slice(0, MAX_FILES);
}

/**
 * 读取单个源码文件。
 * @param {R2Bucket} bucket @param {string} sitePrefix @param {string} relativePath
 */
export async function readSourceFile(bucket, sitePrefix, relativePath) {
  const inspected = inspectPath(relativePath);
  if (!inspected.allowed) throw sourceError('FILE_NOT_ALLOWED', '该文件不可展示', 403);
  const key = `${sitePrefix.replace(/\/+$/, '')}/${inspected.clean}`;
  const object = await bucket.get(key);
  if (!object) throw sourceError('FILE_NOT_FOUND', '文件不存在', 404);
  if (object.size > MAX_SOURCE_FILE_SIZE) throw sourceError('FILE_TOO_LARGE', '文件过大，无法在线展示', 413);
  const buffer = new Uint8Array(await object.arrayBuffer());
  for (const byte of buffer) {
    if (byte === 0) throw sourceError('BINARY_FILE', '二进制文件不可展示', 415);
  }
  return {
    path: inspected.clean, language: inspected.language, size: object.size,
    content: new TextDecoder().decode(buffer)
  };
}

export { ALLOWED_EXTENSIONS, BLOCKED_NAMES, BLOCKED_EXTENSIONS, extensionOf };
