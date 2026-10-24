import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCentralDirectory, extractZipToStorage, detectSingleRoot, safeTargetKey,
  MAX_ENTRY_SIZE
} from '../src/unzip.js';
import { zipStream, crc32 } from '../src/zip.js';
import { createMockBucket } from '../test-helpers/mock-bucket.js';

const encoder = new TextEncoder();

async function buildZipBytes(entries) {
  const files = entries
    .filter((entry) => !entry.name.endsWith('/'))
    .map((entry) => ({ relPath: entry.name, size: entry.data.length, data: async () => entry.data }));
  const chunks = [];
  const reader = zipStream(files).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }
  return bytes;
}

// 手工构造 method=0（stored）的 ZIP，可包含 zipStream 会清洗掉的恶意条目名。
function buildStoredZip(entries) {
  const view = (length) => new DataView(new ArrayBuffer(length));
  function le(bytes, offset, value, size) {
    const view2 = new DataView(bytes.buffer);
    if (size === 4) view2.setUint32(offset, value, true);
    else view2.setUint16(offset, value, true);
  }
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data ?? new Uint8Array(0);
    const crc = crc32(data);
    const header = new Uint8Array(30 + nameBytes.length);
    le(header, 0, 0x04034b50, 4);
    le(header, 4, 20, 2);
    le(header, 6, 0, 2);
    le(header, 8, 0, 2);
    le(header, 10, 0, 2);
    le(header, 12, 0x21, 2);
    le(header, 14, crc, 4);
    le(header, 18, data.length, 4);
    le(header, 22, data.length, 4);
    le(header, 26, nameBytes.length, 2);
    le(header, 28, 0, 2);
    header.set(nameBytes, 30);
    locals.push(header, data);

    const central = new Uint8Array(46 + nameBytes.length);
    le(central, 0, 0x02014b50, 4);
    le(central, 4, 20, 2);
    le(central, 6, 20, 2);
    le(central, 8, 0, 2);
    le(central, 10, 0, 2);
    le(central, 12, 0, 2);
    le(central, 14, 0x21, 2);
    le(central, 16, crc, 4);
    le(central, 20, data.length, 4);
    le(central, 24, data.length, 4);
    le(central, 28, nameBytes.length, 2);
    le(central, 30, 0, 2);
    le(central, 32, 0, 2);
    le(central, 34, 0, 2);
    le(central, 36, 0, 2);
    le(central, 38, 0, 4);
    le(central, 42, offset, 4);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += header.length + data.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const eocd = new Uint8Array(22);
  le(eocd, 0, 0x06054b50, 4);
  le(eocd, 8, entries.length, 2);
  le(eocd, 10, entries.length, 2);
  le(eocd, 12, centralSize, 4);
  le(eocd, 16, offset, 4);
  const all = [...locals, ...centrals, eocd];
  const total = all.reduce((sum, item) => sum + item.length, 0);
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const item of all) {
    bytes.set(item, cursor);
    cursor += item.length;
  }
  void view;
  return bytes;
}

test('safeTargetKey 拒绝穿越与绝对路径', () => {
  assert.equal(safeTargetKey('sites/x', '../evil.txt'), null);
  assert.equal(safeTargetKey('sites/x', '/abs.txt'), null);
  assert.equal(safeTargetKey('sites/x', 'C:\\abs.txt'), null);
  assert.equal(safeTargetKey('sites/x', 'a/../../b.txt'), null);
  assert.equal(safeTargetKey('sites/x', 'assets/app.css'), 'sites/x/assets/app.css');
});

test('detectSingleRoot 仅在单目录含 index.html 时展开', () => {
  const entries = (names) => names.map((name) => ({ name }));
  assert.equal(detectSingleRoot(entries(['site/index.html', 'site/a.js'])), 'site');
  assert.equal(detectSingleRoot(entries(['site/index.html', 'other.js'])), null);
  assert.equal(detectSingleRoot(entries(['site/a.js'])), null);
  assert.equal(detectSingleRoot(entries(['.hidden', 'site/index.html'])), 'site');
});

test('extractZipToStorage 平铺结构直接写入并统计', async () => {
  const bucket = createMockBucket();
  const zip = await buildZipBytes([
    { name: 'index.html', data: encoder.encode('<h1>ok</h1>') },
    { name: 'style.css', data: encoder.encode('body{}') }
  ]);
  const result = await extractZipToStorage(bucket, zip, 'sites/test-id');
  assert.equal(result.written, 2);
  assert.equal(result.flattenedRoot, null);
  assert.deepEqual([...bucket._objects.keys()].sort(), ['sites/test-id/index.html', 'sites/test-id/style.css']);
  const stored = await bucket.get('sites/test-id/index.html');
  assert.equal(new TextDecoder().decode(stored.value), '<h1>ok</h1>');
});

test('extractZipToStorage 自动展开单层包装目录', async () => {
  const bucket = createMockBucket();
  const zip = await buildZipBytes([
    { name: 'wrapper/index.html', data: encoder.encode('<h1>wrapped</h1>') },
    { name: 'wrapper/app.js', data: encoder.encode('run()') }
  ]);
  const result = await extractZipToStorage(bucket, zip, 'sites/wrapped');
  assert.equal(result.flattenedRoot, 'wrapper');
  assert.deepEqual([...bucket._objects.keys()].sort(), ['sites/wrapped/app.js', 'sites/wrapped/index.html']);
});

test('extractZipToStorage 拦截目录穿越条目且不落盘', async () => {
  const bucket = createMockBucket();
  const zip = buildStoredZip([
    { name: 'index.html', data: encoder.encode('safe') },
    { name: '../evil.txt', data: encoder.encode('evil') }
  ]);
  const result = await extractZipToStorage(bucket, zip, 'sites/traversal');
  assert.equal(result.written, 1);
  assert.deepEqual(result.skipped, ['../evil.txt']);
  assert.deepEqual([...bucket._objects.keys()], ['sites/traversal/index.html']);
});

test('解析器拒绝无效 ZIP 数据', () => {
  assert.throws(() => parseCentralDirectory(new Uint8Array(64)), /压缩包格式无效/);
});

test('压缩比与条目大小限制在解压前拦截', async () => {
  const bucket = createMockBucket();
  // 大块零字节可压缩出极高压缩比（约 10000:1），超过 250 限制
  const bomb = await buildZipBytes([{ name: 'zeros.bin', data: new Uint8Array(MAX_ENTRY_SIZE) }]);
  await assert.rejects(
    () => extractZipToStorage(bucket, bomb, 'sites/bomb'),
    (error) => error.code === 'ZIP_RATIO_TOO_HIGH'
  );
  assert.equal(bucket._objects.size, 0);
});
