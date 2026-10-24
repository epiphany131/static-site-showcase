import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSourcePath, inspectPath, listSourceFiles, readSourceFile } from '../src/source.js';
import { createMockBucket } from './helpers/mock-bucket.js';

test('normalizeSourcePath 拒绝穿越、绝对路径与 NUL', () => {
  // 反斜杠归一后以 / 开头的路径同样视为绝对路径（与 Node 版 path.posix.isAbsolute 语义一致）
  for (const bad of ['', null, 42, 'a\0b', '/abs.txt', 'C:/x.txt', '..', 'a/../../b', '\\a\\b.txt']) {
    assert.throws(() => normalizeSourcePath(bad), /无效的文件路径/, String(bad));
  }
  assert.equal(normalizeSourcePath('a/./b/../c.js'), 'a/c.js');
  assert.equal(normalizeSourcePath('./index.html'), 'index.html');
});

test('inspectPath 执行扩展名白名单与敏感文件过滤', () => {
  assert.equal(inspectPath('index.html').allowed, true);
  assert.equal(inspectPath('assets/app.css').language, 'css');
  assert.equal(inspectPath('main.js').language, 'javascript');
  for (const blocked of ['.env', 'package-lock.json', 'server.pem', 'app.js.map', '.hidden/a.js', 'a/b/c/d/e/f/g/h/i.js']) {
    assert.equal(inspectPath(blocked).allowed, false, blocked);
  }
});

async function seedBucket() {
  const bucket = createMockBucket();
  await bucket.put('sites/s1/index.html', new TextEncoder().encode('<h1>ok</h1>'));
  await bucket.put('sites/s1/assets/app.css', new TextEncoder().encode('body{}'));
  await bucket.put('sites/s1/.env', new TextEncoder().encode('SECRET=1'));
  await bucket.put('sites/s1/app.js.map', new TextEncoder().encode('{}'));
  await bucket.put('sites/s1/data.txt', Uint8Array.from([104, 0, 105]));
  return bucket;
}

test('listSourceFiles 只返回白名单内且非敏感的文件', async () => {
  const bucket = await seedBucket();
  const files = await listSourceFiles(bucket, 'sites/s1');
  assert.deepEqual(files.map((file) => file.path).sort(), ['assets/app.css', 'data.txt', 'index.html']);
  const index = files.find((file) => file.path === 'index.html');
  assert.equal(index.language, 'html');
});

test('readSourceFile 返回内容并拒绝二进制与越权路径', async () => {
  const bucket = await seedBucket();
  const file = await readSourceFile(bucket, 'sites/s1', 'index.html');
  assert.equal(file.content, '<h1>ok</h1>');
  assert.equal(file.language, 'html');
  await assert.rejects(() => readSourceFile(bucket, 'sites/s1', '../s2/index.html'), /无效的文件路径/);
  await assert.rejects(() => readSourceFile(bucket, 'sites/s1', 'data.txt'), (error) => error.status === 415);
  await assert.rejects(() => readSourceFile(bucket, 'sites/s1', 'app.js.map'), (error) => error.status === 403);
  await assert.rejects(() => readSourceFile(bucket, 'sites/s1', '.env'), (error) => error.status === 403);
  await assert.rejects(() => readSourceFile(bucket, 'sites/s1', 'missing.css'), (error) => error.status === 404);
});
