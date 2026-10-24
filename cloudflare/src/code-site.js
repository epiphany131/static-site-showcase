// 粘贴代码生成站点：移植自 lib/code-site.js。
// 差异：TextDecoder 用全局（Workers/浏览器一致）；Buffer.byteLength 用 TextEncoder；
// 输入改为 { data: Uint8Array } 形态（与 request.formData() 的 File 对齐）。
import { parse as parseHtml } from 'parse5';

export const MAX_CODE_FILE_SIZE = 512 * 1024;
export const CODE_FIELDS = ['html', 'css', 'javascript'];
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const PARSE_ORIGIN = 'https://static-host.invalid';

function codeError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** @param {File | { data: Uint8Array } | undefined} uploaded */
function bytesOf(uploaded) {
  if (uploaded instanceof Uint8Array) return uploaded;
  if (uploaded && uploaded.data instanceof Uint8Array) return uploaded.data;
  return null;
}

function byteLength(value) {
  return encoder.encode(value).length;
}

function decodeCodeFile(uploaded, label, required = false) {
  if (!uploaded) {
    if (required) throw codeError(`请粘贴 ${label} 代码`);
    return '';
  }
  const data = bytesOf(uploaded);
  if (!data) throw codeError(`${label} 内容无效`);
  if (data.length > MAX_CODE_FILE_SIZE) throw codeError(`${label} 不能超过 512 KiB`, 413);
  if (data.includes(0)) throw codeError(`${label} 不能包含 NUL 字节`);
  try {
    const value = decoder.decode(data);
    if (required && !value.trim()) throw codeError(`请粘贴 ${label} 代码`);
    return value;
  } catch (error) {
    if (error.status) throw error;
    throw codeError(`${label} 必须是有效的 UTF-8 文本`);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function attribute(node, name) {
  return node.attrs?.find((item) => item.name.toLowerCase() === name)?.value;
}

function parseDocument(html) {
  const document = parseHtml(html, { sourceCodeLocationInfo: true });
  const elements = [];
  walk(document, (node) => { if (node.tagName) elements.push(node); });
  return { document, elements };
}

function assetContext(elements, assetBase) {
  const normalizedBase = assetBase.endsWith('/') ? assetBase : `${assetBase}/`;
  const documentUrl = new URL(normalizedBase, PARSE_ORIGIN);
  const baseElement = elements.find((node) => node.tagName === 'base' && attribute(node, 'href'));
  let resolutionBase = documentUrl;
  if (baseElement) {
    try { resolutionBase = new URL(attribute(baseElement, 'href'), documentUrl); } catch {}
  }
  return { normalizedBase, documentUrl, resolutionBase, hasBase: Boolean(baseElement) };
}

function referencesAsset(elements, context, tagName, attributeName, filename) {
  const target = new URL(filename, context.documentUrl).href;
  return elements.some((node) => {
    if (node.tagName !== tagName) return false;
    if (tagName === 'link') {
      const rel = String(attribute(node, 'rel') || '').toLowerCase().split(/\s+/);
      if (!rel.includes('stylesheet')) return false;
    }
    const value = attribute(node, attributeName);
    if (!value) return false;
    try {
      const candidate = new URL(value, context.resolutionBase);
      candidate.search = '';
      candidate.hash = '';
      return candidate.href === target;
    } catch { return false; }
  });
}

function startOffset(node) {
  return node?.sourceCodeLocation?.startTag?.endOffset ?? null;
}

function closingOffset(node) {
  return node?.sourceCodeLocation?.endTag?.startOffset ?? null;
}

function openingOffset(node) {
  return node?.sourceCodeLocation?.startTag?.startOffset ?? null;
}

function runtimeAssetLoader(kind, path) {
  const property = kind === 'style' ? 'href' : 'src';
  const create = kind === 'style'
    ? 'const e=document.createElement("link");e.rel="stylesheet";'
    : 'const e=document.createElement("script");';
  const target = JSON.stringify(path).replace(/</g, '\\u003c');
  return `<script>(()=>{${create}e.${property}=new URL(${target},location.href).href;document.${kind === 'style' ? 'head' : 'body'}.append(e)})()</script>`;
}

function applyInsertions(html, insertions) {
  let result = html;
  for (const insertion of insertions.sort((a, b) => b.offset - a.offset)) {
    result = `${result.slice(0, insertion.offset)}${insertion.content}${result.slice(insertion.offset)}`;
  }
  return result;
}

function buildFullDocument(html, css, javascript, assetBase) {
  const { elements } = parseDocument(html);
  const context = assetContext(elements, assetBase);
  const head = elements.find((node) => node.tagName === 'head');
  const body = elements.find((node) => node.tagName === 'body');
  const htmlElement = elements.find((node) => node.tagName === 'html');
  const insertions = [];

  if (css && !referencesAsset(elements, context, 'link', 'href', 'style.css')) {
    const link = context.hasBase
      ? `\n  ${runtimeAssetLoader('style', 'style.css')}`
      : '\n  <link rel="stylesheet" href="style.css">';
    const offset = closingOffset(head) ?? openingOffset(body) ?? startOffset(htmlElement) ?? 0;
    const wrapped = head?.sourceCodeLocation ? link : `\n<head>${link}\n</head>`;
    insertions.push({ offset, content: wrapped });
  }

  if (javascript && !referencesAsset(elements, context, 'script', 'src', 'script.js')) {
    const script = context.hasBase
      ? `\n  ${runtimeAssetLoader('script', 'script.js')}`
      : '\n  <script src="script.js"></script>';
    const offset = closingOffset(body) ?? closingOffset(htmlElement) ?? html.length;
    insertions.push({ offset, content: script });
  }

  return applyInsertions(html, insertions);
}

function buildFragmentDocument(html, css, javascript, title) {
  const stylesheet = css ? '  <link rel="stylesheet" href="style.css">\n' : '';
  const script = javascript ? '\n  <script src="script.js"></script>' : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
${stylesheet}</head>
<body>
${html}${script}
</body>
</html>
`;
}

/**
 * @param {Record<string, { data: Uint8Array } | File>} files
 * @param {string} title
 * @param {string} assetBase
 */
export function buildCodeSite(files, title, assetBase = '/sites/generated/') {
  const keys = Object.keys(files || {});
  if (keys.some((key) => !CODE_FIELDS.includes(key))) {
    throw codeError('代码上传包含不支持的文件字段');
  }

  const html = decodeCodeFile(files?.html, 'HTML', true);
  const css = decodeCodeFile(files?.css, 'CSS');
  const javascript = decodeCodeFile(files?.javascript, 'JavaScript');
  const totalSize = byteLength(html) + byteLength(css) + byteLength(javascript);
  if (totalSize > MAX_CODE_FILE_SIZE * CODE_FIELDS.length) {
    throw codeError('代码总大小不能超过 1.5 MiB', 413);
  }

  const completeDocument = parseDocument(html).elements.some((node) =>
    node.tagName === 'html' && Boolean(node.sourceCodeLocation));
  return {
    'index.html': completeDocument
      ? buildFullDocument(html, css, javascript, assetBase)
      : buildFragmentDocument(html, css, javascript, title),
    'style.css': css,
    'script.js': javascript
  };
}
