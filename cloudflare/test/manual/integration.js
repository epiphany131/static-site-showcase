// wrangler dev 集成验证脚本（手动运行）：
//   npm run dev            # 另开终端
//   node test/manual/integration.js http://127.0.0.1:8787
// 覆盖：登录双提交 CSRF、上传限制读取与修改、ZIP 上传/列表/下载/源码浏览、
//       粘贴代码创建、页面 CRUD、编辑者权限与 CSRF 拒绝。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';

const base = process.argv[2] || 'http://127.0.0.1:8787';
let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`✔ ${name}`); }
  else { failed += 1; console.error(`✖ ${name}${detail ? ` :: ${detail}` : ''}`); }
}

function cookiesOf(response) {
  const jar = {};
  for (const header of response.headers.getSetCookie?.() || []) {
    const [pair] = header.split(';');
    const index = pair.indexOf('=');
    jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return jar;
}

async function login(username, password) {
  const challenge = await fetch(`${base}/login`);
  let jar = cookiesOf(challenge);
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      Cookie: `zcode_login_csrf=${jar.zcode_login_csrf}`,
      'X-Login-CSRF-Token': jar.zcode_login_csrf,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ username, password })
  });
  jar = { ...jar, ...cookiesOf(response) };
  return { response, jar };
}

function authHeaders(jar, extra = {}) {
  return { Cookie: `__Host-zcode_session=${jar['__Host-zcode_session']};zcode_csrf=${jar.zcode_csrf}`, 'X-CSRF-Token': jar.zcode_csrf, ...extra };
}

function buildZipBytes(entries) {
  const encoder = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;
  const le = (bytes, at, value, size) => {
    const view = new DataView(bytes.buffer);
    if (size === 4) view.setUint32(at, value, true); else view.setUint16(at, value, true);
  };
  for (const entry of entries) {
    const raw = encoder.encode(entry.data);
    const compressed = deflateRawSync(raw, { level: 9 });
    const name = encoder.encode(entry.name);
    const crc = (() => {
      const table = new Int32Array(256);
      for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c; }
      let crcValue = 0xffffffff;
      for (const byte of raw) crcValue = table[(crcValue ^ byte) & 0xff] ^ (crcValue >>> 8);
      return (crcValue ^ 0xffffffff) >>> 0;
    })();
    const header = Buffer.alloc(30 + name.length);
    le(header, 0, 0x04034b50, 4); le(header, 4, 20, 2); le(header, 6, 0x0800, 2); le(header, 8, 8, 2);
    le(header, 10, 0, 2); le(header, 12, 0x21, 2); le(header, 14, crc, 4);
    le(header, 18, compressed.length, 4); le(header, 22, raw.length, 4);
    le(header, 26, name.length, 2); le(header, 28, 0, 2);
    header.set(name, 30);
    locals.push(header, compressed);
    const central = Buffer.alloc(46 + name.length);
    le(central, 0, 0x02014b50, 4); le(central, 4, 20, 2); le(central, 6, 20, 2);
    le(central, 8, 0x0800, 2); le(central, 10, 8, 2); le(central, 12, 0, 2); le(central, 14, 0x21, 2);
    le(central, 16, crc, 4); le(central, 20, compressed.length, 4); le(central, 24, raw.length, 4);
    le(central, 28, name.length, 2); le(central, 42, offset, 4);
    central.set(name, 46);
    centrals.push(central);
    offset += header.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const eocd = Buffer.alloc(22);
  le(eocd, 0, 0x06054b50, 4); le(eocd, 8, entries.length, 2); le(eocd, 10, entries.length, 2);
  le(eocd, 12, centralSize, 4); le(eocd, 16, offset, 4);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

async function main() {
  const health = await fetch(`${base}/health`);
  check('健康检查', health.status === 200, `status=${health.status}`);

  const admin = await login('dev_admin', 'dev-test-password-123456');
  check('管理员登录', admin.response.status === 200, `status=${admin.response.status}`);

  const badChallenge = cookiesOf(await fetch(`${base}/login`));
  const badLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      Cookie: `zcode_login_csrf=${badChallenge.zcode_login_csrf ?? ''}`,
      'X-Login-CSRF-Token': 'wrong',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ username: 'dev_admin', password: 'x' })
  });
  check('错误登录 CSRF 被拒绝', badLogin.status === 403, `status=${badLogin.status}`);

  const noAuth = await fetch(`${base}/api/upload-config`);
  check('未登录读取上传限制返回 401', noAuth.status === 401, `status=${noAuth.status}`);

  const config = await fetch(`${base}/api/upload-config`, { headers: authHeaders(admin.jar) });
  const configBody = await config.json();
  const inRange = configBody.uploads?.maxFileSize >= 1024 * 1024 && configBody.uploads?.maxFileSize <= 64 * 1024 * 1024;
  check('读取上传限制', config.status === 200 && inRange,
    `status=${config.status} body=${JSON.stringify(configBody).slice(0, 120)}`);

  const publicSettings = await (await fetch(`${base}/api/settings`)).json();
  check('公开设置不泄露 uploads', publicSettings.settings.uploads === undefined);

  const limitPatch = await fetch(`${base}/api/admin/settings`, {
    method: 'PATCH', headers: authHeaders(admin.jar, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ uploads: { maxFileSize: 1024 * 1024 } })
  });
  check('管理员修改上传限制', limitPatch.status === 200, `status=${limitPatch.status}`);
  const configAfterPatch = await fetch(`${base}/api/upload-config`, { headers: authHeaders(admin.jar) });
  const patchedBody = await configAfterPatch.json();
  check('修改后动态生效', patchedBody.uploads?.maxFileSize === 1024 * 1024, JSON.stringify(patchedBody).slice(0, 120));

  const editorCreate = await fetch(`${base}/api/users`, {
    method: 'POST', headers: authHeaders(admin.jar, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ username: 'dev_editor', password: 'editor-password-1', role: 'editor' })
  });
  check('创建编辑者（或已存在）', [201, 409].includes(editorCreate.status), `status=${editorCreate.status}`);
  const editor = await login('dev_editor', 'editor-password-1');
  check('编辑者登录', editor.response.status === 200, `status=${editor.response.status}`);

  const editorForbidden = await fetch(`${base}/api/admin/settings`, { headers: authHeaders(editor.jar) });
  check('编辑者访问管理设置被拒绝', editorForbidden.status === 403, `status=${editorForbidden.status}`);

  const zip = buildZipBytes([
    { name: 'index.html', data: '<h1>Workers 站点</h1><link rel="stylesheet" href="style.css">' },
    { name: 'style.css', data: 'h1{color:red}' }
  ]);
  const form = new FormData();
  form.append('name', '集成站点');
  form.append('file', new Blob([zip], { type: 'application/zip' }), 'site.zip');
  const upload = await fetch(`${base}/api/sites`, { method: 'POST', headers: authHeaders(editor.jar), body: form });
  const uploadBody = await upload.json();
  check('ZIP 上传成功', upload.status === 201, `status=${upload.status} body=${JSON.stringify(uploadBody).slice(0, 200)}`);
  const siteId = uploadBody.site?.id;

  const preview = await fetch(`${base}/sites/${siteId}/`, { headers: authHeaders(editor.jar) });
  const previewHtml = await preview.text();
  check('托管站点可访问且带沙箱 CSP（草稿需所有者会话）', preview.status === 200
    && previewHtml.includes('Workers 站点')
    && (preview.headers.get('content-security-policy') || '').startsWith('sandbox '), `status=${preview.status}`);
  const anonymousPreview = await fetch(`${base}/sites/${siteId}/`, { redirect: 'manual' });
  check('匿名访问草稿站点被拒绝', anonymousPreview.status === 404, `status=${anonymousPreview.status}`);

  const oversize = new FormData();
  oversize.append('name', '超限');
  oversize.append('file', new Blob([new Uint8Array(1024 * 1024 + 1)], { type: 'application/zip' }), 'big.zip');
  const oversizeResponse = await fetch(`${base}/api/sites`, { method: 'POST', headers: authHeaders(admin.jar), body: oversize });
  check('超过限制返回 413', oversizeResponse.status === 413, `status=${oversizeResponse.status}`);

  const publish = await fetch(`${base}/api/sites/${siteId}`, {
    method: 'PATCH', headers: authHeaders(editor.jar, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ published: true })
  });
  check('发布站点', publish.status === 200, `status=${publish.status}`);

  const files = await (await fetch(`${base}/api/gallery/${siteId}/files`)).json();
  check('源码文件列表', files.files?.some((file) => file.path === 'index.html'), JSON.stringify(files).slice(0, 150));

  const source = await (await fetch(`${base}/api/gallery/${siteId}/source?path=index.html`)).json();
  check('源码读取', String(source.source?.content).includes('Workers 站点'));

  const download = await fetch(`${base}/api/gallery/${siteId}/download`);
  const bytes = Buffer.from(await download.arrayBuffer());
  check('ZIP 下载', download.status === 200 && bytes.readUInt32LE(0) === 0x04034b50, `status=${download.status}`);

  const codeForm = new FormData();
  codeForm.append('name', '代码站点');
  codeForm.append('html', new Blob(['<main>粘贴成功</main>'], { type: 'text/html' }), 'index.html');
  const codeUpload = await fetch(`${base}/api/sites/code`, { method: 'POST', headers: authHeaders(editor.jar), body: codeForm });
  check('粘贴代码创建', codeUpload.status === 201, `status=${codeUpload.status}`);

  const gallery = await (await fetch(`${base}/api/gallery`)).json();
  check('公开画廊包含作品与作者', gallery.sites?.some((site) => site.id === siteId && site.ownerUsername === 'dev_editor'));

  const pageSlug = `workers-doc-${crypto.randomUUID().slice(0, 8)}`;
  const page = await fetch(`${base}/api/admin/pages`, {
    method: 'POST', headers: authHeaders(admin.jar, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ slug: pageSlug, title: 'Workers 文档', content: '# 你好', published: true })
  });
  const pageBody = await page.json();
  check('创建内容页面', page.status === 201, `status=${page.status} body=${JSON.stringify(pageBody).slice(0, 150)}`);

  const pageDetail = await (await fetch(`${base}/api/pages/${pageSlug}`)).json();
  check('内容页公开可读且渲染 Markdown', pageDetail.page?.contentHtml?.includes('<h1 id="你好">'));

  const noCsrf = await fetch(`${base}/api/users`, {
    method: 'POST', headers: { Cookie: `__Host-zcode_session=${admin.jar['__Host-zcode_session']}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'x1', password: 'password-1', role: 'editor' })
  });
  check('缺少 CSRF 被拒绝', noCsrf.status === 403, `status=${noCsrf.status}`);

  const pageTemplate = await fetch(`${base}/pages/${pageSlug}`);
  check('内容页模板可访问', pageTemplate.status === 200, `status=${pageTemplate.status}`);
  const adminPage = await fetch(`${base}/admin/`, { redirect: 'manual' });
  check('未登录后台重定向登录页', adminPage.status === 302, `status=${adminPage.status}`);
  const adminAuthed = await fetch(`${base}/admin/app.js`, { headers: authHeaders(admin.jar) });
  check('登录后可取后台脚本', adminAuthed.status === 200, `status=${adminAuthed.status}`);

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
