import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from '../public/zip.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillName = '发布小助手';
const skill = path.join(root, 'skills', skillName);
export async function skillFiles(directory = skill, prefix = '') {
  const result = [];
  for (const name of (await readdir(directory)).sort()) {
    if (name.startsWith('.') || name === '__pycache__') continue;
    const relative = prefix ? `${prefix}/${name}` : name;
    const full = path.join(directory, name), stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new Error(`技能目录不应包含符号链接：${relative}`);
    if (stat.isDirectory()) result.push(...await skillFiles(full, relative));
    else if (stat.isFile() && /\.(md|py)$/.test(name)) result.push({ name: relative, data: await readFile(full) });
  }
  return result;
}

export async function buildOutputs() {
  const files = await skillFiles();
  const main = files.find(file => file.name === 'SKILL.md')?.data.toString('utf8');
  if (!main?.startsWith(`---\nname: ${skillName}\n`) || !/\ndescription: .+\n/.test(main)) throw new Error('技能 frontmatter 不完整。');
  const zip = Buffer.from(await (await makeZip(files.map(file => ({ name: `${skillName}/${file.name}`, data: new Blob([file.data]) })), { date: new Date(2020, 0, 1) })).arrayBuffer());
  const body = main.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const reference = files.filter(file => file.name.startsWith('references/') && file.name.endsWith('.md')).map(file => file.data.toString('utf8')).join('\n\n');
  const prompt = Buffer.from(`请把以下内容作为本次对话的工作方式，接下来我只发门店名，需要时补充城市。本文是对话指令，不会新增你没有的工具。本单文件未安装本地脚本；未另行安装完整技能目录时，使用你已有的图片和文件工具，不尝试调用不存在的本地脚本。\n\n${body}\n\n以下为随附参考规则，不需要从其他文件读取：\n\n${reference}\n\n若只加载文件还没有门店，只回复：“发布小助手已准备好，发门店名称即可；有同名店时加上城市或分店。”\n`, 'utf8');
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const metadata = Buffer.from(JSON.stringify({ name: skillName, version, files: {
    '发布小助手.zip': { bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex') },
    '发布小助手.md': { bytes: prompt.length, sha256: createHash('sha256').update(prompt).digest('hex') },
    'publish-helper.zip': { bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex') },
    'publish-helper.md': { bytes: prompt.length, sha256: createHash('sha256').update(prompt).digest('hex') }
  } }, null, 2) + '\n');
  return new Map([
    ['downloads/发布小助手.zip', zip], ['downloads/发布小助手.md', prompt],
    ['downloads/publish-helper.zip', zip], ['downloads/publish-helper.md', prompt],
    ['downloads/发布小助手提示词.md', prompt], ['downloads/release.json', metadata]
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const check = process.argv.slice(2).includes('--check');
  for (const [relative, bytes] of await buildOutputs()) {
    const filename = path.join(root, relative);
    if (check) {
      let current; try { current = await readFile(filename); } catch { throw new Error(`缺少发布文件：${relative}，请运行 npm run build:skill。`); }
      if (!current.equals(bytes)) throw new Error(`发布文件已过期：${relative}，请运行 npm run build:skill。`);
    } else { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes); }
  }
  console.log(check ? '技能包、提示词及校验记录与源码一致。' : 'AI 技能包与单文件提示词已更新。');
}
