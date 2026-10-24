// 测试用内存版 R2 桩对象：仅实现被测代码用到的子集（put/get/head/delete/list）。
export function createMockBucket() {
  const objects = new Map();

  async function put(key, value, options = {}) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
    objects.set(key, {
      key,
      value: bytes,
      size: bytes.length,
      httpMetadata: options.httpMetadata ?? null,
      customMetadata: options.customMetadata ?? null,
      uploaded: new Date()
    });
    return objects.get(key);
  }

  async function get(key) {
    const object = objects.get(key);
    if (!object) return null;
    const value = object.value;
    return {
      key, size: value.length, httpMetadata: object.httpMetadata,
      value,
      arrayBuffer: async () => value.slice().buffer,
      body: new Blob([value]).stream()
    };
  }

  async function head(key) {
    const object = objects.get(key);
    if (!object) return null;
    return { key, size: object.size, httpMetadata: object.httpMetadata };
  }

  async function remove(key) {
    objects.delete(key);
  }

  async function list(options = {}) {
    const prefix = options.prefix ?? '';
    const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const limited = keys.slice(0, options.limit ?? 1000).map((key) => ({
      key, size: objects.get(key).size
    }));
    const truncated = keys.length > limited.length;
    return {
      objects: limited,
      truncated,
      cursor: truncated ? keys[limited.length] : undefined
    };
  }

  return { put, get, head, delete: remove, list, _objects: objects };
}
