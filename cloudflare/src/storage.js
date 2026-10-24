// R2 存储助手：站点文件、托管站点响应头、品牌资源。
const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads';

/**
 * 写入站点文件集合。
 * @param {R2Bucket} bucket @param {string} siteId
 * @param {Record<string, string | Uint8Array>} files
 */
export async function putSiteFiles(bucket, siteId, files) {
  for (const [name, content] of Object.entries(files)) {
    const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    await bucket.put(`sites/${siteId}/${name}`, body, {
      httpMetadata: { contentType: guessContentType(name) }
    });
  }
}

/** @param {R2Bucket} bucket @param {string} siteId */
export async function deleteSiteFiles(bucket, siteId) {
  const prefix = `sites/${siteId}/`;
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    await Promise.all(page.objects.map((object) => bucket.delete(object.key)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/**
 * 读取托管站点对象；统一附加沙箱 CSP 与 nosniff。
 * @param {R2Bucket} bucket @param {string} siteId @param {string} pathname
 */
export async function serveSiteObject(bucket, siteId, pathname) {
  const relative = decodeURIComponent(pathname).replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = relative.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    return new Response('页面不存在', { status: 404 });
  }
  const key = `sites/${siteId}/${segments.join('/') || 'index.html'}`;
  let object = await bucket.get(key);
  if (!object && segments.length) {
    // 目录式访问回退到该目录下的 index.html（与 express.static 行为一致）
    object = await bucket.get(`${key}/index.html`);
  }
  if (!object) return new Response('页面不存在', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Security-Policy', SANDBOX_CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('ETag', object.httpEtag);
  return new Response(object.body, { headers });
}

/**
 * 读取品牌资源（immutable 长缓存）。
 * @param {R2Bucket} bucket @param {string} filename
 */
export async function serveBrandingObject(bucket, filename) {
  if (!/^[0-9a-f]{64}\.(png|jpg|webp)$/.test(filename)) {
    return new Response('Not Found', { status: 404 });
  }
  const object = await bucket.get(`branding/${filename}`);
  if (!object) return new Response('Not Found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}

function guessContentType(name) {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot) : '';
  const map = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
  };
  return map[ext] || 'application/octet-stream';
}
