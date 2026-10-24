// Cloudflare Workers 入口：Hono 路由 + 静态资源/R2 分流。
// 路由语义对齐 Node 版 app.js；托管站点与品牌资源改由 R2 提供。
import { Hono } from 'hono';
import { Database } from './db.js';
import { createAuth } from './auth.js';
import { serveSiteObject, serveBrandingObject } from './storage.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerUserRoutes } from './routes/users.js';
import { registerSiteRoutes } from './routes/sites.js';
import { registerContentRoutes } from './routes/content.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createApp(env) {
  const db = new Database(env.DB, env);
  const auth = createAuth(db);
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('authContext', auth);
    await next();
  });

  registerAuthRoutes(app, { db, auth });
  registerUserRoutes(app, { db, auth });
  registerSiteRoutes(app, { db, auth });
  registerContentRoutes(app, { db, auth });

  app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

  // 托管站点：所有文件统一沙箱 CSP（与 Node 版一致）
  // Hono 对数组路径注册支持有限，这里逐个注册并覆盖尾斜杠变体。
  const serveSite = async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.text('网站不存在', 404);
    const site = await db.getSiteById(id);
    const authContext = c.get('authContext');
    const found = await authContext.currentSession(c.req.raw);
    const allowed = site && (site.published
      || (found && (found.session.role === 'admin' || found.session.user_id === site.owner_user_id)));
    if (!allowed) return c.text('网站不存在', 404);
    const relative = c.req.path.slice(`/sites/${id}`.length) || '/';
    if (c.req.path === `/sites/${id}`) return c.redirect(`/sites/${id}/`, 301);
    return serveSiteObject(c.env.BUCKET, id, relative);
  };
  app.get('/sites/:id', serveSite);
  app.get('/sites/:id/', serveSite);
  app.get('/sites/:id/*', serveSite);

  app.get('/assets/branding/:filename', (c) => serveBrandingObject(c.env.BUCKET, c.req.param('filename')));

  // 公开页面模板（数据由页面 JS 从 API 加载）
  app.get('/works/:id', (c) => UUID_RE.test(c.req.param('id'))
    ? asset(c, '/showcase/detail.html')
    : c.text('作品不存在', 404));
  app.get('/pages', (c) => asset(c, '/showcase/articles.html'));
  app.get('/articles', (c) => asset(c, '/showcase/articles.html'));
  app.get('/pages/:slug', async (c) => {
    const page = await db.getPageBySlug(c.req.param('slug'), true);
    return page ? asset(c, '/showcase/article.html') : c.text('页面不存在或尚未发布', 404);
  });
  app.get('/articles/:slug', async (c) => {
    const page = await db.getPageBySlug(c.req.param('slug'), true);
    return page ? asset(c, '/showcase/article.html') : c.text('页面不存在或尚未发布', 404);
  });
  app.get('/', (c) => asset(c, '/showcase/index.html'));

  // 管理后台：静态文件必须登录后经 ASSETS 提供（对齐 Node 版 auth.optional + 重定向）
  app.get('/admin', (c) => c.redirect('/admin/', 301));
  app.get('/admin/*', async (c) => {
    const found = await c.get('authContext').currentSession(c.req.raw);
    if (!found) return c.redirect('/login');
    const path = c.req.path.replace(/^\/admin/, '') || '/';
    return asset(c, `/admin${path}`);
  });

  // 兜底：交给静态资源层（showcase 的 js/css 等），未命中返回 404
  app.all('*', (c) => asset(c, c.req.path, true));

  return app;
}

function asset(c, path, notFoundText = false) {
  return c.env.ASSETS.fetch(new Request(new URL(path, 'https://assets.internal'))).then((response) => {
    if (!notFoundText) return response;
    return response.status === 404 ? c.text('页面不存在', 404) : response;
  });
}

export default {
  /** @param {Request} request @param {Record<string, any>} env @param {ExecutionContext} context */
  async fetch(request, env, context) {
    try {
      const response = await createApp(env).fetch(request, env, context);
      return response;
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: '服务内部错误' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
  }
};
