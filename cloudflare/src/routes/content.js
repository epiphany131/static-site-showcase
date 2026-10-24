// 内容页面、全站设置与公开作品路由：移植自 app.js 对应段落。
import { renderMarkdown } from '../../../lib/markdown.js';
import { patchSettings, projectPublicSettings } from '../settings.js';
import { saveBrandAsset, deleteBrandAsset } from '../image.js';
import { listSourceFiles, readSourceFile } from '../source.js';
import { selectZipFiles, zipStream } from '../zip.js';

function publicPageSummary(page) {
  return {
    id: page.id, slug: page.slug, title: page.title, category: page.category,
    excerpt: page.excerpt, type: page.type, url: `/pages/${page.slug}`,
    createdAt: page.created_at, updatedAt: page.updated_at
  };
}

function pageError(c, error) {
  const conflict = /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(error.message || '');
  return c.json({ error: conflict ? 'slug 已被使用' : error.message }, conflict ? 409 : 400);
}

/**
 * @param {import('hono').Hono} app
 * @param {{ db: import('../db.js').Database, auth: ReturnType<import('../auth.js').createAuth> }} ctx
 */
export function registerContentRoutes(app, { db, auth }) {
  // ---------- 公开内容 ----------
  app.get('/api/pages', async (c) => {
    const category = typeof c.req.query('category') === 'string' ? c.req.query('category') : undefined;
    const pages = await db.getPublishedPages(category);
    return c.json({ success: true, pages: pages.map(publicPageSummary) });
  });

  app.get('/api/pages/:slug', async (c) => {
    const page = await db.getPageBySlug(c.req.param('slug'), true);
    if (!page) return c.json({ error: '页面不存在或尚未发布' }, 404);
    const rendered = renderMarkdown(page.content);
    const adjacent = await db.getAdjacentPages(page);
    return c.json({
      success: true,
      page: {
        ...publicPageSummary(page), contentHtml: rendered.contentHtml, toc: rendered.toc,
        prev: adjacent.prev ? publicPageSummary(adjacent.prev) : null,
        next: adjacent.next ? publicPageSummary(adjacent.next) : null
      }
    });
  });

  app.get('/api/articles', async (c) => {
    const category = typeof c.req.query('category') === 'string' ? c.req.query('category') : undefined;
    const pages = await db.getPublishedPages(category);
    return c.json({ success: true, articles: pages.map(publicPageSummary) });
  });

  app.get('/api/articles/:slug', async (c) => {
    const page = await db.getPageBySlug(c.req.param('slug'), true);
    if (!page) return c.json({ error: '文章不存在或尚未发布' }, 404);
    const rendered = renderMarkdown(page.content);
    const adjacent = await db.getAdjacentPages(page);
    return c.json({
      success: true,
      article: {
        ...publicPageSummary(page), contentHtml: rendered.contentHtml, toc: rendered.toc,
        prev: adjacent.prev ? publicPageSummary(adjacent.prev) : null,
        next: adjacent.next ? publicPageSummary(adjacent.next) : null
      }
    });
  });

  app.get('/api/gallery', async (c) => {
    const sites = await db.getPublishedSites();
    return c.json({ success: true, sites: sites.map((site) => ({
      id: site.id, name: site.name, description: site.description,
      previewUrl: `/sites/${site.id}/`, detailUrl: `/works/${site.id}`,
      sourceVisible: site.source_visible, ownerUsername: site.owner_username,
      createdAt: site.created_at, updatedAt: site.updated_at
    })) });
  });

  app.get('/api/gallery/:id', async (c) => {
    const id = c.req.param('id');
    const site = /^[0-9a-f-]{36}$/i.test(id) ? await db.getSiteById(id) : null;
    if (!site?.published) return c.json({ error: '作品不存在或尚未发布' }, 404);
    return c.json({ success: true, site: {
      id: site.id, name: site.name, description: site.description,
      previewUrl: `/sites/${site.id}/`, detailUrl: `/works/${site.id}`,
      sourceVisible: site.source_visible, ownerUsername: site.owner_username,
      createdAt: site.created_at, updatedAt: site.updated_at
    } });
  });

  app.get('/api/gallery/:id/files', async (c) => {
    const id = c.req.param('id');
    const site = /^[0-9a-f-]{36}$/i.test(id) ? await db.getSiteById(id) : null;
    if (!site?.published) return c.json({ error: '作品不存在' }, 404);
    if (!site.source_visible) return c.json({ error: '该作品未公开源代码' }, 403);
    return c.json({ success: true, files: await listSourceFiles(c.env.BUCKET, `sites/${site.id}`) });
  });

  app.get('/api/gallery/:id/source', async (c) => {
    const id = c.req.param('id');
    const site = /^[0-9a-f-]{36}$/i.test(id) ? await db.getSiteById(id) : null;
    if (!site?.published) return c.json({ error: '作品不存在' }, 404);
    if (!site.source_visible) return c.json({ error: '该作品未公开源代码' }, 403);
    try {
      return c.json({ success: true, source: await readSourceFile(c.env.BUCKET, `sites/${site.id}`, c.req.query('path')) });
    } catch (error) {
      return c.json({ error: error.message }, error.status || 500);
    }
  });

  app.get('/api/gallery/:id/download', async (c) => {
    const id = c.req.param('id');
    const site = /^[0-9a-f-]{36}$/i.test(id) ? await db.getSiteById(id) : null;
    if (!site?.published) return c.json({ error: '作品不存在' }, 404);
    if (!site.source_visible) return c.json({ error: '该作品未公开源代码' }, 403);
    const prefix = `sites/${site.id}`;
    const page = await c.env.BUCKET.list({ prefix: `${prefix}/`, limit: 1000 });
    const entries = page.objects.map((object) => ({ key: object.key.slice(prefix.length + 1), size: object.size }));
    let selected;
    try {
      selected = selectZipFiles(entries);
    } catch (error) {
      return c.json({ error: error.message }, String(error.code || '').startsWith('ZIP_') ? 413 : 500);
    }
    const files = selected.files.map((file) => ({
      relPath: file.relPath,
      size: file.size,
      data: async () => {
        const object = await c.env.BUCKET.get(`${prefix}/${file.relPath}`);
        return new Uint8Array(await object.arrayBuffer());
      }
    }));
    const encoded = encodeURIComponent(`${site.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')}.zip`);
    c.header('Cache-Control', 'no-store');
    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="project.zip"; filename*=UTF-8''${encoded}`);
    return c.body(zipStream(files));
  });

  // ---------- 页面管理 ----------
  app.get('/api/admin/pages', auth.admin, async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ success: true, pages: await db.getAllPages() });
  });

  app.post('/api/admin/pages/preview', auth.admin, auth.csrf, async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const validated = db.validatePage({ content: body.content }, true);
      c.header('Cache-Control', 'no-store');
      return c.json({ success: true, ...renderMarkdown(validated.content) });
    } catch (error) {
      return c.json({ error: error.message }, 400);
    }
  });

  app.post('/api/admin/pages', auth.admin, auth.csrf, async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      return c.json({ success: true, page: await db.createPage(body) }, 201);
    } catch (error) {
      return pageError(c, error);
    }
  });

  app.patch('/api/admin/pages/:id', auth.admin, auth.csrf, async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const page = await db.updatePage(c.req.param('id'), body);
      if (!page) return c.json({ error: '页面不存在' }, 404);
      return c.json({ success: true, page });
    } catch (error) {
      return pageError(c, error);
    }
  });

  app.delete('/api/admin/pages/:id', auth.admin, auth.csrf, async (c) => {
    const result = await db.deletePage(c.req.param('id'));
    if (!result.meta.changes) return c.json({ error: '页面不存在' }, 404);
    return c.json({ success: true });
  });

  // ---------- 全站设置 ----------
  app.get('/api/settings', async (c) => {
    c.header('Cache-Control', 'public, max-age=15');
    return c.json({ success: true, settings: projectPublicSettings(await db.getSettings()) });
  });

  app.get('/api/admin/settings', auth.admin, async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ success: true, settings: await db.getSettings() });
  });

  app.patch('/api/admin/settings', auth.admin, auth.csrf, async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      return c.json({ success: true, settings: await db.updateSettings(patchSettings(await db.getSettings(), body)) });
    } catch (error) {
      return c.json({ error: error.message }, 400);
    }
  });

  // ---------- 品牌资源 ----------
  for (const kind of ['logo', 'favicon']) {
    app.post(`/api/admin/settings/assets/${kind}`, auth.admin, auth.csrf, async (c) => {
      try {
        const form = await c.req.formData();
        const file = form.get('file');
        if (!(file instanceof File) || form.getAll('file').length !== 1) {
          return c.json({ error: '请选择一个图片文件' }, 400);
        }
        const asset = await saveBrandAsset(c.env.BUCKET, new Uint8Array(await file.arrayBuffer()));
        const oldSettings = await db.getSettings();
        const oldUrl = oldSettings.branding[kind];
        const url = `/assets/branding/${asset.filename}`;
        const settings = await db.updateSettings(patchSettings(oldSettings, { branding: { [kind]: url } }));
        await removeUnusedBrandAsset(c.env.BUCKET, settings, oldUrl);
        return c.json({ success: true, url, settings });
      } catch (error) {
        return c.json({ error: error.message }, error.status || 400);
      }
    });

    app.delete(`/api/admin/settings/assets/${kind}`, auth.admin, auth.csrf, async (c) => {
      const settings = await db.getSettings();
      const oldUrl = settings.branding[kind];
      const updated = await db.updateSettings(patchSettings(settings, { branding: { [kind]: null } }));
      await removeUnusedBrandAsset(c.env.BUCKET, updated, oldUrl);
      return c.json({ success: true, settings: updated });
    });
  }
}

/** @param {R2Bucket} bucket */
async function removeUnusedBrandAsset(bucket, settings, url) {
  if (!url?.startsWith('/assets/branding/')) return;
  if (Object.values(settings.branding).includes(url)) return;
  await deleteBrandAsset(bucket, url.split('/').pop()).catch(() => {});
}
