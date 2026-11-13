const {
  Plugin, ItemView, PluginSettingTab, Setting,
  MarkdownRenderer, Modal, Notice, MarkdownView, Platform,
} = require('obsidian');

const VIEW_TYPE = 'diary-link-timeline-view';
const CODE_BLOCK_LANG = 'diary-timeline';
const EXPORT_PREFIX = '_timeline-export-';
const UNLINKED_FILTER = '__unlinked__';
const PROTOCOL_ACTION = 'diary-timeline';
const LEGACY_DEFAULT_TITLE = '日记链接时间轴';
// 三反引号围栏：运行时拼接，避免源码中出现 ``` 字面量导致复制/打包被截断
const FENCE = String.fromCharCode(96, 96, 96);

// 正则工厂：避免模块级共享 lastIndex 状态，每次新建开销可忽略
const linkRe = () => /(?<!!)\[\[([^\]|#]+)/g;

const DEFAULT_SETTINGS = {
  diaryFolder: '日记',
  exportFolder: '',
  exportNameTemplate: '{{title}}-{{datetime}}',
  exportTitle: '',
  displayMode: 'sidebar',
  autoOpenOnStartup: false,
  enableClickActions: true,
  linkClickAction: 'navigate',
  textClickCopy: true,
  pinnedFilters: [],
  sortOrder: 'desc',
  exportSortOrder: 'asc',
  limitRenderCount: false,
  renderLimit: 100,
};

// 渲染分批大小（兼顾流畅与吞吐）
const RENDER_BATCH = 30;

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
    this.fileCache = new Map();
    this.lastKnownEntries = [];
    this.renderers = new Set();

    this.installStyles();

    this.registerView(VIEW_TYPE, (leaf) => new TimelineView(leaf, this));

    // 笔记内代码块
    this.registerMarkdownCodeBlockProcessor(CODE_BLOCK_LANG, async (source, el, ctx) => {
      el.addClass('diary-timeline-embed');
      const renderer = new TimelineRenderer(this, el, { live: false, compact: true });
      try {
        await renderer.mount();
      } catch (err) {
        console.error('[diary-link-timeline] embed render failed', err);
        el.createEl('p', { text: '渲染失败：' + (err && err.message ? err.message : String(err)) });
        return;
      }

      const cfg = {};
      String(source || '').split('\n').forEach((line) => {
        const m = line.match(/^\s*([\w-]+)\s*[=:]\s*(.*)$/);
        if (m) cfg[m[1]] = (m[2] || '').trim();
      });
      if (cfg.filter) {
        const raw = cfg.filter;
        const f = (raw === '无链接' || raw === 'unlinked') ? UNLINKED_FILTER : raw;
        await renderer.applyExternalFilter(f);
      }
    });

    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
      this.handleTimelineProtocol(params);
    });

    this.addCommand({
      id: 'open-diary-link-timeline',
      name: '打开日记链接时间轴',
      callback: () => this.handleOpenCommand(),
    });

    this.addCommand({
      id: 'open-diary-timeline-view',
      name: '在侧边栏打开时间轴视图',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'insert-timeline-block',
      name: '插入时间轴代码块（在当前光标处）',
      editorCallback: (editor) => this.insertTimelineBlock(editor),
    });

    this.addCommand({
      id: 'insert-filter-link',
      name: '插入筛选链接（在当前光标处）',
      editorCallback: (editor) => {
        new InsertFilterLinkModal(this.app, this, (md) => {
          editor.replaceSelection(md);
        }).open();
      },
    });

    this.addRibbonIcon('git-branch', '日记链接时间轴', () => this.handleOpenCommand());

    this.addSettingTab(new TimelineSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoOpenOnStartup && this.settings.displayMode === 'sidebar') {
        this.activateView().catch((e) => console.error(e));
      }
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  installStyles() {
    const oldStyle = document.getElementById('diary-link-timeline-style');
    if (oldStyle) oldStyle.remove();
    const style = document.createElement('style');
    style.id = 'diary-link-timeline-style';
    style.textContent = `
      .diary-timeline-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
      .diary-timeline-toolbar select { max-width: 260px; }
      .diary-timeline-toolbar button,
      .diary-timeline-toolbar select {
        min-height: 32px;
        touch-action: manipulation;
      }
      .diary-timeline-status { color: var(--text-muted); font-size: 0.85em; }
      .diary-timeline-pin-filter-btn { font-size: 16px; line-height: 1; padding: 2px 6px; min-width: 32px; }
      .diary-timeline-pin-filter-btn.is-pinned { color: var(--text-accent); }
      .diary-timeline-pin-filter-btn:disabled { opacity: 0.4; cursor: default; }
      .diary-timeline-sort-btn { white-space: nowrap; }

      .diary-timeline-pinned-filters { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; padding: 8px 10px; background: var(--background-secondary-alt); border: 1px solid var(--background-modifier-border); border-radius: 6px; }
      .diary-timeline-pinned-filters.is-empty { display: none; }
      .diary-timeline-pinned-label { color: var(--text-muted); font-size: 0.8em; margin-right: 4px; align-self: center; }
      .diary-timeline-chip { display: inline-flex; align-items: center; padding: 2px 10px; min-height: 26px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 12px; font-size: 0.85em; transition: background 0.15s, border-color 0.15s, transform 0.1s; touch-action: manipulation; }
      .diary-timeline-chip:hover { background: var(--background-modifier-hover); }
      .diary-timeline-chip:active { transform: scale(0.97); }
      .diary-timeline-chip.is-active { background: var(--interactive-accent); color: var(--text-on-accent); border-color: var(--interactive-accent); }
      .diary-timeline-chip.is-active:hover { background: var(--interactive-accent-hover); }
      .diary-timeline-chip.is-invalid { opacity: 0.55; }
      .diary-timeline-chip.is-invalid .diary-timeline-chip-label { text-decoration: line-through; }
      .diary-timeline-chip-label { cursor: pointer; user-select: none; }

      .diary-timeline-content h1 { margin-top: 32px; border-bottom: 2px solid var(--text-accent); padding-bottom: 6px; font-size: 1.5em; }
      .diary-timeline-content h2 { margin-top: 24px; border-bottom: 2px solid var(--background-modifier-border); padding-bottom: 4px; }
      .diary-timeline-content h3 { margin-top: 16px; color: var(--text-accent); }
      .diary-timeline-content h3.diary-timeline-date { display: inline-block; }
      .diary-timeline-entry { display: flex; gap: 8px; margin: 8px 0; padding: 8px; border-left: 3px solid var(--interactive-accent); background: var(--background-secondary); border-radius: 4px; }
      .diary-timeline-entry.is-unlinked { border-left-color: var(--background-modifier-border); opacity: 0.85; }
      .diary-timeline-time { font-weight: 600; color: var(--text-accent); white-space: nowrap; font-variant-numeric: tabular-nums; padding: 0 4px; border-radius: 3px; transition: background 0.15s; user-select: none; touch-action: manipulation; }
      .diary-timeline-text { flex: 1; min-width: 0; border-radius: 3px; transition: background 0.15s; }
      .diary-timeline-text.is-copied { background: var(--text-selection); transition: background 0.3s; }
      .diary-timeline-text p:first-child { margin-top: 0; }
      .diary-timeline-text p:last-child { margin-bottom: 0; }

      .diary-timeline-limit-hint { margin: 16px 0 8px; padding: 8px 10px; text-align: center; color: var(--text-muted); font-size: 0.85em; background: var(--background-secondary-alt); border-radius: 4px; }

      .diary-timeline-preview { margin: 12px 0; padding: 8px; background: var(--background-secondary); border-radius: 4px; font-family: var(--font-monospace); font-size: 0.9em; word-break: break-all; color: var(--text-muted); }
      .diary-timeline-buttons { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
      .diary-timeline-buttons button { min-height: 32px; touch-action: manipulation; }
      .diary-timeline-hint { margin-bottom: 12px; color: var(--text-muted); font-size: 0.9em; }

      .diary-timeline-content.click-enabled .diary-timeline-time { cursor: pointer; }
      .diary-timeline-content.click-enabled .diary-timeline-time:hover { background: var(--background-modifier-hover); text-decoration: underline; }
      .diary-timeline-content.click-enabled .diary-timeline-time:active { background: var(--background-modifier-active-hover); }
      .diary-timeline-content.click-enabled .diary-timeline-date { cursor: pointer; }
      .diary-timeline-content.click-enabled .diary-timeline-date:hover { text-decoration: underline; }
      .diary-timeline-content.click-enabled .diary-timeline-text { cursor: copy; }

      .diary-timeline-subsettings.is-collapsed { display: none; }

      .diary-timeline-embed { padding: 4px 0; }
      .diary-timeline-embed .diary-timeline-compact-hint { margin-bottom: 8px; padding: 4px 8px; background: var(--background-secondary-alt); border-radius: 4px; font-size: 0.8em; color: var(--text-muted); display: flex; justify-content: space-between; }
      /* 代码块滚动条仅移动端生效（Obsidian 移动端会为 body 加 is-mobile class） */
      body.is-mobile .diary-timeline-embed .diary-timeline-content { max-height: 70vh; overflow-y: auto; overflow-x: hidden; padding-right: 6px; -webkit-overflow-scrolling: touch; }

      /* 窄屏 / 移动端适配 */
      @media (max-width: 600px) {
        .diary-timeline-toolbar { gap: 6px; }
        .diary-timeline-toolbar select { max-width: 100%; flex: 1 1 auto; }
        .diary-timeline-toolbar button,
        .diary-timeline-toolbar select { min-height: 36px; }
        .diary-timeline-entry { padding: 6px; gap: 6px; }
        .diary-timeline-time { font-size: 1.05em; }
        .diary-timeline-status { font-size: 0.8em; }
        .diary-timeline-buttons button { min-height: 36px; }
      }
    `;
    document.head.appendChild(style);
    this.register(() => style.remove());
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (leaf) {
      workspace.revealLeaf(leaf);
      return leaf;
    }

    // 桌面优先右侧栏；移动端使用主区 tab（移动端侧边栏体验差）
    if (Platform.isMobile) {
      leaf = workspace.getLeaf('tab');
    } else {
      leaf = workspace.getRightLeaf(false);
    }
    if (!leaf) leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
    return leaf;
  }

  async handleOpenCommand() {
    if (this.settings.displayMode === 'in-note') {
      this.insertTimelineBlock();
    } else {
      await this.activateView();
    }
  }

  insertTimelineBlock(editorArg) {
    let editor = editorArg;
    if (!editor) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) editor = view.editor;
    }
    if (!editor) {
      new Notice('请在 Markdown 笔记中使用此命令');
      return;
    }
    const cursor = editor.getCursor();
    const block = FENCE + CODE_BLOCK_LANG + '\n\n' + FENCE + '\n';
    editor.replaceRange(block, cursor);
    editor.setCursor({ line: cursor.line + 1, ch: 0 });
    new Notice('已插入时间轴代码块');
  }

  async handleTimelineProtocol(params) {
    let filter = '';
    if (params && typeof params.filter === 'string') {
      const raw = params.filter;
      if (raw === 'all' || raw === '__all__') filter = '';
      else filter = raw;
    }
    try {
      const leaf = await this.activateView();
      const view = leaf && leaf.view;
      if (view instanceof TimelineView && view.renderer) {
        await view.renderer.applyExternalFilter(filter);
      }
    } catch (err) {
      console.error('[diary-link-timeline] protocol handler failed', err);
      new Notice('打开时间轴失败：' + (err && err.message ? err.message : String(err)));
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.pinnedFilters)) this.settings.pinnedFilters = [];
    if (this.settings.sortOrder !== 'asc' && this.settings.sortOrder !== 'desc') {
      this.settings.sortOrder = 'desc';
    }
    if (this.settings.exportSortOrder !== 'asc' && this.settings.exportSortOrder !== 'desc') {
      this.settings.exportSortOrder = 'asc';
    }
    this.settings.limitRenderCount = !!this.settings.limitRenderCount;
    const n = parseInt(this.settings.renderLimit, 10);
    this.settings.renderLimit = (Number.isFinite(n) && n > 0) ? Math.min(n, 5000) : 100;
    if (this.settings.exportTitle === LEGACY_DEFAULT_TITLE && !this.settings._titleMigrated) {
      this.settings.exportTitle = '';
      this.settings._titleMigrated = true;
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  isInDiaryFolder(path) {
    const folder = (this.settings.diaryFolder || '').replace(/^\/+|\/+$/g, '');
    if (!folder) return true;
    return path.startsWith(folder + '/');
  }

  isFilterPinned(target) {
    return (this.settings.pinnedFilters || []).includes(target);
  }

  async togglePinnedFilter(target) {
    const list = this.settings.pinnedFilters || [];
    const idx = list.indexOf(target);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(target);
    this.settings.pinnedFilters = list;
    await this.saveSettings();
  }

  async clearPinnedFilters() {
    this.settings.pinnedFilters = [];
    await this.saveSettings();
  }

  /**
   * 统一排序入口：
   *  - order='asc'  旧→新（date/time 升序）
   *  - order='desc' 新→旧（date/time 降序）
   * sourcePath / line 始终升序，作为稳定 tie-break，避免同刻多条随机跳动。
   */
  sortEntries(entries, order) {
    const dir = order === 'desc' ? -1 : 1;
    entries.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -dir : dir;
      if (a.time !== b.time) return a.time < b.time ? -dir : dir;
      if (a.sourcePath !== b.sourcePath) return a.sourcePath < b.sourcePath ? -1 : 1;
      return (a.line || 0) - (b.line || 0);
    });
    return entries;
  }

  async setSortOrder(order) {
    const next = order === 'asc' ? 'asc' : 'desc';
    if (this.settings.sortOrder === next) return;
    this.settings.sortOrder = next;
    await this.saveSettings();
    this.refreshAllRenderers();
  }

  trackRenderer(r) { this.renderers.add(r); }
  untrackRenderer(r) { this.renderers.delete(r); }

  refreshAllRenderers() {
    for (const r of Array.from(this.renderers)) {
      try {
        r.updateSortButton();
        r.resortEntries();
      } catch (e) {
        console.error('[diary-link-timeline] refresh renderer failed', e);
      }
    }
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
    const filterValue = (extra && extra.filter) || '全部';

    let title = (this.settings.exportTitle || '').trim();
    if (!title) title = (filterValue && filterValue !== '全部') ? filterValue : LEGACY_DEFAULT_TITLE;

    const vars = {
      title,
      date: this.formatDate(now),
      time: this.formatTime(now),
      datetime: this.formatTimestamp(now),
      year: String(now.getFullYear()),
      month: this.pad(now.getMonth() + 1),
      day: this.pad(now.getDate()),
      count: String(entries.length),
      folder: lastSeg,
      filter: filterValue,
    };
    if (extra) Object.assign(vars, extra);
    if (!String(vars.title || '').trim()) {
      vars.title = (filterValue && filterValue !== '全部') ? filterValue : LEGACY_DEFAULT_TITLE;
    }
    return vars;
  }

  applyTemplate(tpl, vars) {
    return (tpl || '').replace(/\{\{(\w+)\}\}/g, (m, key) => {
      return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m;
    });
  }

  buildExportMarkdown(entries, title) {
    const now = new Date();
    const t = (title || '').trim() || LEGACY_DEFAULT_TITLE;
    const lines = [
      '> **' + t + '**',
      '> 导出时间：' + this.formatDateTime(now) + ' · 共 ' + entries.length + ' 条',
      '',
    ];

    let lastYear = null, lastMonth = null, lastDate = null;
    const n = entries.length;
    for (let i = 0; i < n; i++) {
      const e = entries[i];
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
      lines.push(`**${e.time}** · [[${src}]]`, '', e.text, '');
      // 末尾不再追加分隔线，避免正则裁剪误伤内容中的 "---"
      if (i < n - 1) lines.push('---', '');
    }

    return lines.join('\n');
  }
}

// ============================================================
//  TimelineRenderer
// ============================================================

class TimelineRenderer {
  constructor(plugin, containerEl, options = {}) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.containerEl = containerEl;
    this.options = Object.assign({ live: true, compact: false }, options);

    this.lastEntries = [];
    this.filteredEntries = [];
    this._timer = null;
    this._rendering = false;
    this._pendingRefresh = false;
    this._renderToken = 0;          // 渲染令牌：打断过期的分批渲染
    this._lastTargetsKey = null;
    this._pendingFilter = undefined;
    this._eventRefs = [];
    this._mounted = false;

    this.filterEl = null;
    this.pinCurrentBtn = null;
    this.sortBtn = null;
    this.statusEl = null;
    this.pinnedEl = null;
    this.listEl = null;
  }

  filterLabel(value) {
    if (!value) return '全部';
    if (value === UNLINKED_FILTER) return '无链接';
    return value;
  }

  async mount() {
    if (this._mounted) return;
    this._mounted = true;
    this.plugin.trackRenderer(this);

    this.containerEl.empty();
    this.containerEl.addClass('diary-link-timeline-container');

    if (this.options.compact) {
      const hint = this.containerEl.createDiv({ cls: 'diary-timeline-compact-hint' });
      hint.createSpan({ text: '笔记内时间轴' });
      const refreshBtn = hint.createEl('button', { text: '刷新' });
      refreshBtn.onclick = () => this.render(true);
    }

    const toolbar = this.containerEl.createDiv({ cls: 'diary-timeline-toolbar' });

    if (!this.options.compact) {
      const refreshBtn = toolbar.createEl('button', { text: '刷新' });
      refreshBtn.onclick = () => this.render(true);
    }

    toolbar.createSpan({ text: '筛选：', cls: 'diary-timeline-status' });
    this.filterEl = toolbar.createEl('select');
    this.filterEl.onchange = () => {
      this.updatePinButton();
      this.renderView();
    };

    this.pinCurrentBtn = toolbar.createEl('button', { cls: 'diary-timeline-pin-filter-btn' });
    this.pinCurrentBtn.onclick = () => this.togglePinCurrentFilter();

    this.sortBtn = toolbar.createEl('button', { cls: 'diary-timeline-sort-btn' });
    this.sortBtn.onclick = () => this.toggleSortOrder();
    this.updateSortButton();

    const exportBtn = toolbar.createEl('button', { text: '导出…' });
    exportBtn.onclick = () => this.openExportModal();

    this.statusEl = toolbar.createSpan({ cls: 'diary-timeline-status' });

    this.pinnedEl = this.containerEl.createDiv({ cls: 'diary-timeline-pinned-filters is-empty' });
    this.listEl = this.containerEl.createDiv({ cls: 'diary-timeline-content' });

    if (this.options.live) {
      const onChange = (file) => {
        if (!file || !file.path) return;
        if (!this.plugin.isInDiaryFolder(file.path)) return;
        const name = file.name || file.path.split('/').pop() || '';
        if (name.startsWith(EXPORT_PREFIX)) return;
        this.scheduleRefresh();
      };
      this._eventRefs.push(['modify', this.app.vault.on('modify', onChange)]);
      this._eventRefs.push(['create', this.app.vault.on('create', onChange)]);
      this._eventRefs.push(['delete', this.app.vault.on('delete', onChange)]);
      this._eventRefs.push(['rename', this.app.vault.on('rename', (f, oldPath) => {
        if (this.plugin.isInDiaryFolder(f.path) || this.plugin.isInDiaryFolder(oldPath)) {
          this.plugin.fileCache.clear();
          this.scheduleRefresh();
        }
      })]);
    }

    this.updatePinButton();

    // 不阻塞 mount：先让视图/代码块立即可交互，首次数据扫描异步进行
    this.render(true).catch((err) => {
      console.error('[diary-link-timeline] initial render failed', err);
    });
  }

  async unmount() {
    if (!this._mounted) return;
    this._mounted = false;
    this.plugin.untrackRenderer(this);
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    for (const [, ref] of this._eventRefs) {
      try { this.app.vault.offref(ref); } catch (e) { /* ignore */ }
    }
    this._eventRefs = [];
    // 清理挂起状态，避免复用实例时污染
    this._pendingFilter = undefined;
    this._lastTargetsKey = null;
    this._renderToken++;  // 打断进行中的分批渲染
  }

  scheduleRefresh() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this.render(); }, 400);
  }

  // ---------- 外部筛选 ----------

  async applyExternalFilter(filter) {
    const wanted = filter || '';
    if (!this.filterEl) { this._pendingFilter = wanted; return; }
    const opts = Array.from(this.filterEl.options).map((o) => o.value);
    if (wanted === '' || opts.includes(wanted)) {
      this.filterEl.value = wanted;
      this.updatePinButton();
      this.renderView();
      if (wanted) new Notice('已切换到筛选：' + this.filterLabel(wanted));
      return;
    }
    this._pendingFilter = wanted;
    await this.render(true);
  }

  applyPendingFilterIfAny() {
    if (this._pendingFilter === undefined) return;
    const wanted = this._pendingFilter;
    this._pendingFilter = undefined;
    if (!this.filterEl) return;

    const opts = Array.from(this.filterEl.options).map((o) => o.value);
    if (wanted === '' || opts.includes(wanted)) {
      this.filterEl.value = wanted;
      this.updatePinButton();
      if (wanted) new Notice('已切换到筛选：' + this.filterLabel(wanted));
    } else {
      this.filterEl.value = '';
      this.updatePinButton();
      new Notice('筛选目标未找到：' + (wanted === UNLINKED_FILTER ? '无链接' : wanted));
    }
  }

  // ---------- 数据收集 ----------

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
    const cached = this.plugin.fileCache.get(file.path);
    if (!force && cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
      return cached.entries;
    }
    let content;
    try { content = await this.app.vault.cachedRead(file); }
    catch (e) { return []; }
    const date = this.extractDate(file);
    if (!date) {
      this.plugin.fileCache.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, entries: [] });
      return [];
    }
    const entries = this.parseContent(content, date, file.path);
    this.plugin.fileCache.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, entries });
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

    return this.plugin.sortEntries(results, this.plugin.settings.sortOrder);
  }

  collectLinkTargets(entries) {
    const set = new Set();
    const re = linkRe();
    for (const e of entries) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(e.text)) !== null) {
        const t = m[1].trim();
        if (t) set.add(t);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'));
  }

  // ---------- 筛选 ----------

  updateFilterOptions(targets) {
    if (!this.filterEl) return;
    const pinned = this.plugin.settings.pinnedFilters || [];
    const key = targets.join('\u0001') + '\u0002' + pinned.join('\u0001');
    if (key === this._lastTargetsKey) return;
    this._lastTargetsKey = key;

    const pinnedSet = new Set(pinned);
    const current = this.filterEl.value;
    this.filterEl.empty();
    this.filterEl.createEl('option', { value: '', text: '全部' });
    this.filterEl.createEl('option', {
      value: UNLINKED_FILTER,
      text: (pinnedSet.has(UNLINKED_FILTER) ? '★ ' : '') + '无链接',
    });
    for (const t of targets) {
      const prefix = pinnedSet.has(t) ? '★ ' : '';
      this.filterEl.createEl('option', { value: t, text: prefix + t });
    }

    if (current === UNLINKED_FILTER || (current && targets.includes(current))) {
      this.filterEl.value = current;
    } else {
      this.filterEl.value = '';
    }
    this.updatePinButton();
  }

  entryHasLink(entry) {
    return linkRe().test(entry.text);
  }

  entryHasTarget(entry, target) {
    const re = linkRe();
    let m;
    while ((m = re.exec(entry.text)) !== null) {
      if (m[1].trim() === target) return true;
    }
    return false;
  }

  applyFilter(entries) {
    if (!this.filterEl) return entries;
    const f = this.filterEl.value;
    if (!f) return entries;
    if (f === UNLINKED_FILTER) return entries.filter((e) => !this.entryHasLink(e));
    return entries.filter((e) => this.entryHasTarget(e, f));
  }

  // ---------- 排序 ----------

  getSortOrder() {
    return this.plugin.settings.sortOrder === 'asc' ? 'asc' : 'desc';
  }

  updateSortButton() {
    if (!this.sortBtn) return;
    const order = this.getSortOrder();
    this.sortBtn.textContent = order === 'asc' ? '↑ 最早在前' : '↓ 最新在前';
    this.sortBtn.title = order === 'asc'
      ? '当前：升序（旧→新），点击切换为降序'
      : '当前：降序（新→旧），点击切换为升序';
  }

  async toggleSortOrder() {
    const next = this.getSortOrder() === 'asc' ? 'desc' : 'asc';
    await this.plugin.setSortOrder(next);
  }

  /** 仅重排已收集的数据并重绘，不重新扫描文件 */
  resortEntries() {
    this.updateSortButton();
    if (!this.lastEntries.length) return;
    this.plugin.sortEntries(this.lastEntries, this.getSortOrder());
    this.renderView();
  }

  // ---------- 置顶筛选 ----------

  updatePinButton() {
    if (!this.pinCurrentBtn || !this.filterEl) return;
    const target = this.filterEl.value;
    const canPin = !!target;
    const pinned = canPin && this.plugin.isFilterPinned(target);
    this.pinCurrentBtn.textContent = pinned ? '★' : '☆';
    this.pinCurrentBtn.title = !canPin
      ? '当前为“全部”，无需置顶'
      : (pinned ? '取消置顶当前筛选' : '置顶当前筛选');
    this.pinCurrentBtn.disabled = !canPin;
    this.pinCurrentBtn.classList.toggle('is-pinned', pinned);
  }

  async togglePinCurrentFilter() {
    if (!this.filterEl) return;
    const target = this.filterEl.value;
    if (!target) {
      new Notice('“全部”是默认视图，无需置顶');
      return;
    }
    await this.plugin.togglePinnedFilter(target);
    this.updatePinButton();
    this.renderPinnedFilters();
    this._lastTargetsKey = null;
    this.updateFilterOptions(this.collectLinkTargets(this.lastEntries));
  }

  renderPinnedFilters() {
    if (!this.pinnedEl) return;
    this.pinnedEl.empty();

    const pinned = this.plugin.settings.pinnedFilters || [];
    if (!pinned.length) {
      this.pinnedEl.addClass('is-empty');
      return;
    }
    this.pinnedEl.removeClass('is-empty');

    this.pinnedEl.createSpan({ cls: 'diary-timeline-pinned-label', text: '📌 置顶筛选' });

    const available = new Set(this.collectLinkTargets(this.lastEntries));
    available.add(UNLINKED_FILTER);
    const current = this.filterEl ? this.filterEl.value : '';

    for (const target of pinned) {
      const label = this.filterLabel(target);
      const isValid = available.has(target);
      const chip = this.pinnedEl.createDiv({ cls: 'diary-timeline-chip' });
      if (target === current) chip.addClass('is-active');
      if (!isValid) chip.addClass('is-invalid');

      const labelEl = chip.createSpan({ cls: 'diary-timeline-chip-label', text: label });
      labelEl.title = isValid ? '单击切换到此筛选' : '当前数据中无匹配结果';

      labelEl.addEventListener('click', () => {
        if (!isValid) {
          new Notice('当前数据中没有 "' + label + '" 的匹配结果');
          return;
        }
        if (this.filterEl) this.filterEl.value = target;
        this.updatePinButton();
        this.renderView();
      });
    }
  }

  // ---------- 跳转 / 复制 ----------

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
    if (!targetLeaf) targetLeaf = this.app.workspace.getLeaf(true);
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

  applyFilterForLink(rawTarget) {
    if (!this.filterEl) return false;
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
      this.updatePinButton();
      this.renderView();
      return true;
    }
    const base = target.split('/').pop();
    const found = opts.find((v) => v && v.split('/').pop() === base);
    if (found) {
      this.filterEl.value = found;
      this.updatePinButton();
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

  /**
   * 复制交互：
   *  - 鼠标：短按（未拖动、未选中文字）复制；长按 600ms 也复制
   *  - 触摸：轻点（位移 < 10px、时长 < 500ms）复制；长按交给系统选择菜单
   *  - 链接元素上不触发，交给链接逻辑处理
   */
  bindTextCopy(textEl, entry) {
    const s = () => this.plugin.settings;
    const enabled = () => !!s().enableClickActions;
    const copyEnabled = () => enabled() && !!s().textClickCopy;
    const isLinkEl = (el) => !!(el && el.closest && el.closest('a'));

    const MOVE_TOL = 10;
    const LONG_MS = 600;
    const TOUCH_TAP_MS = 500;
    const COPY_DEBOUNCE = 300;

    let lastCopyTime = 0;

    const doCopy = async () => {
      const now = Date.now();
      if (now - lastCopyTime < COPY_DEBOUNCE) return;
      lastCopyTime = now;
      const ok = await writeClipboard(entry.text);
      if (ok) {
        new Notice('已复制');
        textEl.classList.add('is-copied');
        setTimeout(() => textEl.classList.remove('is-copied'), 300);
      } else {
        new Notice('复制失败');
      }
    };

    // 链接劫持（捕获阶段）：仅在“按目标筛选”模式下生效
    textEl.addEventListener('click', (e) => {
      if (!enabled()) return;
      const linkEl = e.target.closest('a');
      if (!linkEl) return;
      const isInternal = linkEl.classList.contains('internal-link') || linkEl.hasAttribute('data-href');
      if (!isInternal) return;
      if ((s().linkClickAction || 'navigate') !== 'filter') return;

      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();

      let raw = linkEl.getAttribute('data-href') || linkEl.getAttribute('href') || '';
      try { raw = decodeURIComponent(raw); } catch (err) { /* ignore */ }

      if (!this.applyFilterForLink(raw)) {
        new Notice('筛选列表中未找到该链接目标：' + raw);
      }
    }, true);

    let pressTimer = null;
    let pressStart = 0;
    let pressX = 0;
    let pressY = 0;
    let longPressed = false;

    textEl.addEventListener('pointerdown', (e) => {
      if (!copyEnabled()) return;
      if (isLinkEl(e.target)) return;
      pressStart = Date.now();
      pressX = e.clientX;
      pressY = e.clientY;
      longPressed = false;
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      // 触摸设备不启动长按定时器：把长按留给系统选择/复制
      if (e.pointerType !== 'touch') {
        pressTimer = setTimeout(() => {
          longPressed = true;
          pressTimer = null;
          doCopy();
        }, LONG_MS);
      }
    }, { passive: true });

    textEl.addEventListener('pointerup', (e) => {
      if (!copyEnabled()) {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        return;
      }
      if (isLinkEl(e.target)) {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        return;
      }
      const dt = Date.now() - pressStart;
      const dx = Math.abs(e.clientX - pressX);
      const dy = Math.abs(e.clientY - pressY);
      const moved = dx > MOVE_TOL || dy > MOVE_TOL;

      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (longPressed) { longPressed = false; return; }
      if (moved) return;

      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;

      if (e.pointerType === 'touch') {
        if (dt < TOUCH_TAP_MS) doCopy();
      } else if (dt < LONG_MS) {
        doCopy();
      }
    });

    textEl.addEventListener('pointercancel', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      longPressed = false;
    });
  }

  // ---------- 渲染 ----------

  async render(force) {
    if (this._rendering) { this._pendingRefresh = true; return; }
    this._rendering = true;
    const t0 = performance.now();
    try {
      if (this.statusEl) this.statusEl.setText('加载中…');
      const entries = await this.collectEntries(force);
      this.lastEntries = entries;
      this.plugin.lastKnownEntries = entries;
      this.updateFilterOptions(this.collectLinkTargets(entries));
      this.applyPendingFilterIfAny();
      await this.renderView(t0);
    } catch (err) {
      console.error('[diary-link-timeline]', err);
      if (this.listEl) {
        this.listEl.empty();
        this.listEl.createEl('p', { text: '渲染出错：' + (err && err.message ? err.message : String(err)) });
      }
      if (this.statusEl) this.statusEl.setText('');
    } finally {
      this._rendering = false;
      if (this._pendingRefresh) {
        this._pendingRefresh = false;
        this.scheduleRefresh();
      }
    }
  }

  async renderView(t0) {
    if (!this.filterEl || !this.listEl) return;

    const token = ++this._renderToken;
    this.listEl.toggleClass('click-enabled', !!this.plugin.settings.enableClickActions);
    this.renderPinnedFilters();

    const filtered = this.applyFilter(this.lastEntries);
    this.filteredEntries = filtered;   // 导出始终使用完整筛选结果

    let entries = filtered;
    let limitApplied = false;
    const totalFiltered = filtered.length;
    if (this.plugin.settings.limitRenderCount) {
      const limit = Math.max(1, Number(this.plugin.settings.renderLimit) || 100);
      if (totalFiltered > limit) {
        entries = filtered.slice(0, limit);
        limitApplied = true;
      }
    }

    this.listEl.empty();

    if (entries.length === 0) {
      if (this.lastEntries.length === 0) {
        this.listEl.createEl('p', { text: '未找到 “- hh:mm:ss” 格式的时间块。' });
      } else {
        const f = this.filterLabel(this.filterEl.value);
        this.listEl.createEl('p', { text: `当前筛选下无结果（共 ${this.lastEntries.length} 条时间块，筛选：${f}）。` });
      }
      if (this.statusEl) this.statusEl.setText('');
      return;
    }

    // 分批构建：先出文字，markdown 再逐批替换，避免长列表一次性卡住 UI
    let lastYear = null, lastMonth = null, lastDate = null;
    const total = entries.length;

    for (let i = 0; i < total; i += RENDER_BATCH) {
      if (token !== this._renderToken) return;  // 被更新的渲染打断

      const frag = document.createDocumentFragment();
      const tasks = [];
      const end = Math.min(i + RENDER_BATCH, total);

      for (let j = i; j < end; j++) {
        const e = entries[j];
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

      // 让出主线程，保持滚动与点击响应
      if (end < total) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (token !== this._renderToken) return;

    if (limitApplied) {
      const hint = document.createElement('div');
      hint.className = 'diary-timeline-limit-hint';
      hint.textContent = `仅显示前 ${entries.length} 条，共 ${totalFiltered} 条。可在设置中调整上限或关闭“仅渲染前 N 条”。`;
      this.listEl.appendChild(hint);
    }

    const ms = typeof t0 === 'number' ? Math.round(performance.now() - t0) : 0;
    const f = this.filterLabel(this.filterEl.value);
    const suffix = this.filterEl.value ? `（筛选：${f}）` : '';
    const countText = limitApplied
      ? `显示前 ${entries.length} 条 / 共 ${totalFiltered} 条`
      : `${entries.length} 条`;
    if (this.statusEl) this.statusEl.setText(`${countText}${suffix}${ms ? ' · ' + ms + 'ms' : ''}`);
  }

  renderMarkdown(md, el, sourcePath) {
    if (MarkdownRenderer && typeof MarkdownRenderer.render === 'function') {
      return MarkdownRenderer.render(this.app, md, el, sourcePath, this.plugin).catch((e) => {
        el.textContent = md;
        console.error(e);
      });
    }
    if (MarkdownRenderer && typeof MarkdownRenderer.renderMarkdown === 'function') {
      try {
        MarkdownRenderer.renderMarkdown(md, el, sourcePath, this.plugin);
      } catch (e) {
        el.textContent = md;
        console.error(e);
      }
    } else {
      el.textContent = md;
    }
    return Promise.resolve();
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
}

// ============================================================
//  TimelineView
// ============================================================

class TimelineView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.renderer = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return '日记链接时间轴'; }
  getIcon() { return 'git-branch'; }

  async onOpen() {
    this.renderer = new TimelineRenderer(this.plugin, this.contentEl, { live: true });
    await this.renderer.mount();
  }

  async onClose() {
    if (this.renderer) {
      await this.renderer.unmount();
      this.renderer = null;
    }
  }

  async applyExternalFilter(filter) {
    if (this.renderer) await this.renderer.applyExternalFilter(filter);
  }

  get lastEntries() {
    return this.renderer ? this.renderer.lastEntries : [];
  }

  collectLinkTargets(entries) {
    return this.renderer ? this.renderer.collectLinkTargets(entries) : [];
  }
}

// ============================================================
//  插入筛选链接弹窗
// ============================================================

class InsertFilterLinkModal extends Modal {
  constructor(app, plugin, onSubmit) {
    super(app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
    this._filter = '';
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText('插入筛选链接');

    contentEl.createDiv({
      cls: 'diary-timeline-hint',
      text: '选择或输入目标，插入后会得到类似 [项目A](obsidian://diary-timeline?filter=项目A) 的链接。点击即可打开时间轴并切到该筛选。',
    });

    const targets = this.collectTargets();

    const setting = new Setting(contentEl)
      .setName('筛选目标')
      .setDesc(targets.length
        ? '从当前时间轴视图已扫描到的目标中选择，或手动输入任意目标名。'
        : '当前没有打开的时间轴视图。可手动输入目标名，或先打开时间轴再试。');

    let textInput = null;
    setting.addDropdown((d) => {
      d.addOption('', '全部');
      d.addOption(UNLINKED_FILTER, '无链接');
      for (const t of targets) d.addOption(t, t);
      d.setValue(this._filter);
      d.onChange((v) => {
        this._filter = v;
        if (textInput) textInput.value = (v === UNLINKED_FILTER ? '无链接' : v);
        this.updatePreview();
      });
    });

    setting.addText((t) => {
      textInput = t.inputEl;
      t.setPlaceholder('或手动输入目标名');
      t.setValue(this._filter === UNLINKED_FILTER ? '无链接' : (this._filter || ''));
      t.onChange((v) => {
        const trimmed = (v || '').trim();
        if (trimmed === '无链接') this._filter = UNLINKED_FILTER;
        else this._filter = trimmed;
        this.updatePreview();
      });
    });

    this.previewEl = contentEl.createDiv({ cls: 'diary-timeline-preview' });

    const btns = contentEl.createDiv({ cls: 'diary-timeline-buttons' });
    btns.createEl('button', { text: '插入', cls: 'mod-cta' }).onclick = () => this.doInsert();
    btns.createEl('button', { text: '取消' }).onclick = () => this.close();

    this.updatePreview();
  }

  collectTargets() {
    const set = new Set();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof TimelineView) {
        for (const t of leaf.view.collectLinkTargets(leaf.view.lastEntries)) set.add(t);
      }
    }
    if (set.size === 0 && this.plugin.lastKnownEntries && this.plugin.lastKnownEntries.length) {
      const re = linkRe();
      for (const e of this.plugin.lastKnownEntries) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(e.text)) !== null) {
          const t = m[1].trim();
          if (t) set.add(t);
        }
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'));
  }

  buildLink() {
    const f = this._filter || '';
    let text;
    if (!f) text = '全部';
    else if (f === UNLINKED_FILTER) text = '无链接';
    else text = f;

    let url = 'obsidian://' + PROTOCOL_ACTION;
    if (f) url += '?filter=' + encodeURIComponent(f);
    return `[${text}](${url})`;
  }

  updatePreview() {
    if (this.previewEl) this.previewEl.setText('预览：' + this.buildLink());
  }

  doInsert() {
    const md = this.buildLink();
    try {
      this.onSubmit(md);
      new Notice('已插入链接');
    } catch (err) {
      console.error(err);
      new Notice('插入失败：' + (err && err.message ? err.message : String(err)));
    }
    this.close();
  }

  onClose() { this.contentEl.empty(); }
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
    this._sortOrder = plugin.settings.exportSortOrder === 'asc' ? 'asc' : 'desc';
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

    new Setting(contentEl)
      .setName('导出顺序')
      .setDesc('升序：旧→新，按时间线推进；降序：新→旧。')
      .addDropdown((d) => d
        .addOption('asc', '升序（旧→新）')
        .addOption('desc', '降序（新→旧）')
        .setValue(this._sortOrder)
        .onChange((v) => { this._sortOrder = v === 'desc' ? 'desc' : 'asc'; }));

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
    this.plugin.settings.exportSortOrder = this._sortOrder;
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
      const ordered = this.plugin.sortEntries(this.entries.slice(), this._sortOrder);
      const md = this.plugin.buildExportMarkdown(ordered, vars.title);
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
      const ordered = this.plugin.sortEntries(this.entries.slice(), this._sortOrder);
      const md = this.plugin.buildExportMarkdown(ordered, vars.title);
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
//  设置面板
// ============================================================

class TimelineSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  refreshAllViews() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof TimelineView && leaf.view.renderer) {
        const r = leaf.view.renderer;
        r._lastTargetsKey = null;
        r.updateFilterOptions(r.collectLinkTargets(r.lastEntries));
        r.updatePinButton();
        r.renderPinnedFilters();
      }
    }
  }

  setSubSettingsVisible(el, visible) {
    if (!el) return;
    el.toggleClass('is-collapsed', !visible);
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
          this.plugin.fileCache.clear();
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
          for (const leaf of leaves) {
            if (leaf.view instanceof TimelineView && leaf.view.renderer) {
              leaf.view.renderer.render(true);
            }
          }
        }));

    // ---- 展示方式 ----
    containerEl.createEl('h4', { text: '展示方式' });

    new Setting(containerEl)
      .setName('打开时展示位置')
      .setDesc('侧边栏：桌面打开右侧栏、移动端打开主区标签页；在笔记中：命令会在当前笔记插入 ' + FENCE + 'diary-timeline 代码块。无论选哪个，代码块渲染始终可用。')
      .addDropdown((d) => d
        .addOption('sidebar', '侧边栏标签页')
        .addOption('in-note', '在笔记中（代码块）')
        .setValue(this.plugin.settings.displayMode || 'sidebar')
        .onChange(async (v) => {
          this.plugin.settings.displayMode = v;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('时间轴排序')
      .setDesc('降序：最新在前（时间轴常见习惯）；升序：最早在前。导出弹窗中可单独选择导出顺序。')
      .addDropdown((d) => d
        .addOption('desc', '降序（最新在前）')
        .addOption('asc', '升序（最早在前）')
        .setValue(this.plugin.settings.sortOrder === 'asc' ? 'asc' : 'desc')
        .onChange(async (v) => {
          await this.plugin.setSortOrder(v);
        }));

    new Setting(containerEl)
      .setName('仅渲染前 N 条')
      .setDesc('开启后每次最多渲染 N 条筛选结果，减少长列表首次打开或切换筛选时的卡顿。导出不受影响，仍导出全部筛选结果。')
      .addToggle((t) => t
        .setValue(!!this.plugin.settings.limitRenderCount)
        .onChange(async (v) => {
          this.plugin.settings.limitRenderCount = v;
          await this.plugin.saveSettings();
          this.plugin.refreshAllRenderers();
        }));

    new Setting(containerEl)
      .setName('渲染条数上限')
      .setDesc('仅在上方开关开启时生效，建议 50–300。')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.inputEl.min = '1';
        t.inputEl.max = '5000';
        t.setPlaceholder('100')
          .setValue(String(this.plugin.settings.renderLimit || 100))
          .onChange((v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.renderLimit = (Number.isFinite(n) && n > 0) ? Math.min(n, 5000) : 100;
            this.plugin.saveSettings();
            if (this._limitTimer) clearTimeout(this._limitTimer);
            this._limitTimer = setTimeout(() => this.plugin.refreshAllRenderers(), 400);
          });
      });

    new Setting(containerEl)
      .setName('开机时自动打开')
      .setDesc('开启后，Obsidian 启动完毕时自动打开时间轴视图（仅“侧边栏标签页”模式生效）。')
      .addToggle((t) => t
        .setValue(!!this.plugin.settings.autoOpenOnStartup)
        .onChange(async (v) => {
          this.plugin.settings.autoOpenOnStartup = v;
          await this.plugin.saveSettings();
        }));

    // ---- 快捷入口 ----
    containerEl.createEl('h4', { text: '快捷入口' });

    new Setting(containerEl)
      .setName('桌面 Ribbon 图标')
      .setDesc('左侧 Ribbon 栏的 "日记链接时间轴" 图标已自动注册，点击即按"展示方式"配置执行。')
      .addButton((b) => b
        .setButtonText('说明')
        .setDisabled(true));

    new Setting(containerEl)
      .setName('快捷键')
      .setDesc('在"设置 → 快捷键"中搜索 "日记链接时间轴" 或 "打开日记链接时间轴" 即可绑定。')
      .addButton((b) => b
        .setButtonText('打开快捷键设置')
        .onClick(() => {
          try {
            this.app.setting.open();
            this.app.setting.openTabById('hotkeys');
          } catch (e) {
            new Notice('请手动打开 设置 → 快捷键');
          }
        }));

    new Setting(containerEl)
      .setName('移动端工具栏')
      .setDesc('在"设置 → 移动端 → 管理移动端工具栏"中，可以把 "打开日记链接时间轴" 命令添加到工具栏。')
      .addButton((b) => b
        .setButtonText('说明')
        .setDisabled(true));

    new Setting(containerEl)
      .setName('笔记内嵌入代码块')
      .setDesc('在任何笔记中插入 ' + FENCE + 'diary-timeline 代码块即可内嵌时间轴。可加参数 filter=项目A 预设筛选。')
      .addButton((b) => b
        .setButtonText('在当前笔记插入')
        .onClick(() => this.plugin.insertTimelineBlock()));

    // ---- 点击交互 ----
    containerEl.createEl('h4', { text: '点击交互' });

    let subSettingsEl = null;

    new Setting(containerEl)
      .setName('启用点击交互')
      .setDesc('总开关。关闭后时间、日期、双链、文字的所有点击增强都失效，视图变为纯展示。')
      .addToggle((t) => t
        .setValue(!!this.plugin.settings.enableClickActions)
        .onChange(async (v) => {
          this.plugin.settings.enableClickActions = v;
          await this.plugin.saveSettings();
          this.setSubSettingsVisible(subSettingsEl, v);
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
          for (const leaf of leaves) {
            if (leaf.view instanceof TimelineView && leaf.view.renderer) {
              leaf.view.renderer.renderView();
            }
          }
        }));

    subSettingsEl = containerEl.createDiv({ cls: 'diary-timeline-subsettings' });
    this.setSubSettingsVisible(subSettingsEl, !!this.plugin.settings.enableClickActions);

    new Setting(subSettingsEl)
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

    new Setting(subSettingsEl)
      .setName('点击文字时复制时间块')
      .setDesc('开启后，鼠标短按/长按 600ms 复制；移动端轻点复制、长按交给系统选择。')
      .addToggle((t) => t
        .setValue(!!this.plugin.settings.textClickCopy)
        .onChange(async (v) => {
          this.plugin.settings.textClickCopy = v;
          await this.plugin.saveSettings();
        }));

    // ---- 置顶筛选 ----
    containerEl.createEl('h4', { text: '置顶筛选' });

    const pinned = this.plugin.settings.pinnedFilters || [];
    if (pinned.length === 0) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: '（无）在视图工具栏选择筛选目标后，点击 ☆ 可置顶。视图顶部会显示快捷 chip，单击 chip 切换筛选。取消置顶请在本面板逐个移除。',
      });
    } else {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: '以下是已置顶的筛选目标。视图顶部单击 chip 切换筛选；取消置顶请使用下方的“取消置顶”按钮。',
      });
      for (const target of pinned) {
        const label = target === UNLINKED_FILTER ? '无链接' : target;
        new Setting(containerEl)
          .setName(label)
          .addButton((b) => b
            .setButtonText('取消置顶')
            .onClick(async () => {
              await this.plugin.togglePinnedFilter(target);
              this.refreshAllViews();
              this.display();
            }));
      }
      new Setting(containerEl)
        .addButton((b) => b
          .setButtonText('清除全部置顶')
          .setWarning()
          .onClick(async () => {
            if (!window.confirm('确定要清除所有置顶筛选吗？')) return;
            await this.plugin.clearPinnedFilters();
            this.refreshAllViews();
            this.display();
          }));
    }

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
      .setDesc('留空时：有筛选目标则用该目标（链接标题），否则用“日记链接时间轴”。此标题会出现在导出文件的顶部，也会替换文件名模板中的 {{title}}。')
      .addText((t) => t
        .setPlaceholder('留空则使用筛选目标或默认标题')
        .setValue(this.plugin.settings.exportTitle || '')
        .onChange(async (v) => {
          this.plugin.settings.exportTitle = v.trim();
          await this.plugin.saveSettings();
        }));
  }
}

module.exports = DiaryLinkTimelinePlugin;
