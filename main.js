const {
  Plugin, ItemView, PluginSettingTab, Setting,
  MarkdownRenderer, Modal, Notice,
} = require('obsidian');

const VIEW_TYPE = 'diary-link-timeline-view';
const EXPORT_PREFIX = '_timeline-export-';
const LINK_RE = /(?<!!)\[\[([^\]|#]+)/g;
const UNLINKED_FILTER = '__unlinked__';

const DEFAULT_SETTINGS = {
  diaryFolder: '日记',
  exportFolder: '',
  exportNameTemplate: '{{title}}-{{datetime}}',
  exportTitle: '日记链接时间轴',
  enableClickActions: true, // 总开关
  linkClickAction: 'navigate', // 'navigate' | 'filter'
  textClickCopy: true,
};

async function writeClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

class DiaryLinkTimelinePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    const oldStyle = document.getElementById('diary-link-timeline-style');
    if (oldStyle) oldStyle.remove();
    const style = document.createElement('style');
    style.id = 'diary-link-timeline-style';
    style.textContent = `
      .diary-timeline-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
      .diary-timeline-toolbar select { max-width: 260px; }
      .diary-timeline-status { color: var(--text-muted); font-size: 0.85em; }
      .diary-timeline-content h1 { margin-top: 32px; border-bottom: 2px solid var(--text-accent); padding-bottom: 6px; font-size: 1.5em; }
      .diary-timeline-content h2 { margin-top: 24px; border-bottom: 2px solid var(--background-modifier-border); padding-bottom: 4px; }
      .diary-timeline-content h3 { margin-top: 16px; color: var(--text-accent); }
      .diary-timeline-content h3.diary-timeline-date { display: inline-block; }
      .diary-timeline-entry { display: flex; gap: 8px; margin: 8px 0; padding: 8px; border-left: 3px solid var(--interactive-accent); background: var(--background-secondary); border-radius: 4px; }
      .diary-timeline-entry.is-unlinked { border-left-color: var(--background-modifier-border); opacity: 0.85; }
      .diary-timeline-time { font-weight: 600; color: var(--text-accent); white-space: nowrap; font-variant-numeric: tabular-nums; padding: 0 4px; border-radius: 3px; transition: background 0.15s; user-select: none; }
      .diary-timeline-text { flex: 1; min-width: 0; border-radius: 3px; transition: background 0.15s; }
      .diary-timeline-text.is-copied { background: var(--text-selection); transition: background 0.3s; }
      .diary-timeline-text p:first-child { margin-top: 0; }
      .diary-timeline-text p:last-child { margin-bottom: 0; }
      .diary-timeline-preview { margin: 12px 0; padding: 8px; background: var(--background-secondary); border-radius: 4px; font-family: var(--font-monospace); font-size: 0.9em; word-break: break-all; color: var(--text-muted); }
      .diary-timeline-buttons { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
      .diary-timeline-hint { margin-bottom: 12px; color: var(--text-muted); font-size: 0.9em; }

      /* 仅在总开关开启时，才显示可点击/可复制的光标与 hover 效果 */
      .diary-timeline-content.click-enabled .diary-timeline-time { cursor: pointer; }
      .diary-timeline-content.click-enabled .diary-timeline-time:hover { background: var(--background-modifier-hover); text-decoration: underline; }
      .diary-timeline-content.click-enabled .diary-timeline-time:active { background: var(--background-modifier-active-hover); }
      .diary-timeline-content.click-enabled .diary-timeline-date { cursor: pointer; }
      .diary-timeline-content.click-enabled .diary-timeline-date:hover { text-decoration: underline; }
      .diary-timeline-content.click-enabled .diary-timeline-text { cursor: copy; }
    `;
    document.head.appendChild(style);
    this.register(() => style.remove());

    this.registerView(VIEW_TYPE, (leaf) => new TimelineView(leaf, this));

    this.addCommand({
      id: 'open-diary-link-timeline',
      name: '打开日记链接时间轴',
      callback: () => this.activateView(),
    });

    this.addRibbonIcon('git-branch', '日记链接时间轴', () => this.activateView());
    this.addSettingTab(new TimelineSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  isInDiaryFolder(path) {
    const folder = (this.settings.diaryFolder || '').replace(/^\/+|\/+$/g, '');
    if (!folder) return true;
    return path.startsWith(folder + '/');
  }

  pad(n) { return n < 10 ? '0' + n : String(n); }
  formatDate(d) { return `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`; }
  formatTime(d) { return `${this.pad(d.getHours())}${this.pad(d.getMinutes())}${this.pad(d.getSeconds())}`; }
  formatTimestamp(d) { return `${this.formatDate(d).replace(/-/g, '')}-${this.formatTime(d)}`; }
  formatDateTime(d) { return `${this.formatDate(d)} ${this.pad(d.getHours())}:${this.pad(d.getMinutes())}:${this.pad(d.getSeconds())}`; }

  buildTemplateVars(entries, now, extra) {
    now = now || new Date();
    const df = (this.settings.diaryFolder || '').replace(/^\/+|\/+$/g, '');
    const lastSeg = df ? df.split('/').pop() : '';
    const vars = {
      title: this.settings.exportTitle || '日记链接时间轴',
      date: this.formatDate(now),
      time: this.formatTime(now),
      datetime: this.formatTimestamp(now),
      year: String(now.getFullYear()),
      month: this.pad(now.getMonth() + 1),
      day: this.pad(now.getDate()),
      count: String(entries.length),
      folder: lastSeg,
      filter: '全部',
    };
    if (extra) Object.assign(vars, extra);
    return vars;
  }

  applyTemplate(tpl, vars) {
    return (tpl || '').replace(/\{\{(\w+)\}\}/g, (m, key) => {
      return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m;
    });
  }

  buildExportMarkdown(entries) {
    const now = new Date();
    const lines = [
      '> 导出时间：' + this.formatDateTime(now) + ' · 共 ' + entries.length + ' 条',
      '',
    ];

    let lastYear = null;
    let lastMonth = null;
    let lastDate = null;

    for (const e of entries) {
      const year = e.date.slice(0, 4);
      if (year !== lastYear) {
        lines.push(`# ${year}`, '');
        lastYear = year; lastMonth = null; lastDate = null;
      }
      if (e.month !== lastMonth) {
        lines.push(`## ${e.month}`, '');
        lastMonth = e.month; lastDate = null;
      }
      if (e.date !== lastDate) {
        lines.push(`### ${e.date}`, '');
        lastDate = e.date;
      }
      const src = e.sourcePath.replace(/\.md$/, '');
      lines.push(`**${e.time}** · [[${src}]]`, '', e.text, '', '---', '');
    }

    return lines.join('\n').replace(/\n---\n\s*$/, '\n');
  }
}

// ============================================================
//  视图
// ============================================================

class TimelineView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.fileCache = new Map();
    this.lastEntries = [];
    this.filteredEntries = [];
    this._timer = null;
    this._rendering = false;
    this._pendingRefresh = false;
    this._lastTargetsKey = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return '日记链接时间轴'; }
  getIcon() { return 'git-branch'; }

  async onOpen() {
    const container = this.contentEl;
    container.empty();
    container.addClass('diary-link-timeline-container');

    const toolbar = container.createDiv({ cls: 'diary-timeline-toolbar' });

    const refreshBtn = toolbar.createEl('button', { text: '刷新' });
    refreshBtn.onclick = () => this.render(true);

    toolbar.createSpan({ text: '筛选：', cls: 'diary-timeline-status' });
    this.filterEl = toolbar.createEl('select');
    this.filterEl.onchange = () => this.renderView();

    const exportBtn = toolbar.createEl('button', { text: '导出…' });
    exportBtn.onclick = () => this.openExportModal();

    this.statusEl = toolbar.createSpan({ cls: 'diary-timeline-status' });
    this.listEl = container.createDiv({ cls: 'diary-timeline-content' });

    const onChange = (file) => {
      if (!file || !file.path) return;
      if (!this.plugin.isInDiaryFolder(file.path)) return;
      const name = file.name || file.path.split('/').pop() || '';
      if (name.startsWith(EXPORT_PREFIX)) return;
      this.scheduleRefresh();
    };
    this.registerEvent(this.app.vault.on('modify', onChange));
    this.registerEvent(this.app.vault.on('create', onChange));
    this.registerEvent(this.app.vault.on('delete', onChange));
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => {
      if (this.plugin.isInDiaryFolder(f.path) || this.plugin.isInDiaryFolder(oldPath)) {
        this.fileCache.clear();
        this.scheduleRefresh();
      }
    }));

    await this.render(true);
  }

  filterLabel(value) {
    if (!value) return '全部';
    if (value === UNLINKED_FILTER) return '无链接';
    return value;
  }

  openExportModal() {
    const entries = this.filteredEntries || [];
    if (!entries.length) {
      new Notice('当前筛选下没有可导出的内容');
      return;
    }
    const filterValue = this.filterLabel(this.filterEl ? this.filterEl.value : '');
    new ExportModal(this.app, this.plugin, entries.slice(), filterValue).open();
  }

  scheduleRefresh() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this.render(); }, 400);
  }

  extractDate(file) {
    const m = file.basename.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache && cache.frontmatter) {
      const raw = cache.frontmatter.date || cache.frontmatter.created || cache.frontmatter.day;
      if (raw instanceof Date) return raw.toISOString().slice(0, 10);
      if (raw) {
        const s = String(raw).slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      }
    }
    return null;
  }

  parseContent(content, date, sourcePath) {
    const lines = content.split('\n');
    const blocks = [];
    let current = null;

    const isHeading = (line) => /^#{1,6}(?:\s|$)/.test(line);
    const isDivider = (line) => /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^\s*-\s*(\d{2}:\d{2}:\d{2})(.*)$/);
      if (m) {
        if (current) blocks.push(current);
        current = { time: m[1], text: (m[2] || '').replace(/^\s+/, ''), line: i };
        continue;
      }
      if (current) {
        if (isHeading(line) || isDivider(line)) {
          blocks.push(current);
          current = null;
        } else {
          current.text += '\n' + line;
        }
      }
    }
    if (current) blocks.push(current);

    const out = [];
    for (const b of blocks) {
      const text = b.text.trim();
      if (!text) continue;
      out.push({ date, month: date.slice(0, 7), time: b.time, text, sourcePath, line: b.line });
    }
    return out;
  }

  async getFileEntries(file, force) {
    const cached = this.fileCache.get(file.path);
    if (!force && cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
      return cached.entries;
    }
    let content;
    try {
      content = await this.app.vault.cachedRead(file);
    } catch (e) {
      return [];
    }
    const date = this.extractDate(file);
    if (!date) {
      this.fileCache.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, entries: [] });
      return [];
    }
    const entries = this.parseContent(content, date, file.path);
    this.fileCache.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, entries });
    return entries;
  }

  async collectEntries(force) {
    const folder = (this.plugin.settings.diaryFolder || '').replace(/^\/+|\/+$/g, '');
    const files = this.app.vault.getMarkdownFiles().filter((f) => {
      if (f.name.startsWith(EXPORT_PREFIX)) return false;
      if (!folder) return true;
      return f.path.startsWith(folder + '/');
    });

    const results = [];
    const concurrency = 8;
    let idx = 0;
    const workers = [];
    for (let w = 0; w < Math.min(concurrency, files.length); w++) {
      workers.push((async () => {
        while (idx < files.length) {
          const i = idx++;
          const entries = await this.getFileEntries(files[i], force);
          for (const e of entries) results.push(e);
        }
      })());
    }
    await Promise.all(workers);

    results.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.time !== b.time) return a.time < b.time ? -1 : 1;
      return a.sourcePath < b.sourcePath ? -1 : 1;
    });
    return results;
  }

  // ---------- 筛选相关 ----------

  collectLinkTargets(entries) {
    const set = new Set();
    for (const e of entries) {
      LINK_RE.lastIndex = 0;
      let m;
      while ((m = LINK_RE.exec(e.text)) !== null) {
        const t = m[1].trim();
        if (t) set.add(t);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'));
  }

  updateFilterOptions(targets) {
    const key = targets.join('\u0001');
    if (key === this._lastTargetsKey) return;
    this._lastTargetsKey = key;

    const current = this.filterEl.value;
    this.filterEl.empty();
    this.filterEl.createEl('option', { value: '', text: '全部' });
    this.filterEl.createEl('option', { value: UNLINKED_FILTER, text: '无链接' });
    for (const t of targets) {
      this.filterEl.createEl('option', { value: t, text: t });
    }

    if (current === UNLINKED_FILTER || (current && targets.includes(current))) {
      this.filterEl.value = current;
    } else {
      this.filterEl.value = '';
    }
  }

  entryHasLink(entry) {
    LINK_RE.lastIndex = 0;
    return LINK_RE.test(entry.text);
  }

  entryHasTarget(entry, target) {
    LINK_RE.lastIndex = 0;
    let m;
    while ((m = LINK_RE.exec(entry.text)) !== null) {
      if (m[1].trim() === target) return true;
    }
    return false;
  }

  applyFilter(entries) {
    const f = this.filterEl.value;
    if (!f) return entries;
    if (f === UNLINKED_FILTER) return entries.filter((e) => !this.entryHasLink(e));
    return entries.filter((e) => this.entryHasTarget(e, f));
  }

  // ---------- 交互：跳转 / 筛选 / 复制 ----------

  async openFileInWorkspace(file) {
    let targetLeaf = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!targetLeaf && leaf.view && leaf.view.file && leaf.view.file.path === file.path) {
        targetLeaf = leaf;
      }
    });
    if (!targetLeaf) {
      const activeLeaf = this.app.workspace.activeLeaf;
      if (activeLeaf && activeLeaf.view && typeof activeLeaf.view.getViewType === 'function'
        && activeLeaf.view.getViewType() === 'markdown') {
        targetLeaf = activeLeaf;
      }
    }
    if (!targetLeaf) targetLeaf = this.app.workspace.getLeaf('tab');
    await targetLeaf.openFile(file);
    try { this.app.workspace.setActiveLeaf(targetLeaf, { focus: true }); } catch (e) { /* ignore */ }
    return targetLeaf;
  }

  async jumpToSource(entry) {
    const file = this.app.vault.getAbstractFileByPath(entry.sourcePath);
    if (!file) {
      new Notice('找不到源文件：' + entry.sourcePath);
      return;
    }
    try {
      const targetLeaf = await this.openFileInWorkspace(file);
      const view = targetLeaf.view;
      const editor = view && view.editor;
      if (editor) {
        const pos = { line: entry.line, ch: 0 };
        editor.setCursor(pos);
        editor.scrollIntoView({ from: pos, to: pos }, true);
        editor.focus();
      }
    } catch (err) {
      console.error('[diary-link-timeline] jump failed', err);
      new Notice('跳转失败：' + (err && err.message ? err.message : String(err)));
    }
  }

  findDiaryForDate(dateStr) {
    const folder = (this.plugin.settings.diaryFolder || '').replace(/^\/+|\/+$/g, '');
    const files = this.app.vault.getMarkdownFiles().filter((f) => {
      if (f.name.startsWith(EXPORT_PREFIX)) return false;
      if (!folder) return true;
      return f.path.startsWith(folder + '/');
    });

    for (const f of files) {
      if (f.basename.includes(dateStr)) return f;
    }
    for (const f of files) {
      const cache = this.app.metadataCache.getFileCache(f);
      if (!cache || !cache.frontmatter) continue;
      const raw = cache.frontmatter.date || cache.frontmatter.created || cache.frontmatter.day;
      if (!raw) continue;
      const s = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw).slice(0, 10);
      if (s === dateStr) return f;
    }
    return null;
  }

  async jumpToDiary(dateStr) {
    const file = this.findDiaryForDate(dateStr);
    if (!file) {
      new Notice('未找到 ' + dateStr + ' 的日记文件');
      return;
    }
    try {
      await this.openFileInWorkspace(file);
    } catch (err) {
      console.error('[diary-link-timeline] open diary failed', err);
      new Notice('打开日记失败：' + (err && err.message ? err.message : String(err)));
    }
  }

  // 点击双链时按目标值筛选
  applyFilterForLink(rawTarget) {
    const normalize = (s) => String(s || '')
      .replace(/\.md$/, '')
      .replace(/^\.\//, '')
      .split('#')[0]
      .trim();
    const target = normalize(rawTarget);
    if (!target) return false;

    const opts = Array.from(this.filterEl.options).map((o) => o.value);
    if (opts.includes(target)) {
      this.filterEl.value = target;
      this.renderView();
      return true;
    }
    // 路径不一致时，用 basename 兜底
    const base = target.split('/').pop();
    const found = opts.find((v) => v && v.split('/').pop() === base);
    if (found) {
      this.filterEl.value = found;
      this.renderView();
      return true;
    }
    return false;
  }

  bindTimeClick(timeEl, entry) {
    timeEl.title = '点击跳转到原文位置';
    timeEl.addEventListener('click', (e) => {
      if (!this.plugin.settings.enableClickActions) return;
      e.preventDefault();
      e.stopPropagation();
      this.jumpToSource(entry);
    });
  }

  bindDateClick(h3, dateStr) {
    h3.title = '点击打开该日期的日记';
    h3.addEventListener('click', (e) => {
      if (!this.plugin.settings.enableClickActions) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      e.preventDefault();
      this.jumpToDiary(dateStr);
    });
  }

  bindTextCopy(textEl, entry) {
    const s = () => this.plugin.settings;
    const enabled = () => !!s().enableClickActions;
    const copyEnabled = () => enabled() && !!s().textClickCopy;

    let pressTimer = null;
    let pressStart = 0;
    let moved = false;
    let justCopied = false;
    const isLinkEl = (el) => !!(el && el.closest && el.closest('a'));

    const doCopy = async () => {
      const ok = await writeClipboard(entry.text);
      if (ok) {
        new Notice('已复制');
        textEl.classList.add('is-copied');
        setTimeout(() => textEl.classList.remove('is-copied'), 300);
      } else {
        new Notice('复制失败');
      }
    };

    // 1) 双链点击：仅当总开关开启且 linkClickAction === 'filter' 时拦截
    textEl.addEventListener('click', (e) => {
      if (!enabled()) return; // 关闭时完全让原生行为接管
      const linkEl = e.target.closest('a');
      if (!linkEl) return;
      const isInternal = linkEl.classList.contains('internal-link') || linkEl.hasAttribute('data-href');
      if (!isInternal) return; // 外部链接也交给原生
      if ((s().linkClickAction || 'navigate') !== 'filter') return; // navigate 时交给原生

      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();

      let raw = linkEl.getAttribute('data-href') || linkEl.getAttribute('href') || '';
      try { raw = decodeURIComponent(raw); } catch (err) { /* ignore */ }

      if (!this.applyFilterForLink(raw)) {
        new Notice('筛选列表中未找到该链接目标：' + raw);
      }
    }, true);

    // 2) 文字短按/长按复制：受总开关 + 文字复制开关双重控制
    textEl.addEventListener('pointerdown', (e) => {
      if (!copyEnabled()) return;
      if (isLinkEl(e.target)) return;
      pressStart = Date.now();
      moved = false;
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        if (!moved) {
          doCopy();
          justCopied = true;
        }
        pressTimer = null;
      }, 600);
    });

    textEl.addEventListener('pointermove', () => { moved = true; });

    textEl.addEventListener('pointerup', (e) => {
      if (!copyEnabled()) { moved = true; return; }
      if (isLinkEl(e.target)) { moved = true; return; }
      const elapsed = Date.now() - pressStart;
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
        if (!moved && elapsed < 600) {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed) {
            doCopy();
          }
        }
      }
    });

    textEl.addEventListener('pointercancel', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      moved = true;
    });

    textEl.addEventListener('contextmenu', (e) => {
      if (justCopied) {
        e.preventDefault();
        justCopied = false;
      }
    });
  }

  // ---------- 渲染 ----------

  async render(force) {
    if (this._rendering) { this._pendingRefresh = true; return; }
    this._rendering = true;
    const t0 = performance.now();
    try {
      this.statusEl.setText('加载中…');
      const entries = await this.collectEntries(force);
      this.lastEntries = entries;
      this.updateFilterOptions(this.collectLinkTargets(entries));
      await this.renderView(t0);
    } catch (err) {
      console.error('[diary-link-timeline]', err);
      this.listEl.empty();
      this.listEl.createEl('p', { text: '渲染出错：' + (err && err.message ? err.message : String(err)) });
      this.statusEl.setText('');
    } finally {
      this._rendering = false;
      if (this._pendingRefresh) {
        this._pendingRefresh = false;
        this.scheduleRefresh();
      }
    }
  }

  async renderView(t0) {
    // 根据总开关更新光标/hover 状态
    if (this.listEl) {
      this.listEl.toggleClass('click-enabled', !!this.plugin.settings.enableClickActions);
    }

    const entries = this.applyFilter(this.lastEntries);
    this.filteredEntries = entries;

    this.listEl.empty();

    if (entries.length === 0) {
      if (this.lastEntries.length === 0) {
        this.listEl.createEl('p', { text: '未找到 “- hh:mm:ss” 格式的时间块。' });
      } else {
        const f = this.filterLabel(this.filterEl.value);
        this.listEl.createEl('p', { text: `当前筛选下无结果（共 ${this.lastEntries.length} 条时间块，筛选：${f}）。` });
      }
      this.statusEl.setText('');
      return;
    }

    const frag = document.createDocumentFragment();
    const tasks = [];
    let lastYear = null, lastMonth = null, lastDate = null;

    for (const e of entries) {
      const year = e.date.slice(0, 4);
      if (year !== lastYear) {
        const h1 = document.createElement('h1');
        h1.textContent = year;
        frag.appendChild(h1);
        lastYear = year; lastMonth = null; lastDate = null;
      }
      if (e.month !== lastMonth) {
        const h2 = document.createElement('h2');
        h2.textContent = e.month;
        frag.appendChild(h2);
        lastMonth = e.month; lastDate = null;
      }
      if (e.date !== lastDate) {
        const h3 = document.createElement('h3');
        h3.className = 'diary-timeline-date';
        h3.textContent = e.date;
        this.bindDateClick(h3, e.date);
        frag.appendChild(h3);
        lastDate = e.date;
      }
      const row = document.createElement('div');
      row.className = 'diary-timeline-entry';
      if (!this.entryHasLink(e)) row.classList.add('is-unlinked');

      const timeEl = document.createElement('span');
      timeEl.className = 'diary-timeline-time';
      timeEl.textContent = e.time;
      this.bindTimeClick(timeEl, e);
      row.appendChild(timeEl);

      const textEl = document.createElement('div');
      textEl.className = 'diary-timeline-text';
      this.bindTextCopy(textEl, e);
      row.appendChild(textEl);

      frag.appendChild(row);
      tasks.push(this.renderMarkdown(e.text, textEl, e.sourcePath));
    }

    this.listEl.appendChild(frag);
    await Promise.all(tasks);

    const ms = typeof t0 === 'number' ? Math.round(performance.now() - t0) : 0;
    const f = this.filterLabel(this.filterEl.value);
    const suffix = this.filterEl.value ? `（筛选：${f}）` : '';
    this.statusEl.setText(`${entries.length} 条${suffix}${ms ? ' · ' + ms + 'ms' : ''}`);
  }

  renderMarkdown(md, el, sourcePath) {
    if (MarkdownRenderer && typeof MarkdownRenderer.render === 'function') {
      return MarkdownRenderer.render(this.app, md, el, sourcePath, this).catch((e) => {
        el.textContent = md;
        console.error(e);
      });
    }
    if (MarkdownRenderer && typeof MarkdownRenderer.renderMarkdown === 'function') {
      try {
        MarkdownRenderer.renderMarkdown(md, el, sourcePath, this);
      } catch (e) {
        el.textContent = md;
        console.error(e);
      }
    } else {
      el.textContent = md;
    }
    return Promise.resolve();
  }

  async onClose() {
    if (this._timer) clearTimeout(this._timer);
    this.fileCache.clear();
  }
}

// ============================================================
//  导出弹窗
// ============================================================

class ExportModal extends Modal {
  constructor(app, plugin, entries, filterValue) {
    super(app);
    this.plugin = plugin;
    this.entries = entries;
    this.filterValue = filterValue || '';
    this._folder = plugin.settings.exportFolder || '';
    this._nameTpl = plugin.settings.exportNameTemplate || '{{title}}-{{datetime}}';
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText('导出时间轴');

    const filterLabel = this.filterValue || '全部';
    contentEl.createDiv({
      cls: 'diary-timeline-hint',
      text: `将导出 ${this.entries.length} 条（筛选：${filterLabel}）。`,
    });

    new Setting(contentEl)
      .setName('导出文件夹')
      .setDesc('留空则使用日记文件夹：' + ((this.plugin.settings.diaryFolder || '(库根目录)').replace(/^\/+|\/+$/g, '') || '(库根目录)'))
      .addText((t) => {
        t.setPlaceholder('如：日记/导出')
          .setValue(this._folder)
          .onChange((v) => { this._folder = v.trim(); this.updatePreview(); });
      });

    new Setting(contentEl)
      .setName('文件名模板')
      .setDesc('支持：{{title}} {{date}} {{time}} {{datetime}} {{year}} {{month}} {{day}} {{count}} {{folder}} {{filter}}')
      .addText((t) => {
        t.setPlaceholder('{{title}}-{{datetime}}')
          .setValue(this._nameTpl)
          .onChange((v) => { this._nameTpl = v.trim(); this.updatePreview(); });
      });

    this.previewEl = contentEl.createDiv({ cls: 'diary-timeline-preview' });

    const btns = contentEl.createDiv({ cls: 'diary-timeline-buttons' });
    btns.createEl('button', { text: '导出到库', cls: 'mod-cta' }).onclick = () => this.doExportToVault();
    btns.createEl('button', { text: '下载 .md' }).onclick = () => this.doDownload();
    btns.createEl('button', { text: '取消' }).onclick = () => this.close();

    this.updatePreview();
  }

  buildVars(now) {
    return this.plugin.buildTemplateVars(this.entries, now, { filter: this.filterValue || '全部' });
  }

  resolveFolder() {
    const user = (this._folder || '').replace(/^\/+|\/+$/g, '');
    if (user) return user;
    return (this.plugin.settings.diaryFolder || '').replace(/^\/+|\/+$/g, '');
  }

  resolveName(vars) {
    let name = this.plugin.applyTemplate(this._nameTpl || '{{title}}-{{datetime}}', vars).trim();
    name = name.replace(/[\\:*?"<>|]/g, '-');
    if (!name.endsWith('.md')) name += '.md';
    return name;
  }

  updatePreview() {
    if (!this.previewEl) return;
    const vars = this.buildVars(new Date());
    const folder = this.resolveFolder();
    const name = this.resolveName(vars);
    this.previewEl.setText('预览：' + (folder ? `${folder}/${name}` : name));
  }

  persistSettings() {
    this.plugin.settings.exportFolder = this._folder;
    this.plugin.settings.exportNameTemplate = this._nameTpl;
    this.plugin.saveSettings();
  }

  async doExportToVault() {
    const now = new Date();
    const vars = this.buildVars(now);
    const folder = this.resolveFolder();
    const fileName = this.resolveName(vars);
    const base = fileName.replace(/\.md$/, '');
    let path = folder ? `${folder}/${base}.md` : `${base}.md`;
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = folder ? `${folder}/${base}-${n}.md` : `${base}-${n}.md`;
      n++;
    }
    try {
      this.persistSettings();
      const md = this.plugin.buildExportMarkdown(this.entries);
      const file = await this.app.vault.create(path, md);
      await this.app.workspace.getLeaf(true).openFile(file);
      new Notice('已导出：' + path);
      this.close();
    } catch (err) {
      console.error('[diary-link-timeline] export failed', err);
      new Notice('导出失败：' + (err && err.message ? err.message : String(err)));
    }
  }

  doDownload() {
    const now = new Date();
    const vars = this.buildVars(now);
    const fileName = this.resolveName(vars);
    try {
      this.persistSettings();
      const md = this.plugin.buildExportMarkdown(this.entries);
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      new Notice('已触发下载：' + fileName);
      this.close();
    } catch (err) {
      console.error('[diary-link-timeline] download failed', err);
      new Notice('下载失败：' + (err && err.message ? err.message : String(err)));
    }
  }

  onClose() { this.contentEl.empty(); }
}

// ============================================================
//  设置
// ============================================================

class TimelineSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // 设置变化后刷新所有时间轴视图（只重绘，不重扫）
  refreshAllViews() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof TimelineView) {
        leaf.view.renderView();
      }
    }
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    // ---- 数据源 ----
    new Setting(containerEl)
      .setName('日记文件夹路径')
      .setDesc('只扫描该文件夹内的 Markdown 文件（含子文件夹）。留空表示整个库。')
      .addText((text) => text
        .setPlaceholder('日记')
        .setValue(this.plugin.settings.diaryFolder)
        .onChange(async (value) => {
          this.plugin.settings.diaryFolder = value.trim();
          await this.plugin.saveSettings();
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
          for (const leaf of leaves) {
            if (leaf.view instanceof TimelineView) {
              leaf.view.fileCache.clear();
              leaf.view.render(true);
            }
          }
        }));

    // ---- 点击交互 ----
    containerEl.createEl('h4', { text: '点击交互' });

    new Setting(containerEl)
      .setName('启用点击交互')
      .setDesc('总开关。关闭后时间、日期、双链、文字的所有点击增强都失效，视图变为纯展示。')
      .addToggle((t) => t
        .setValue(!!this.plugin.settings.enableClickActions)
        .onChange(async (v) => {
          this.plugin.settings.enableClickActions = v;
          await this.plugin.saveSettings();
          this.refreshAllViews();
        }));

    new Setting(containerEl)
      .setName('点击 [[双链]] 时')
      .setDesc('“跳转到链接目标”：使用 Obsidian 原生跳转；“按该目标筛选”：把工具栏筛选切到该目标并刷新视图。')
      .addDropdown((d) => d
        .addOption('navigate', '跳转到链接目标')
        .addOption('filter', '按该目标筛选')
        .setValue(this.plugin.settings.linkClickAction || 'navigate')
        .onChange(async (v) => {
          this.plugin.settings.linkClickAction = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('点击文字时复制时间块')
      .setDesc('开启后，短按（未选中文字）或长按 600ms 会复制该时间块的原始 Markdown。')
      .addToggle((t) => t
        .setValue(!!this.plugin.settings.textClickCopy)
        .onChange(async (v) => {
          this.plugin.settings.textClickCopy = v;
          await this.plugin.saveSettings();
        }));

    // ---- 导出 ----
    containerEl.createEl('h4', { text: '导出' });

    new Setting(containerEl)
      .setName('导出文件夹')
      .setDesc('默认导出目录。留空则使用日记文件夹。可在导出弹窗中临时修改。')
      .addText((t) => t
        .setPlaceholder('日记/导出')
        .setValue(this.plugin.settings.exportFolder || '')
        .onChange(async (v) => {
          this.plugin.settings.exportFolder = v.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('文件名模板')
      .setDesc('支持：{{title}} {{date}} {{time}} {{datetime}} {{year}} {{month}} {{day}} {{count}} {{folder}} {{filter}}')
      .addText((t) => t
        .setPlaceholder('{{title}}-{{datetime}}')
        .setValue(this.plugin.settings.exportNameTemplate || '')
        .onChange(async (v) => {
          this.plugin.settings.exportNameTemplate = v.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('导出标题（{{title}}）')
      .setDesc('替换模板中的 {{title}}。')
      .addText((t) => t
        .setPlaceholder('日记链接时间轴')
        .setValue(this.plugin.settings.exportTitle || '')
        .onChange(async (v) => {
          this.plugin.settings.exportTitle = v.trim();
          await this.plugin.saveSettings();
        }));
  }
}

module.exports = DiaryLinkTimelinePlugin;
