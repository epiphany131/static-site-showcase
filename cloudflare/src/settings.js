// 设置模型：移植自 lib/settings.js，改为 ESM 并按 Workers 平台调整上传上限。
// Workers 版上限 1–64 MiB（Cloudflare 请求体 100MB 与 isolate 128MB 内存约束），
// Node 版保持 1–200 MiB 不变；默认值两版一致（50 MiB）。
const LAYOUTS = new Set(['editorial', 'grid', 'compact']);
const THEMES = new Set(['light', 'dark', 'system']);
const MiB = 1024 * 1024;
const MIN_UPLOAD_MAX_FILE_SIZE = MiB;
const DEFAULT_UPLOAD_MAX_FILE_SIZE = 50 * MiB;
const MAX_UPLOAD_MAX_FILE_SIZE = 64 * MiB;

export const DEFAULT_SETTINGS = deepFreeze({
  branding: {
    name: '创意展厅',
    description: '发现和预览托管在平台上的创意前端作品',
    footer: '由静态托管平台驱动',
    logo: null,
    favicon: null
  },
  home: {
    eyebrow: 'EXPLORE THE WEB',
    title: '值得被看见的作品',
    description: '浏览可直接运行的静态网站作品，在实时预览和源代码之间自由切换。',
    sectionTitle: '最新作品',
    sectionDescription: '每个作品都可以直接预览和查看代码',
    layout: 'editorial',
    showPreview: true
  },
  appearance: { defaultTheme: 'system', allowThemeSwitch: true, accentColor: '#e9ff60' },
  uploads: { maxFileSize: DEFAULT_UPLOAD_MAX_FILE_SIZE }
});

const SCHEMA = {
  branding: {
    name: ['string', 1, 80], description: ['string', 0, 300], footer: ['string', 0, 200],
    logo: ['asset', 0, 2048], favicon: ['asset', 0, 2048]
  },
  home: {
    eyebrow: ['string', 0, 80], title: ['string', 1, 120], description: ['string', 0, 500],
    sectionTitle: ['string', 1, 100], sectionDescription: ['string', 0, 200],
    layout: ['enum', LAYOUTS], showPreview: ['boolean']
  },
  appearance: {
    defaultTheme: ['enum', THEMES], allowThemeSwitch: ['boolean'], accentColor: ['color']
  },
  uploads: {
    maxFileSize: ['integer', MIN_UPLOAD_MAX_FILE_SIZE, MAX_UPLOAD_MAX_FILE_SIZE, MiB]
  }
};

function settingsError(code, path, message) {
  const error = new TypeError(message || `无效的设置：${path}`);
  error.code = code;
  error.path = path;
  error.status = 400;
  return error;
}

function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
  return Object.freeze(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateValue(value, rule, path) {
  const [type, a, b, step] = rule;
  if (type === 'string') {
    if (typeof value !== 'string' || value.length < a || value.length > b || value.includes('\0'))
      throw settingsError('INVALID_SETTING', path);
    return value;
  }
  if (type === 'asset') {
    if (value === null) return value;
    if (typeof value !== 'string' || value.length < a || value.length > b || value.includes('\0'))
      throw settingsError('INVALID_SETTING', path);
    return value;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw settingsError('INVALID_SETTING', path);
    return value;
  }
  if (type === 'enum') {
    if (typeof value !== 'string' || !a.has(value)) throw settingsError('INVALID_SETTING', path);
    return value;
  }
  if (type === 'integer') {
    if (!Number.isSafeInteger(value) || value < a || value > b || step && value % step !== 0) throw settingsError('INVALID_SETTING', path);
    return value;
  }
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value))
    throw settingsError('INVALID_SETTING', path, '强调色必须是 #RRGGBB 格式');
  return value.toLowerCase();
}

/** @param {{ MAX_FILE_SIZE?: string } | undefined} env */
export function uploadMaxFileSizeFromEnv(env) {
  const parsed = Number.parseInt(env?.MAX_FILE_SIZE ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= MIN_UPLOAD_MAX_FILE_SIZE && parsed <= MAX_UPLOAD_MAX_FILE_SIZE && parsed % MiB === 0
    ? parsed
    : DEFAULT_UPLOAD_MAX_FILE_SIZE;
}

function defaultSettings(options = {}) {
  const result = clone(DEFAULT_SETTINGS);
  const maxFileSize = options.uploadMaxFileSize;
  if (Number.isSafeInteger(maxFileSize) && maxFileSize >= MIN_UPLOAD_MAX_FILE_SIZE && maxFileSize <= MAX_UPLOAD_MAX_FILE_SIZE && maxFileSize % MiB === 0) {
    result.uploads.maxFileSize = maxFileSize;
  }
  return result;
}

function normalizeLegacy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const value = { ...input };
  value.branding = { ...(input.branding && typeof input.branding === 'object' ? input.branding : {}) };
  value.home = { ...(input.home && typeof input.home === 'object' ? input.home : {}) };
  value.appearance = { ...(input.appearance && typeof input.appearance === 'object' ? input.appearance : {}) };
  value.uploads = { ...(input.uploads && typeof input.uploads === 'object' ? input.uploads : {}) };
  const moves = [
    ['siteName', 'branding', 'name'], ['siteDescription', 'branding', 'description'],
    ['footerText', 'branding', 'footer'], ['logoUrl', 'branding', 'logo'], ['faviconUrl', 'branding', 'favicon'],
    ['homeTitle', 'home', 'title'], ['homeDescription', 'home', 'description'], ['homeLayout', 'home', 'layout'],
    ['showPreview', 'home', 'showPreview'], ['defaultTheme', 'appearance', 'defaultTheme'],
    ['allowThemeSwitch', 'appearance', 'allowThemeSwitch'], ['accentColor', 'appearance', 'accentColor']
  ];
  for (const [oldKey, section, key] of moves)
    if (value[section][key] === undefined && input[oldKey] !== undefined) value[section][key] = input[oldKey];
  return value;
}

/** @param {unknown} input @param {{ uploadMaxFileSize?: number }} options */
export function normalizeSettings(input, options = {}) {
  const source = normalizeLegacy(input);
  const result = defaultSettings(options);
  for (const [section, fields] of Object.entries(SCHEMA)) {
    const values = source[section];
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    for (const [key, rule] of Object.entries(fields)) {
      if (values[key] === undefined) continue;
      try { result[section][key] = validateValue(values[key], rule, `${section}.${key}`); } catch {}
    }
  }
  return result;
}

/** @param {unknown} current @param {unknown} patch */
export function patchSettings(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw settingsError('INVALID_PATCH', '', '设置补丁必须是对象');
  const result = normalizeSettings(current);
  for (const [section, values] of Object.entries(patch)) {
    if (!Object.hasOwn(SCHEMA, section)) throw settingsError('UNKNOWN_SETTING', section);
    if (!values || typeof values !== 'object' || Array.isArray(values))
      throw settingsError('INVALID_SETTING', section);
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(SCHEMA[section], key)) throw settingsError('UNKNOWN_SETTING', `${section}.${key}`);
      result[section][key] = validateValue(value, SCHEMA[section][key], `${section}.${key}`);
    }
  }
  return result;
}

/** @param {unknown} settings */
export function projectPublicSettings(settings) {
  const projected = normalizeSettings(settings);
  delete projected.uploads;
  return projected;
}

export {
  LAYOUTS, THEMES, MIN_UPLOAD_MAX_FILE_SIZE, DEFAULT_UPLOAD_MAX_FILE_SIZE, MAX_UPLOAD_MAX_FILE_SIZE
};
