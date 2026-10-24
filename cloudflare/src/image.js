// 品牌图片校验与 R2 存取：magic bytes 校验移植自 lib/image.js，落盘改为 R2。
import { sha256Hex } from './crypto.js';

export const MAX_IMAGE_SIZE = 2 * 1024 * 1024;

const TYPES = [
  { mime: 'image/png', ext: 'png', prefix: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: 'image/jpeg', ext: 'jpg', prefix: Uint8Array.from([0xff, 0xd8, 0xff]) },
  {
    mime: 'image/webp', ext: 'webp',
    check: (bytes) => {
      const riff = Uint8Array.from([0x52, 0x49, 0x46, 0x46]);
      const webp = Uint8Array.from([0x57, 0x45, 0x42, 0x50]);
      return startsWith(bytes, riff) && bytes.length >= 12 && startsWith(bytes.subarray(8), webp);
    }
  }
];

/** @param {Uint8Array} bytes @param {Uint8Array} prefix */
function startsWith(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function imageError(message, status = 415) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * 校验图片内容并返回 { mime, ext }；SVG 与未知格式一律拒绝。
 * @param {Uint8Array} bytes
 */
export function inspectImage(bytes) {
  if (!bytes || !bytes.length) throw imageError('图片内容为空', 400);
  if (bytes.length > MAX_IMAGE_SIZE) throw imageError('图片超过 2MiB 限制', 413);
  const matched = TYPES.find((type) => type.check ? type.check(bytes) : startsWith(bytes, type.prefix));
  if (!matched) throw imageError('仅支持 PNG、JPEG 或 WebP 图片');
  return { mime: matched.mime, ext: matched.ext };
}

/**
 * 保存品牌资源到 R2（内容哈希命名，自动去重）。
 * @param {R2Bucket} bucket @param {Uint8Array} bytes
 * @returns {Promise<{ filename: string }>}
 */
export async function saveBrandAsset(bucket, bytes) {
  const inspected = inspectImage(bytes);
  const digest = await sha256Hex(bytes);
  const filename = `${digest}.${inspected.ext}`;
  const key = `branding/${filename}`;
  const existing = await bucket.head(key);
  if (!existing) {
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: inspected.mime },
      customMetadata: { role: 'branding' }
    });
  }
  return { filename };
}

/**
 * 删除品牌资源；文件名必须是内容哈希形式，防止任意删除。
 * @param {R2Bucket} bucket @param {string} filename
 */
export async function deleteBrandAsset(bucket, filename) {
  if (!/^[0-9a-f]{64}\.(png|jpg|webp)$/.test(filename)) {
    throw new TypeError('无效的资源文件名');
  }
  await bucket.delete(`branding/${filename}`);
}
