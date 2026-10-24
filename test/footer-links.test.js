const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const parse5 = require('parse5');

const PROJECT_URL = 'https://github.com/epiphany131/static-site-showcase';
const TEMPLATES = [
  'showcase/index.html',
  'showcase/detail.html',
  'showcase/articles.html',
  'showcase/article.html',
  'public/index.html'
];

function children(node) {
  return [...(node.childNodes || []), ...(node.content?.childNodes || [])];
}

function descendants(node) {
  return children(node).flatMap((child) => [child, ...descendants(child)]);
}

function attribute(node, name) {
  return node.attrs?.find((item) => item.name === name)?.value;
}

for (const filename of TEMPLATES) {
  test(`${filename} 的页脚包含安全的 GitHub 项目链接`, () => {
    const html = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    const document = parse5.parse(html);
    const footers = descendants(document).filter((node) => node.tagName === 'footer');
    assert.equal(footers.length, 1);
    const links = descendants(footers[0]).filter((node) =>
      node.tagName === 'a' && attribute(node, 'href') === PROJECT_URL);
    assert.equal(links.length, 1);
    assert.equal(attribute(links[0], 'target'), '_blank');
    const rel = new Set((attribute(links[0], 'rel') || '').split(/\s+/));
    assert.equal(rel.has('noopener'), true);
    assert.equal(rel.has('noreferrer'), true);
  });
}
