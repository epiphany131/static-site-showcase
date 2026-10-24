import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, selectZipFiles, zipStream, isSensitivePath, sanitizeEntryName, MAX_ENTRIES, MAX_FILE_SIZE } from '../src/zip.js';
import { parseCentralDirectory } from '../src/unzip.js';

const encoder = new TextEncoder();

test('crc32 符合标准测试向量', () => {
  assert.equal(crc32(encoder.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('敏感路径过滤与 Node 版语义一致', () => {
  for (const blocked of ['.env', 'a/.git/config', 'id_rsa', 'sub/id_rsa.pub', 'server.pem', 'app.js.map', 'package-lock.json']) {
    assert.equal(isSensitivePath(blocked), true, blocked);
  }
  for (const allowed of ['index.html', 'assets/app.css', 'readme.txt', 'public/style.css']) {
    assert.equal(isSensitivePath(allowed), false, allowed);
  }
});

test('sanitizeEntryName 清理路径与控制字符', () => {
  assert.equal(sanitizeEntryName('\\a\\b/../c.txt'), 'a/b/c.txt');
  assert.equal(sanitizeEntryName('/x/'), 'x');
  assert.equal(sanitizeEntryName('bad\x00name.txt'), 'bad_name.txt');
});

test('selectZipFiles 执行敏感过滤、数量与总量限制', () => {
  const entries = [
    { key: 'index.html', size: 10 },
    { key: '.env', size: 5 },
    { key: 'app.js', size: 20 },
    { key: 'server.key', size: 3 }
  ];
  const { files, skipped } = selectZipFiles(entries);
  assert.deepEqual(files.map((file) => file.relPath), ['index.html', 'app.js']);
  assert.deepEqual(skipped, ['.env', 'server.key']);
  assert.throws(() => selectZipFiles([{ key: 'a.txt', size: MAX_FILE_SIZE + 1 }]), /文件超过/);
  // 每个文件都在单文件限制内，叠加后触发总量限制
  const many24MiB = Array.from({ length: 9 }, (_, index) => ({ key: `f${index}.txt`, size: 24 * 1024 * 1024 }));
  assert.throws(() => selectZipFiles(many24MiB), /打包总大小/);
  const many = Array.from({ length: MAX_ENTRIES + 1 }, (_, index) => ({ key: `f${index}.txt`, size: 1 }));
  assert.throws(() => selectZipFiles(many), /文件数量/);
});

async function buildZip(entries) {
  const files = entries.map((entry) => ({
    relPath: entry.name,
    size: entry.data.length,
    data: async () => entry.data
  }));
  const chunks = [];
  const stream = zipStream(files);
  const reader = stream.getReader();
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

test('zipStream 输出可被中央目录解析且内容完整', async () => {
  const bytes = await buildZip([
    { name: 'index.html', data: encoder.encode('<h1>你好</h1>') },
    { name: 'assets/app.js', data: encoder.encode('console.log("ok")') },
    { name: 'empty.bin', data: new Uint8Array(0) }
  ]);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  const entries = parseCentralDirectory(bytes);
  assert.deepEqual(entries.map((entry) => entry.name), ['index.html', 'assets/app.js', 'empty.bin']);
  assert.equal(entries[0].uncompressedSize, encoder.encode('<h1>你好</h1>').length);
  assert.equal(entries[2].uncompressedSize, 0);
});
