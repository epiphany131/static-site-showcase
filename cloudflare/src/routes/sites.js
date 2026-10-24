// 站点路由：ZIP 上传、粘贴代码、列表与增删改。移植自 app.js 对应段落。
import { buildCodeSite, MAX_CODE_FILE_SIZE, CODE_FIELDS } from '../code-site.js';
import { extractZipToStorage, hasRootIndex } from '../unzip.js';
import { putSiteFiles, deleteSiteFiles } from '../storage.js';
import { adminSite } from './users.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownerFilter(c) {
  return c.get('auth').user.role === 'admin' ? undefined : c.get('auth').user.id;
}

async function managedSite(c, db) {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return null;
  return db.getSiteById(id, ownerFilter(c));
}

/**
 * @param {import('hono').Hono} app
 * @param {{ db: import('../db.js').Database, auth: ReturnType<import('../auth.js').createAuth> }} ctx
 */
export function registerSiteRoutes(app, { db, auth }) {
  app.post('/api/sites', auth.csrf, async (c) => {
    const settings = await db.getSettings();
    const maxFileSize = settings.uploads.maxFileSize;
    let form;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: '上传数据格式无效' }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File) || Array.from(form.getAll('file')).length !== 1) {
      return c.json({ error: '请选择一个 ZIP 文件' }, 400);
    }
    if (file.size > maxFileSize) {
      return new Response(`ZIP 文件不能超过 ${Math.round(maxFileSize / 1024 / 1024)} MiB`, {
        status: 413, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      return c.json({ error: '只支持 ZIP 格式文件' }, 400);
    }
    const bodyName = form.get('name');
    const description = form.get('description');
    if ((bodyName !== null && typeof bodyName !== 'string') || (description !== null && typeof description !== 'string')
      || [...form.keys()].some((key) => !['file', 'name', 'description'].includes(key))) {
      return c.json({ error: '站点信息格式无效' }, 400);
    }
    const name = String(bodyName || file.name.replace(/\.zip$/i, '')).trim().slice(0, 120);
    if (!name) return c.json({ error: '站点名称不能为空' }, 400);

    const id = crypto.randomUUID();
    const prefix = `sites/${id}`;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await extractZipToStorage(c.env.BUCKET, bytes, prefix);
      if (!(await hasRootIndex(c.env.BUCKET, prefix))) {
        const notFound = new Error('压缩包根目录未找到 index.html');
        notFound.status = 400;
        throw notFound;
      }
      const site = await db.createSite({
        id, name,
        description: String(description || '').trim().slice(0, 500),
        path: `/${prefix}`
      }, c.get('auth').user.id);
      return c.json({ success: true, site: adminSite(site), ...result }, 201);
    } catch (error) {
      await deleteSiteFiles(c.env.BUCKET, id);
      if (error.status) return c.json({ error: error.message }, error.status);
      if (String(error.code || '').startsWith('ZIP_')) return c.json({ error: error.message }, 400);
      return c.json({ error: '文件上传失败' }, 500);
    }
  });

  app.post('/api/sites/code', auth.csrf, async (c) => {
    let form;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: '请使用 multipart/form-data 提交代码' }, 400);
    }
    const nameValue = form.get('name');
    const descriptionValue = form.get('description');
    if (typeof nameValue !== 'string'
      || (descriptionValue !== null && typeof descriptionValue !== 'string')) {
      return c.json({ error: '站点信息格式无效' }, 400);
    }
    const keys = [...form.keys()];
    if (keys.some((key) => !['name', 'description', ...CODE_FIELDS].includes(key))) {
      return c.json({ error: '代码上传包含不支持的表单字段' }, 400);
    }
    for (const field of CODE_FIELDS) {
      const values = form.getAll(field);
      if (values.length > 1) return c.json({ error: `${field} 只能提交一次` }, 400);
    }
    const files = {};
    for (const field of CODE_FIELDS) {
      const value = form.get(field);
      if (value === null) continue;
      if (!(value instanceof File)) return c.json({ error: `${field} 内容无效` }, 400);
      if (value.size > MAX_CODE_FILE_SIZE) return c.json({ error: `${field} 不能超过 512 KiB` }, 413);
      files[field] = { data: new Uint8Array(await value.arrayBuffer()) };
    }
    const name = String(nameValue).trim().slice(0, 120);
    if (!name) return c.json({ error: '站点名称不能为空' }, 400);

    const id = crypto.randomUUID();
    try {
      const generated = buildCodeSite(files, name, `/sites/${id}/`);
      await putSiteFiles(c.env.BUCKET, id, generated);
    } catch (error) {
      await deleteSiteFiles(c.env.BUCKET, id);
      return c.json({ error: error.status ? error.message : '代码上传失败' }, error.status || 500);
    }
    try {
      const site = await db.createSite({
        id, name,
        description: String(descriptionValue || '').trim().slice(0, 500),
        path: `/sites/${id}`
      }, c.get('auth').user.id);
      return c.json({ success: true, site: adminSite(site) }, 201);
    } catch {
      await Promise.all([
        db.deleteSite(id).catch(() => {}),
        deleteSiteFiles(c.env.BUCKET, id)
      ]);
      return c.json({ error: '代码上传失败' }, 500);
    }
  });

  app.get('/api/sites', auth.required, async (c) => {
    const sites = await db.getAllSites(ownerFilter(c));
    return c.json({ success: true, sites: sites.map(adminSite) });
  });

  app.get('/api/sites/:id', auth.required, async (c) => {
    const site = await managedSite(c, db);
    return site ? c.json({ success: true, site: adminSite(site) }) : c.json({ error: '网站不存在' }, 404);
  });

  app.patch('/api/sites/:id', auth.csrf, async (c) => {
    const current = await managedSite(c, db);
    if (!current) return c.json({ error: '网站不存在' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const updates = {};
    if (Object.hasOwn(body, 'published')) updates.published = body.published === true;
    if (Object.hasOwn(body, 'sourceVisible')) updates.source_visible = body.sourceVisible === true;
    if (Object.hasOwn(body, 'name')) {
      updates.name = String(body.name).trim().slice(0, 120);
      if (!updates.name) return c.json({ error: '站点名称不能为空' }, 400);
    }
    if (Object.hasOwn(body, 'description')) updates.description = String(body.description).trim().slice(0, 500);
    const site = await db.updateSite(current.id, updates, ownerFilter(c));
    return c.json({ success: true, site: adminSite(site) });
  });

  app.delete('/api/sites/:id', auth.csrf, async (c) => {
    const site = await managedSite(c, db);
    if (!site) return c.json({ error: '网站不存在' }, 404);
    await deleteSiteFiles(c.env.BUCKET, site.id);
    await db.deleteSite(site.id, ownerFilter(c));
    return c.json({ success: true });
  });

  app.get('/api/upload-config', auth.required, async (c) => {
    const settings = await db.getSettings();
    c.header('Cache-Control', 'no-store');
    return c.json({
      success: true,
      uploads: {
        maxFileSize: settings.uploads.maxFileSize,
        minFileSize: 1024 * 1024,
        maxAllowedFileSize: 64 * 1024 * 1024
      }
    });
  });
}
