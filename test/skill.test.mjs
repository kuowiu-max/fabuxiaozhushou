import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildOutputs, skillFiles } from '../scripts/build-skill.mjs';

test('技能发布文件与源码一致，重新构建不改变内容', async () => {
  const first = await buildOutputs(), second = await buildOutputs();
  for (const [name, bytes] of first) {
    assert.deepEqual(second.get(name), bytes);
    assert.deepEqual(await readFile(new URL('../' + name, import.meta.url)), bytes, `过期文件：${name}`);
  }
  const manifest = JSON.parse(first.get('downloads/release.json'));
  for (const [name, metadata] of Object.entries(manifest.files)) {
    const bytes = first.get('downloads/' + name);
    assert.equal(bytes.length, metadata.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
  }
});
test('技能包包含真实图片获取、素材打包和独立运行所需资源', async () => {
  const files = await skillFiles(), names = files.map(file => file.name);
  for (const required of ['SKILL.md', 'references/capabilities.md', 'references/output.md', 'references/materials-schema.md', 'scripts/fetch_photos.py', 'scripts/package_materials.py']) assert.ok(names.includes(required));
  const skill = files.find(file => file.name === 'SKILL.md').data.toString('utf8');
  for (const link of skill.matchAll(/\]\((references\/[^)]+)\)/g)) assert.ok(names.includes(link[1]));
});
