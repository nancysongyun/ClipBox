// ===== 常量 / 存储键 =====
const STORAGE_KEY = 'quickPhrases';
const SETTINGS_KEY = 'clipbox_settings';
const TYPE_ICONS_KEY = 'clipbox_type_icons';

const DEFAULT_SETTINGS = {
  title: 'ClipBox',
  icon: 'box'          // heart | cat | book | robot | box
};

const PRESET_ICONS = {
  heart: '❤️',
  cat: '🐱',
  book: '📚',
  robot: '🤖',
  box: '📦',
  github: '🐙'
};

// 默认type图标映射
const DEFAULT_TYPE_ICONS = {
  '通用': '📝',
  '剪贴板': '📋',
  '工作': '💼',
  '学习': '📚',
  '代码': '💻'
};

// 面板总高度（主面板整体不竖向滚动；只让列表滚动）
const POPUP_HEIGHT = 580;

// ===== 数据存取 =====
async function loadItems() {
  const { [STORAGE_KEY]: items } = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(items) ? items : [];
}
async function saveItems(items) {
  await chrome.storage.local.set({ [STORAGE_KEY]: items });
}

async function loadSettings() {
  const { [SETTINGS_KEY]: s } = await chrome.storage.local.get(SETTINGS_KEY);
  const merged = { ...DEFAULT_SETTINGS, ...(s || {}) };
  return merged;
}
async function saveSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function loadTypeIcons() {
  const { [TYPE_ICONS_KEY]: icons } = await chrome.storage.local.get(TYPE_ICONS_KEY);
  return { ...DEFAULT_TYPE_ICONS, ...(icons || {}) };
}
async function saveTypeIcons(icons) {
  await chrome.storage.local.set({ [TYPE_ICONS_KEY]: icons });
}

// 导出/导入 - 新格式：按type分组的数组结构
async function toExportPayload(items) {
  const typeIcons = await loadTypeIcons();
  const grouped = {};

  // 按type分组
  items.forEach(item => {
    const type = item.type || '未分类';
    if (!grouped[type]) {
      grouped[type] = [];
    }
    grouped[type].push({
      id: item.id,
      content: item.content,
      key: item.key || ''  // 关键字字段
    });
  });

  // 转换为数组格式
  return Object.keys(grouped).map(type => ({
    type: type,
    icon: typeIcons[type] || '📌',
    data: grouped[type]
  }));
}

function fromImportPayload(exportData) {
  const now = Date.now();
  const items = [];

  // 兼容旧格式（直接是数组）
  if (Array.isArray(exportData) && exportData.length > 0) {
    if (exportData[0].content && !exportData[0].data) {
      // 旧格式：[{content, type}]
      return exportData
        .filter(x => x && typeof x.content === 'string')
        .map((x, idx) => ({
          id: crypto.randomUUID ? crypto.randomUUID() : `id_${now}_${idx}`,
          content: String(x.content),
          type: String(x.type || '').trim(),
          key: '',
          createdAt: now,
          updatedAt: now
        }));
    }

    // 新格式：[{type, icon, data: [{id, content, key}]}]
    exportData.forEach((typeGroup, groupIdx) => {
      if (!typeGroup.data || !Array.isArray(typeGroup.data)) return;

      typeGroup.data.forEach((item, itemIdx) => {
        if (!item || typeof item.content !== 'string') return;

        items.push({
          id: item.id || (crypto.randomUUID ? crypto.randomUUID() : `id_${now}_${groupIdx}_${itemIdx}`),
          content: String(item.content),
          type: String(typeGroup.type || '').trim(),
          key: String(item.key || '').trim(),
          createdAt: now,
          updatedAt: now
        });
      });
    });
  }

  return items;
}

// 类型 → 颜色
function colorForType(type) {
  if (!type) return '#9aa3af';
  let hash = 0;
  for (let i = 0; i < type.length; i++) {
    hash = (hash << 5) - hash + type.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  const sat = 60 + (Math.abs(hash) % 20);
  const light = 54;
  return `hsl(${hue}deg ${sat}% ${light}%)`;
}

// ====== 渲染和交互 ======
const els = {
  app: document.getElementById('app'),
  list: document.getElementById('list'),
  backTopBtn: document.getElementById('backTopBtn'),
  undoBtn: document.getElementById('undoBtn'),

  // header / settings
  titleIcon: document.getElementById('titleIcon'),
  titleText: document.getElementById('titleText'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsDialog: document.getElementById('settingsDialog'),
  settingsForm: document.getElementById('settingsForm'),
  settingsTitle: document.getElementById('settingsTitle'),

  // 搜索 / 筛选 / 操作按钮
  search: document.getElementById('searchInput'),
  typeFilter: document.getElementById('typeFilter'),
  addBtn: document.getElementById('addBtn'),
  pasteBtn: document.getElementById('pasteBtn'),
  exportBtn: document.getElementById('exportBtn'),
  importFile: document.getElementById('importFile'),

  // 编辑弹窗
  dialog: document.getElementById('editDialog'),
  dialogTitle: document.getElementById('dialogTitle'),
  editForm: document.getElementById('editForm'),
  contentInput: document.getElementById('contentInput'),
  typeInput: document.getElementById('typeInput'),
  keyInput: document.getElementById('keyInput'),
  typeList: document.getElementById('typeList'),
  saveBtn: document.getElementById('saveBtn'),
  itemTpl: document.getElementById('itemTpl'),

  // type图标管理
  typeIconsDialog: document.getElementById('typeIconsDialog'),
  typeIconsForm: document.getElementById('typeIconsForm'),
  typeIconsList: document.getElementById('typeIconsList')
};

let state = {
  items: [],
  filterText: '',
  filterType: '',
  editingId: null,
  settings: { ...DEFAULT_SETTINGS },
  typeIcons: { ...DEFAULT_TYPE_ICONS },
  deletedHistory: [], // 删除历史，最多保留5个
  undoTimer: null // 撤销按钮的定时器
};

function applySettingsToHeader() {
  const s = state.settings || DEFAULT_SETTINGS;
  els.titleText.textContent = s.title || DEFAULT_SETTINGS.title;
  const icon = PRESET_ICONS[s.icon] || PRESET_ICONS[DEFAULT_SETTINGS.icon];
  els.titleIcon.textContent = icon;
}

// 固定面板高度（主面板绝不竖向滚动；只让 .list 滚）
function applyFixedHeight() {
  const px = POPUP_HEIGHT;
  // 设置 html / body 的固定高度
  document.documentElement.style.height = px + 'px';
  document.documentElement.style.maxHeight = px + 'px';
  document.body.style.height = px + 'px';
  document.body.style.maxHeight = px + 'px';
  // 设置 #app 的固定高度（flex 容器，便于 list 占满剩余空间）
  if (els.app) {
    els.app.style.height = px + 'px';
    els.app.style.maxHeight = px + 'px';
  }
}

function rebuildTypeFilter() {
  const types = [...new Set(state.items.map(i => i.type).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  const current = els.typeFilter.value;
  els.typeFilter.innerHTML = `<option value="">全部类别</option>` +
    types.map(t => `<option value="${encodeURIComponent(t)}">${escapeHTML(t)}</option>`).join('');
  els.typeFilter.value = types.includes(decodeURIComponent(current)) ? current : '';
}
function rebuildTypeDatalist() {
  const types = [...new Set(state.items.map(i => i.type).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  els.typeList.innerHTML = types.map(t => `<option value="${escapeHTML(t)}"></option>`).join('');
}

function renderList() {
  const q = state.filterText.trim().toLowerCase();
  const t = decodeURIComponent(state.filterType || '');
  const filtered = state.items
    .filter(i => (t ? (i.type === t) : true))
    .filter(i => (q ? (i.content.toLowerCase().includes(q) || (i.type || '').toLowerCase().includes(q) || (i.key || '').toLowerCase().includes(q)) : true))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  els.list.innerHTML = '';
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.style.color = '#9aa3af';
    empty.style.textAlign = 'center';
    empty.style.padding = '24px 8px';
    empty.textContent = '暂无数据';
    els.list.appendChild(empty);
    // 末尾 1px 哨兵，便于"回到顶部"逻辑统一
    const sentinel = document.createElement('div');
    sentinel.style.height = '1px';
    els.list.appendChild(sentinel);
    updateBackTopVisibility();
    return;
  }

  for (const item of filtered) {
    const node = els.itemTpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id;

    // 使用emoji图标
    const typeIcon = state.typeIcons[item.type] || '📌';
    node.querySelector('.typeIcon').textContent = typeIcon;

    node.querySelector('.content').textContent = item.content;
    node.querySelector('.typeTag').textContent = item.type || '未分类';

    // 显示关键字（如果有）
    const keyTag = node.querySelector('.keyTag');
    if (item.key && item.key.trim()) {
      keyTag.textContent = item.key;
      keyTag.style.display = 'inline-flex';
    } else {
      keyTag.style.display = 'none';
    }

    els.list.appendChild(node);
  }
  // 列表末尾哨兵
  const sentinel = document.createElement('div');
  sentinel.style.height = '1px';
  els.list.appendChild(sentinel);
  updateBackTopVisibility();
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

async function refresh() {
  applySettingsToHeader();
  applyFixedHeight();
  rebuildTypeFilter();
  rebuildTypeDatalist();
  renderList();
}

// 打开/关闭编辑弹窗
function openDialog(mode, item) {
  state.editingId = mode === 'edit' ? item.id : null;
  els.dialogTitle.textContent = mode === 'edit' ? '编辑用语' : '新增用语';
  els.contentInput.value = item?.content || '';
  els.typeInput.value = item?.type || '';
  els.keyInput.value = item?.key || '';
  els.dialog.showModal();
}
function closeDialog() {
  state.editingId = null;
  els.editForm.reset();
  els.dialog.close();
}

// 剪贴板权限（可选）
async function ensureClipboardReadPermission() {
  if (!chrome?.permissions) return true;
  const has = await chrome.permissions.contains({ permissions: ['clipboardRead'] });
  if (has) return true;
  try { return await chrome.permissions.request({ permissions: ['clipboardRead'] }); }
  catch { return false; }
}

// "回到顶部"显隐（以列表滚动位置为准）
function updateBackTopVisibility() {
  if (!els.list || !els.backTopBtn) return;
  const nearBottom = (els.list.scrollTop + els.list.clientHeight) >= (els.list.scrollHeight - 2);
  els.backTopBtn.classList.toggle('show', nearBottom);
}

// 显示撤销按钮（5秒后自动隐藏）
function showUndoButton() {
  if (!els.undoBtn) return;

  // 清除之前的定时器
  if (state.undoTimer) {
    clearTimeout(state.undoTimer);
  }

  // 显示撤销按钮
  els.undoBtn.classList.add('show');

  // 5秒后隐藏
  state.undoTimer = setTimeout(() => {
    els.undoBtn.classList.remove('show');
    state.undoTimer = null;
  }, 5000);
}

// 添加到删除历史
function addToDeletedHistory(item) {
  state.deletedHistory.push(item);
  // 最多保留5个
  if (state.deletedHistory.length > 5) {
    state.deletedHistory.shift();
  }
  showUndoButton();
}

// 撤销删除
async function undoDelete() {
  if (state.deletedHistory.length === 0) return;

  const item = state.deletedHistory.pop();
  state.items.push(item);
  await saveItems(state.items);
  await refresh();

  // 如果没有更多可撤销的项，隐藏按钮
  if (state.deletedHistory.length === 0) {
    els.undoBtn.classList.remove('show');
    if (state.undoTimer) {
      clearTimeout(state.undoTimer);
      state.undoTimer = null;
    }
  }
}

// —— 新增/编辑弹窗提交：保存逻辑（修复"新增无效"问题） —— //
if (els.editForm) {
  els.editForm.addEventListener('submit', async (e) => {
    // 如果点击的是"取消"按钮，直接交给 <dialog> 默认关闭
    if (e.submitter && e.submitter.id === 'cancelBtn') return;

    e.preventDefault();

    const content = (els.contentInput.value || '').trim();
    const type = (els.typeInput.value || '').trim();
    const key = (els.keyInput.value || '').trim();
    if (!content) {
      alert('内容不能为空');
      return;
    }

    const now = Date.now();

    if (state.editingId) {
      // 编辑模式
      const idx = state.items.findIndex(x => x.id === state.editingId);
      if (idx !== -1) {
        state.items[idx] = {
          ...state.items[idx],
          content,
          type,
          key,
          updatedAt: now
        };
      }
    } else {
      // 新增模式：加到列表顶部
      state.items.unshift({
        id: crypto.randomUUID ? crypto.randomUUID() : `id_${now}_${Math.random().toString(16).slice(2)}`,
        content,
        type,
        key,
        createdAt: now,
        updatedAt: now
      });
    }

    await saveItems(state.items);
    state.editingId = null;
    els.editForm.reset();
    els.dialog.close();
    await refresh();
  });
}

// ===== 初始化与事件绑定 =====
(async function init() {
  state.items = await loadItems();
  state.settings = await loadSettings();
  state.typeIcons = await loadTypeIcons();
  await refresh();

  // 搜索
  els.search.addEventListener('input', () => {
    state.filterText = els.search.value || '';
    renderList();
  });

  // 分类筛选
  els.typeFilter.addEventListener('change', () => {
    state.filterType = els.typeFilter.value || '';
    renderList();
  });

  // 新增
  els.addBtn.addEventListener('click', () => openDialog('add'));

  // 粘贴
  els.pasteBtn.addEventListener('click', async () => {
    try {
      const ok = await ensureClipboardReadPermission();
      if (!ok) { alert('需要“读取剪贴板”权限。'); return; }
      const text = await navigator.clipboard.readText();
      const content = (text || '').trim();
      if (!content) { alert('剪贴板为空或不可读取文本。'); return; }
      const now = Date.now();
      state.items.unshift({
        id: crypto.randomUUID ? crypto.randomUUID() : `id_${now}_${Math.random().toString(16).slice(2)}`,
        content, type: '剪贴板', key: '', createdAt: now, updatedAt: now
      });
      await saveItems(state.items);
      await refresh();
      els.pasteBtn.disabled = true;
      const old = els.pasteBtn.innerHTML;
      els.pasteBtn.innerHTML = '<span class="toolIcon" aria-hidden="true">✅</span><span class="toolText">已新增</span>';
      setTimeout(() => { els.pasteBtn.innerHTML = old; els.pasteBtn.disabled = false; }, 900);
    } catch (err) {
      alert('无法读取剪贴板：' + (err?.message || err));
    }
  });

  // 导出
  els.exportBtn.addEventListener('click', async () => {
    const payload = await toExportPayload(state.items);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    a.href = url; a.download = `clipbox_${ts}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });

  // 导入
  els.importFile.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('JSON 格式应为数组');
      const toAdd = fromImportPayload(parsed);
      if (!toAdd.length) throw new Error('没有可导入的项');

      const cover = confirm('是否覆盖现有数据？\n确定=覆盖；取消=合并追加');
      state.items = cover ? toAdd : [...toAdd, ...state.items];
      await saveItems(state.items);
      await refresh();
      alert(`导入成功：${toAdd.length} 条`);
    } catch (err) {
      console.error(err);
      alert('导入失败：' + (err?.message || err));
    } finally { e.target.value = ''; }
  });

  // 列表事件委托
  els.list.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const itemEl = ev.target.closest('.item');
    const id = itemEl?.dataset?.id;
    const item = state.items.find(x => x.id === id);
    if (!item) return;

    if (btn.classList.contains('copyBtn')) {
      try {
        await navigator.clipboard.writeText(item.content);
        btn.textContent = '已复制';
        setTimeout(() => btn.textContent = '复制', 800);
      } catch (e) {
        alert('复制失败：' + e.message);
      }
      return;
    }
    if (btn.classList.contains('editBtn')) { openDialog('edit', item); return; }
    if (btn.classList.contains('delBtn')) {
      if (!confirm('确认删除该条用语？')) return;

      // 添加到删除历史
      addToDeletedHistory({ ...item });

      // 从列表中移除
      state.items = state.items.filter(x => x.id !== id);
      await saveItems(state.items);
      await refresh();
      return;
    }
  });

  // 设置面板
  els.settingsBtn.addEventListener('click', () => {
    els.settingsTitle.value = state.settings?.title || DEFAULT_SETTINGS.title;

    const iconValue = state.settings?.icon || DEFAULT_SETTINGS.icon;
    els.settingsForm.querySelectorAll('input[name="titleIcon"]').forEach(r => {
      r.checked = (r.value === iconValue);
    });

    // 填充type图标列表
    buildTypeIconsList();

    els.settingsDialog.showModal();
  });

  // 构建type图标列表
  function buildTypeIconsList() {
    const types = [...new Set(state.items.map(i => i.type).filter(Boolean))].sort((a,b)=>a.localeCompare(b));

    if (!els.typeIconsList) return;

    els.typeIconsList.innerHTML = '';

    if (types.length === 0) {
      els.typeIconsList.innerHTML = '<div style="color:#9aa3af;padding:12px;text-align:center;">暂无类别</div>';
      return;
    }

    types.forEach(type => {
      const currentIcon = state.typeIcons[type] || '📌';
      const row = document.createElement('div');
      row.className = 'type-icon-row';
      row.innerHTML = `
        <span class="type-name">${escapeHTML(type)}</span>
        <input type="text" class="emoji-input" data-type="${escapeHTML(type)}" value="${escapeHTML(currentIcon)}" placeholder="📌" maxlength="2" />
      `;
      els.typeIconsList.appendChild(row);
    });
  }

  els.settingsForm.addEventListener('submit', async (e) => {
    const isCancel = e.submitter && e.submitter.id === 'settingsCancelBtn';
    if (isCancel) return; // 交给 <dialog> 默认关闭

    e.preventDefault();
    const title = (els.settingsTitle.value || '').trim() || DEFAULT_SETTINGS.title;
    const selectedIcon = els.settingsForm.querySelector('input[name="titleIcon"]:checked');
    const icon = selectedIcon ? selectedIcon.value : DEFAULT_SETTINGS.icon;

    // 保存type图标设置
    if (els.typeIconsList) {
      const emojiInputs = els.typeIconsList.querySelectorAll('.emoji-input');
      emojiInputs.forEach(input => {
        const type = input.dataset.type;
        const emoji = input.value.trim();
        if (type && emoji) {
          state.typeIcons[type] = emoji;
        }
      });
      await saveTypeIcons(state.typeIcons);
    }

    state.settings = { title, icon };
    await saveSettings(state.settings);
    applySettingsToHeader();
    await refresh();
    els.settingsDialog.close();
  });

  // 列表滚动时判断“回到顶部”显示
  els.list.addEventListener('scroll', updateBackTopVisibility);
  updateBackTopVisibility();

  // 回到顶部
  els.backTopBtn.addEventListener('click', () => {
    els.list.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // 撤销删除
  els.undoBtn.addEventListener('click', undoDelete);

  // 首次无数据时放入示例
  if (state.items.length === 0) {
    state.items = fromImportPayload([
      { content: '记录账号密码，方便检索。🔐📝', type: '通用' },
      { content: '粘贴AI指令便于快捷使用 🤖✨', type: '通用' },
      { content: '记录任意内容，发挥你的想象力 🧠💡', type: '通用' }
    ]);
    await saveItems(state.items);
    await refresh();
  }
})();
