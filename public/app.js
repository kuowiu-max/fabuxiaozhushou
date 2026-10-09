import { normalizeInput, safeUrl, buildMessages, templateDraft } from './draft.mjs';
import { makeZip } from './zip.js';

const $ = id => document.getElementById(id);
const emptyState = () => ({ store: '', city: '', facts: '', style: '自然介绍', visited: false, sources: [], photos: [], draft: null, dirty: false });
let state = emptyState(), db, saveTimer, toastTimer, saveChain = Promise.resolve(), generation = 0, importGeneration = 0;
let providers = [], photoUrls = [];
const uid = () => globalThis.crypto.randomUUID?.() || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
const element = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
function storageStatus(message) { $('save-status').replaceChildren(element('i'), document.createTextNode(message)); }
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('publish-helper', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function readState() {
  return new Promise((resolve, reject) => {
    const request = db.transaction('workspace').objectStore('workspace').get('current');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
function save() {
  clearTimeout(saveTimer);
  const snapshot = structuredClone(state);
  if (!db) { storageStatus('仅本次使用'); return Promise.resolve(); }
  saveChain = saveChain.then(() => new Promise((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').put(snapshot, 'current');
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
  })).then(() => storageStatus('已保存到本机')).catch(() => { storageStatus('保存失败，请导出'); toast('本机存储空间不足或不可用，请导出素材包备份。'); });
  return saveChain;
}
function scheduleSave() { storageStatus(db ? '正在保存…' : '仅本次使用'); clearTimeout(saveTimer); saveTimer = setTimeout(save, 220); }
function updateCounts() {
  $('fact-count').textContent = `${state.facts.length} / 5000`;
  $('source-count').textContent = state.sources.length;
  $('photo-count').textContent = state.photos.length;
}
function markDirty() {
  if (state.draft) { state.dirty = true; $('draft-mode').textContent = '资料已变更'; }
}
function renderSources() {
  $('source-list').replaceChildren(); $('source-empty').hidden = state.sources.length > 0;
  for (const source of state.sources) {
    const item = element('div', 'source-item'), info = element('div', 'source-info');
    info.append(element('strong', '', source.label || '参考资料'));
    const url = safeUrl(source.url);
    if (url) { const link = element('a', '', new URL(url).hostname + ' ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; info.append(link); }
    if (source.notes) info.append(element('p', '', source.notes));
    const remove = element('button', 'icon-button', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `删除资料 ${source.label || '参考资料'}`);
    remove.addEventListener('click', () => { state.sources = state.sources.filter(s => s.id !== source.id); renderSources(); updateCounts(); markDirty(); scheduleSave(); });
    item.append(element('span', 'source-icon', '⌁'), info, remove); $('source-list').append(item);
  }
}
function renderPhotos() {
  for (const url of photoUrls) URL.revokeObjectURL(url); photoUrls = [];
  $('photo-list').replaceChildren();
  for (const photo of state.photos) {
    const item = element('div', 'photo-item'), image = element('img');
    const url = URL.createObjectURL(photo.file); photoUrls.push(url); image.src = url; image.alt = photo.name; image.loading = 'lazy';
    const remove = element('button', 'icon-button', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `删除图片 ${photo.name}`);
    remove.addEventListener('click', () => { state.photos = state.photos.filter(p => p.id !== photo.id); renderPhotos(); updateCounts(); scheduleSave(); });
    item.append(image, remove, element('p', '', photo.name)); $('photo-list').append(item);
  }
}
function renderDraft() {
  $('draft-empty').hidden = !!state.draft; $('draft-content').hidden = !state.draft;
  $('draft-mode').textContent = !state.draft ? '待整理' : state.dirty ? '资料已变更' : state.draft.mode === 'ai' ? 'AI 草稿' : state.draft.mode === 'manual' ? '已编辑' : '资料模板';
  if (!state.draft) return;
  $('draft-title').value = state.draft.title; $('draft-body').value = state.draft.body;
  $('draft-tags').value = state.draft.tags.map(tag => '#' + tag).join(' ');
  $('checks-list').replaceChildren(...state.draft.checks.map(check => element('li', '', check)));
  $('checks-box').hidden = state.draft.checks.length === 0;
}
function renderAll() {
  for (const id of ['store', 'city', 'facts', 'style']) $(id).value = state[id];
  $('visited').checked = state.visited;
  renderSources(); renderPhotos(); renderDraft(); updateCounts();
}
function inputData() { return normalizeInput(state); }
function draftText() {
  if (!state.draft || !state.draft.body.trim()) throw new Error('请先生成或填写文案草稿。');
  return [state.draft.title, state.draft.body, state.draft.tags.map(t => '#' + t).join(' ')].filter(Boolean).join('\n\n');
}
async function copy(text, message) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const input = element('textarea'); input.value = text; input.setAttribute('aria-label', '待复制内容'); document.body.append(input); input.select();
      const copied = document.execCommand('copy'); input.remove(); if (!copied) throw new Error();
    }
    toast(message);
  } catch { showCopyDialog(text); }
}
function showCopyDialog(text) {
  const dialog = element('dialog'), title = element('h2', '', '长按全选并复制'), area = element('textarea'), close = element('button', 'button secondary full', '完成');
  area.value = text; area.rows = 12; area.setAttribute('aria-label', '复制内容');
  close.addEventListener('click', () => dialog.close()); dialog.addEventListener('close', () => dialog.remove());
  dialog.append(title, area, close); document.body.append(dialog); dialog.showModal(); area.select();
}
function safeName(value) { return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100) || '门店素材'; }
function download(blob, name) { const url = URL.createObjectURL(blob), link = element('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
async function identifyImage(file) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)) return 'image/png';
  const text = new TextDecoder().decode(bytes);
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp';
  return '';
}
async function addPhotos(files) {
  const run = importGeneration;
  let added = 0; const rejected = [];
  for (const file of files) {
    if (state.photos.length >= 20) { rejected.push('最多可添加 20 张图片'); break; }
    if (file.size > 10 * 1024 * 1024) { rejected.push(`${file.name} 超过 10 MB`); continue; }
    if (state.photos.reduce((sum, p) => sum + p.file.size, 0) + file.size > 50 * 1024 * 1024) { rejected.push('图片总大小不能超过 50 MB'); continue; }
    const type = await identifyImage(file);
    if (run !== importGeneration) return;
    if (!type) { rejected.push(`${file.name} 不是支持的图片格式`); continue; }
    state.photos.push({ id: uid(), name: file.name, file: new Blob([file], { type }), type }); added++;
  }
  renderPhotos(); updateCounts(); if (added) scheduleSave();
  toast(rejected.length ? `${added ? `已添加 ${added} 张。` : ''}${rejected[0]}` : `已添加 ${added} 张原图`);
}

async function init() {
  storageStatus('正在读取…');
  try { db = await openDb(); const stored = await readState(); if (stored) state = { ...emptyState(), ...stored }; storageStatus('已保存到本机'); }
  catch { storageStatus('仅本次使用'); toast('浏览器存储不可用，离开页面前请导出素材。'); }
  renderAll();
  for (const id of ['store', 'city', 'facts', 'style']) $(id).addEventListener('input', () => {
    state[id] = $(id).value; markDirty(); updateCounts(); scheduleSave();
    if (id === 'store' || id === 'city') $('search-options').hidden = true;
  });
  $('visited').addEventListener('change', () => { state.visited = $('visited').checked; markDirty(); scheduleSave(); });
  $('find-store').addEventListener('click', () => {
    if (!state.store.trim()) { toast('请先填写门店名称。'); $('store').focus(); return; }
    const query = [state.city.trim(), state.store.trim()].filter(Boolean).join(' ');
    $('search-xhs').href = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}&source=web_search_result_notes`;
    $('search-dp').href = `https://www.bing.com/search?q=${encodeURIComponent('site:dianping.com ' + query)}`;
    $('search-options').hidden = false;
  });
  $('add-source').addEventListener('click', () => {
    if (state.sources.length >= 20) { toast('最多可添加 20 条资料，请先整理已有内容。'); return; }
    $('source-form').reset(); $('source-dialog').showModal(); $('source-label').focus();
  });
  $('close-dialog').addEventListener('click', () => $('source-dialog').close());
  $('source-form').addEventListener('submit', event => {
    event.preventDefault(); const rawUrl = $('source-url').value.trim(), url = safeUrl(rawUrl), notes = $('source-notes').value.trim();
    if (rawUrl && !url) { toast('请使用不含账号密码的 http 或 https 链接。'); return; }
    if (!url && !notes) { toast('请添加原文链接或参考内容。'); return; }
    state.sources.push({ id: uid(), label: $('source-label').value.trim(), url, notes });
    renderSources(); updateCounts(); markDirty(); scheduleSave(); $('source-dialog').close(); toast('已保存参考资料');
  });
  $('photos').addEventListener('change', async () => { await addPhotos(Array.from($('photos').files)); $('photos').value = ''; });
  $('drop-zone').addEventListener('dragover', event => { event.preventDefault(); $('drop-zone').classList.add('dragover'); });
  $('drop-zone').addEventListener('dragleave', () => $('drop-zone').classList.remove('dragover'));
  $('drop-zone').addEventListener('drop', event => { event.preventDefault(); $('drop-zone').classList.remove('dragover'); addPhotos(Array.from(event.dataTransfer.files)); });
  $('copy-prompt').addEventListener('click', () => {
    try {
      const input = inputData(), messages = buildMessages(input);
      const prompt = `${messages[0].content}\n\n${messages[1].content}\n\n这次请直接用可阅读的中文输出：第一行标题，然后正文、话题和待确认事项，不要输出 JSON。`;
      copy(prompt, '已复制，粘贴到你常用的 AI 软件即可');
    } catch (error) { toast(error.message); }
  });
  $('generate').addEventListener('click', async () => {
    let input; try { input = inputData(); } catch (error) { toast(error.message); return; }
    const run = ++generation, button = $('generate'), snapshot = JSON.stringify(input);
    button.disabled = true; button.textContent = '正在整理…';
    try {
      let draft;
      if ($('provider').value === 'template') draft = templateDraft(input);
      else {
        const response = await fetch('./api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, provider: $('provider').value }), signal: AbortSignal.timeout(50_000) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || '暂时无法生成，请重试。'); draft = data;
      }
      if (run !== generation) return;
      state.draft = draft; state.dirty = snapshot !== JSON.stringify(inputData()); renderDraft(); scheduleSave();
      toast(draft.mode === 'template' ? '资料模板已整理，可直接编辑或交给 AI 润色' : 'AI 草稿已生成，请核对后再发布');
    } catch (error) { if (run === generation) toast(error.name === 'TimeoutError' ? '请求超时，可先用资料模板。' : error.message); }
    finally { if (run === generation) { button.disabled = false; button.textContent = '✦ 整理成草稿'; } }
  });
  for (const id of ['draft-title', 'draft-body', 'draft-tags']) $(id).addEventListener('input', () => {
    if (!state.draft) return;
    if (id === 'draft-tags') state.draft.tags = $(id).value.split(/\s+/).map(t => t.replace(/^#+/, '')).filter(Boolean).slice(0, 10);
    else state.draft[id === 'draft-title' ? 'title' : 'body'] = $(id).value;
    state.draft.mode = 'manual'; $('draft-mode').textContent = state.dirty ? '资料已变更' : '已编辑'; scheduleSave();
  });
  $('copy-draft').addEventListener('click', () => { try { copy(draftText(), '文案已复制'); } catch (error) { toast(error.message); } });
  $('share-draft').addEventListener('click', async () => {
    try {
      const text = draftText();
      if (navigator.share) await navigator.share({ title: state.draft.title, text });
      else await copy(text, '当前浏览器不支持直接分享，已复制文案');
    } catch (error) { if (error.name !== 'AbortError') toast(error.message); }
  });
  $('use-ai-result').addEventListener('click', () => {
    const text = $('ai-result').value.trim(); if (!text) { toast('请先粘贴 AI 生成的文案。'); return; }
    const [title, ...body] = text.split('\n');
    state.draft = { title: title.replace(/^#+\s*/, '').slice(0, 120), body: body.join('\n').trim() || title, tags: [], checks: ['核对文案事实及图片使用授权。'], mode: 'manual' };
    state.dirty = false; renderDraft(); scheduleSave(); $('ai-result').value = ''; toast('已放入草稿，可以继续编辑');
  });
  $('export').addEventListener('click', async () => {
    if (!state.store.trim()) { toast('请先填写门店名称。'); return; }
    const button = $('export'); button.disabled = true; button.textContent = '正在打包…';
    try {
      const name = safeName(state.store), text = state.draft ? draftText() : `${state.store}\n\n${state.facts || '尚未填写门店资料。'}`;
      const sources = state.sources.map((s, i) => `### ${i + 1}. ${s.label || '参考资料'}\n${s.url}\n\n${s.notes}`).join('\n\n');
      const metadata = { exportedAt: new Date().toISOString(), store: state.store, city: state.city, facts: state.facts, visited: state.visited, style: state.style,
        sources: state.sources.map(({ label, url, notes }) => ({ label, url, notes })), draft: state.draft, draftNeedsUpdate: state.dirty,
        images: state.photos.map((p, i) => ({ originalName: p.name, file: `原图/${String(i + 1).padStart(2, '0')}-${safeName(p.name)}`, size: p.file.size, type: p.type })) };
      const files = [
        { name: '文案草稿.md', data: text },
        { name: '参考来源.md', data: `# ${state.store} · 参考来源\n\n${sources || '暂无参考来源。'}\n\n图片为用户自行导入的原始文件，导出未去除或添加水印。\n${state.dirty ? '\n注意：资料在生成草稿后发生变更，请重新核对文案。' : ''}` },
        { name: '素材记录.json', data: JSON.stringify(metadata, null, 2) },
        ...state.photos.map((p, i) => ({ name: metadata.images[i].file, data: p.file }))
      ];
      const zip = await makeZip(files); download(zip, `${name}-素材包.zip`); toast('素材包已导出，图片保持原始文件');
    } catch { toast('导出失败，请减少图片后重试。'); }
    finally { button.disabled = false; button.textContent = '↓ 导出素材包'; }
  });
  $('reset').addEventListener('click', async () => {
    if ((state.store || state.facts || state.sources.length || state.photos.length || state.draft) && !confirm('新建会清空当前工作台。已导出备份了吗？')) return;
    generation++; importGeneration++; state = emptyState(); $('search-options').hidden = true;
    $('generate').disabled = false; $('generate').textContent = '✦ 整理成草稿'; renderAll(); await save(); toast('新的草稿准备好了'); $('store').focus();
  });
  // Static hosting works entirely without this optional server endpoint.
  try {
    const response = await fetch('./api/status', { signal: AbortSignal.timeout(4000) });
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      providers = (await response.json()).providers || [];
      for (const provider of providers) {
        if (!['deepseek', 'openai'].includes(provider.id)) continue;
        const option = element('option', '', `${provider.id === 'deepseek' ? 'DeepSeek' : 'OpenAI'} · AI 整理`); option.value = provider.id; $('provider').append(option);
      }
    }
  } catch { /* No AI server is needed for the universal workflow. */ }
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});
}
init().catch(() => { storageStatus('初始化失败'); toast('页面初始化失败，请刷新重试。'); });
