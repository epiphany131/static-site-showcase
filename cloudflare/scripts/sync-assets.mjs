// 把根目录 public/ 与 showcase/ 复制到 assets/，作为 Workers Static Assets 的单一来源。
// 前端改动永远在根目录进行，随后运行 `npm run sync-assets` 同步。
import { rmSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cloudflareDir = dirname(here);
const root = join(cloudflareDir, '..');
const assets = join(cloudflareDir, 'assets');

if (!existsSync(join(root, 'public', 'index.html')) || !existsSync(join(root, 'showcase', 'index.html'))) {
  console.error('找不到根目录 public/ 或 showcase/，请在仓库内运行此脚本');
  process.exit(1);
}

rmSync(assets, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });
cpSync(join(root, 'public'), join(assets, 'admin'), { recursive: true });
cpSync(join(root, 'showcase'), join(assets, 'showcase'), { recursive: true });
console.log('已同步前端资源到 cloudflare/assets/');
