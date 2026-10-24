import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodeSite, MAX_CODE_FILE_SIZE, CODE_FIELDS } from '../src/code-site.js';

const encoder = new TextEncoder();
const file = (text) => ({ data: encoder.encode(text) });

test('HTML 片段生成完整站点并转义标题', () => {
  const result = buildCodeSite({
    html: file('<main>你好</main>'),
    css: file('body { color: red; }'),
    javascript: file('document.body.dataset.ready = "1";')
  }, '站点 <测试>');
  assert.deepEqual(Object.keys(result), ['index.html', 'style.css', 'script.js']);
  assert.match(result['index.html'], /^<!doctype html>/);
  assert.match(result['index.html'], /<meta charset="UTF-8">/);
  assert.match(result['index.html'], /<title>站点 &lt;测试&gt;<\/title>/);
  assert.match(result['index.html'], /<link rel="stylesheet" href="style\.css">/);
  assert.match(result['index.html'], /<main>你好<\/main>/);
  assert.match(result['index.html'], /<script src="script\.js"><\/script>/);
  assert.equal(result['style.css'], 'body { color: red; }');
  assert.equal(result['script.js'], 'document.body.dataset.ready = "1";');
});

test('带 doctype 的片段仍补齐文档结构', () => {
  const result = buildCodeSite({ html: file('<!doctype html><p>hi</p>') }, 'T');
  assert.match(result['index.html'], /<head>/);
});

test('完整 HTML 保持内容且不重复插入资源引用', () => {
  const html = '<!doctype html><html><head><link href="./style.css?v=1" rel="stylesheet"></head><body><script src="script.js#run"></script></body></html>';
  const result = buildCodeSite({ html: file(html), css: file('h1{}'), javascript: file('run()') }, 'T');
  assert.equal((result['index.html'].match(/style\.css/g) || []).length, 1);
  assert.equal((result['index.html'].match(/script\.js/g) || []).length, 1);
});

test('嵌套、根绝对和外部同名资源不冒充生成文件', () => {
  const html = '<html><head><link rel=stylesheet href=assets/style.css><link rel=stylesheet href=https://cdn.example/style.css></head><body><script src=/script.js></script><script src=assets/script.js></script></body></html>';
  const result = buildCodeSite({ html: file(html), css: file('body{}'), javascript: file('ready()') }, 'T', '/sites/site-id/');
  assert.match(result['index.html'], /href="style\.css"/);
  assert.match(result['index.html'], /src="script\.js"/);
  assert.equal((result['index.html'].match(/style\.css/g) || []).length, 3);
  assert.equal((result['index.html'].match(/script\.js/g) || []).length, 3);
});

test('base 元素存在时使用运行时加载器', () => {
  const html = '<!doctype html><html><head><base href="/app/"></head><body></body></html>';
  const result = buildCodeSite({ html: file(html), css: file('body{}'), javascript: file('run()') }, 'T');
  assert.match(result['index.html'], /new URL\("style\.css",location\.href\)/);
  assert.match(result['index.html'], /new URL\("script\.js",location\.href\)/);
});

test('校验与 Node 版一致：未知字段/NUL/无效 UTF-8/超限', () => {
  assert.throws(() => buildCodeSite({ html: file('<p>x</p>'), extra: file('x') }, 'T'), /不支持的文件字段/);
  assert.throws(() => buildCodeSite({}, 'T'), /请粘贴 HTML 代码/);
  assert.throws(() => buildCodeSite({ html: { data: Uint8Array.from([65, 0, 66]) } }, 'T'), /NUL/);
  assert.throws(() => buildCodeSite({ html: { data: Uint8Array.from([0xc3, 0x28]) } }, 'T'), /UTF-8/);
  assert.throws(
    () => buildCodeSite({ html: { data: new Uint8Array(MAX_CODE_FILE_SIZE + 1).fill(65) } }, 'T'),
    (error) => error.status === 413
  );
  // 三项各自 ≤512 KiB 时总量恒 ≤1.5 MiB，总量分支由单文件校验天然覆盖（与 Node 版一致）。
  assert.deepEqual([...CODE_FIELDS], ['html', 'css', 'javascript']);
});
