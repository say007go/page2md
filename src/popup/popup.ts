import type {
  AnalyzeResult,
  BuildOptions,
  BuildResult,
  ProgressEvent,
  SaveAction,
  SaveMode,
  Settings,
} from '../lib/types';
import { DEFAULT_SETTINGS } from '../lib/types';
import { datePrefix, formatBytes, formatNumber } from '../lib/text';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const el = {
  pageTitle: $('pageTitle'),
  pageMeta: $('pageMeta'),
  pageHint: $('pageHint'),
  opts: $('opts'),
  optEmbed: $<HTMLInputElement>('optEmbed'),
  optCompress: $<HTMLInputElement>('optCompress'),
  optMeta: $<HTMLInputElement>('optMeta'),
  optDate: $<HTMLInputElement>('optDate'),
  datePreview: $('datePreview'),
  btnSave: $<HTMLButtonElement>('btnSave'),
  btnSaveText: $('btnSaveText'),
  btnCopy: $<HTMLButtonElement>('btnCopy'),
  btnSelection: $<HTMLButtonElement>('btnSelection'),
  status: $('status'),
  statusText: $('statusText'),
  statusCount: $('statusCount'),
  barFill: $('barFill'),
  bar: document.querySelector('.bar') as HTMLElement,
  result: $('result'),
  shortcutTip: $<HTMLButtonElement>('shortcutTip'),
  themeToggle: $<HTMLButtonElement>('themeToggle'),
};

type ThemePref = 'auto' | 'light' | 'dark';

const THEME_LABEL: Record<ThemePref, string> = {
  auto: '跟随系统',
  light: '浅色',
  dark: '深色',
};

const DEMO = new URLSearchParams(location.search).get('demo') === '1';
/** 调试入口：?tabId=123 可指定标签页，便于在普通标签中打开弹窗做端到端验证。 */
const FORCED_TAB_ID = Number(new URLSearchParams(location.search).get('tabId') ?? 0);

let tabId: number | null = null;
let settings: Settings = { ...DEFAULT_SETTINGS };
let mode: SaveMode = 'page';
let busy = false;
let ready = false;

void init();

async function init(): Promise<void> {
  bindResultClose();
  bindTheme();
  if (DEMO) {
    renderDemo();
    return;
  }

  settings = await loadSettings();
  applySettings();
  bindEvents();
  el.datePreview.textContent = `${datePrefix()}-标题.md`;

  if (FORCED_TAB_ID > 0) {
    tabId = FORCED_TAB_ID;
    await analyze();
    return;
  }

  const tab = await activeTab();
  if (!tab?.id || !canRunOn(tab.url ?? '')) {
    showUnsupported();
    return;
  }
  tabId = tab.id;

  await analyze();
}

// ---------------- 数据 ----------------

async function loadSettings(): Promise<Settings> {
  try {
    const got = await chrome.storage.sync.get('settings');
    return { ...DEFAULT_SETTINGS, ...((got.settings as Partial<Settings>) ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(): Promise<void> {
  if (!el.optEmbed.checked) el.optCompress.checked = false;
  const next: Settings = {
    embedImages: el.optEmbed.checked,
    compressImages: el.optCompress.checked,
    maxEdge: settings.maxEdge,
    quality: settings.quality,
    includeMeta: el.optMeta.checked,
    datePrefix: el.optDate.checked,
  };
  settings = next;
  syncOptionState();
  try {
    await chrome.storage.sync.set({ settings: next });
  } catch {
    /* 忽略存储失败 */
  }
}

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  } catch {
    return null;
  }
}

function canRunOn(url: string): boolean {
  if (!url) return false;
  if (/^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):/i.test(url)) return false;
  if (/^https?:\/\/chromewebstore\.google\.com/i.test(url)) return false;
  if (/^https?:\/\/chrome\.google\.com\/webstore/i.test(url)) return false;
  return true;
}

// ---------------- 与内容脚本通信 ----------------

async function send<T>(type: string, payload?: unknown): Promise<T> {
  if (tabId == null) throw new Error('当前页面不可用');
  try {
    return (await chrome.tabs.sendMessage(tabId, { __w2m: true, type, payload })) as T;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return (await chrome.tabs.sendMessage(tabId, { __w2m: true, type, payload })) as T;
  }
}

async function analyze(): Promise<void> {
  el.pageTitle.textContent = '正在识别页面…';
  el.pageMeta.textContent = '';
  try {
    const res = await send<AnalyzeResult>('ANALYZE');
    if (!res?.ok) {
      showFailure(res?.error ?? '未识别到正文');
      return;
    }
    ready = true;
    el.pageTitle.textContent = res.title || '未命名页面';
    const parts = [res.site, `${formatNumber(res.chars)} 字`, `${res.images} 张图`].filter(Boolean);
    el.pageMeta.innerHTML = parts.map((p) => `<span>${escapeHtml(p)}</span>`).join('<i class="dot"></i>');
    if (res.hasSelection) {
      el.btnSelection.hidden = false;
      el.pageHint.hidden = true;
    }
    setButtonsEnabled(true);
  } catch (error) {
    showFailure(describe(error));
  }
}

// ---------------- 交互 ----------------

function bindEvents(): void {
  for (const input of [el.optEmbed, el.optCompress, el.optMeta, el.optDate]) {
    input.addEventListener('change', () => {
      void saveSettings();
    });
  }

  el.btnSave.addEventListener('click', () => {
    void run('download');
  });

  el.btnCopy.addEventListener('click', () => {
    void run('copy');
  });

  el.btnSelection.addEventListener('click', () => {
    mode = 'selection';
    void run('download');
  });

  el.shortcutTip.addEventListener('click', () => {
    void openShortcutSettings();
  });
}

function applySettings(): void {
  el.optEmbed.checked = settings.embedImages;
  el.optCompress.checked = settings.compressImages;
  el.optMeta.checked = settings.includeMeta;
  el.optDate.checked = settings.datePrefix;
  syncOptionState();
}

function syncOptionState(): void {
  const compressRow = el.optCompress.closest('.opt') as HTMLElement | null;
  compressRow?.classList.toggle('disabled', !el.optEmbed.checked);
  if (!el.optEmbed.checked) {
    el.optCompress.checked = false;
    settings.compressImages = false;
  }
}

function setButtonsEnabled(enabled: boolean): void {
  el.btnSave.disabled = !enabled;
  el.btnCopy.disabled = !enabled;
  el.btnSelection.disabled = !enabled;
}

async function run(action: SaveAction): Promise<void> {
  if (busy || tabId == null || !ready) return;
  busy = true;
  setButtonsEnabled(false);
  el.result.hidden = true;
  el.status.hidden = false;
  el.btnSaveText.textContent = action === 'copy' ? '生成中…' : '保存中…';
  setProgress('正在准备…');

  const port = chrome.tabs.connect(tabId, { name: 'w2m-progress' });
  port.onMessage.addListener((event: ProgressEvent) => {
    if (event?.type !== 'progress') return;
    const count =
      event.total != null ? `${event.done ?? 0} / ${event.total}` : '';
    setProgress(event.message, count, event.done, event.total);
  });
  port.onDisconnect.addListener(() => void chrome.runtime.lastError);

  try {
    const options: BuildOptions = {
      ...settings,
      mode,
      action,
      toast: false,
    };
    const res = await send<BuildResult>('BUILD', options);
    port.disconnect();

    if (!res?.ok) {
      showFailure(res?.error ?? '保存失败');
      return;
    }

    const stats = res.stats;
    // 保存/复制完成后，选区入口已完成使命，收起来给结果区腾空间
    el.btnSelection.hidden = true;
    if (action === 'copy') {
      if (!res.markdown) throw new Error('没有拿到 Markdown 内容');
      await copyText(res.markdown);
      renderResult(
        'ok',
        `已复制到剪贴板 · <b>${formatNumber(stats.words)}</b> 字 · ${describeImages(stats)}`,
      );
    } else {
      renderResult(
        'ok',
        `已保存 <b>${escapeHtml(stats.filename)}</b><br>${formatBytes(stats.bytes)} · ${describeImages(
          stats,
        )} · ${formatNumber(stats.words)} 字`,
      );
    }
    el.status.hidden = true;
  } catch (error) {
    port.disconnect();
    showFailure(describe(error));
  } finally {
    busy = false;
    setButtonsEnabled(true);
    el.btnSaveText.textContent = '保存 .md';
  }
}

function describeImages(stats: { images: number; imagesEmbedded: number; imagesFailed: number }): string {
  if (!stats.images) return '无图片';
  if (stats.imagesEmbedded === 0 && stats.imagesFailed === 0) {
    return `${stats.images} 张图片（保留原链接）`;
  }
  if (stats.imagesFailed > 0) {
    return `${stats.imagesEmbedded}/${stats.images} 张图片已内嵌（${stats.imagesFailed} 张保留原链接）`;
  }
  return `${stats.images} 张图片全部内嵌`;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

// ---------------- 渲染 ----------------

function setProgress(message: string, count = '', done?: number, total?: number): void {
  el.statusText.textContent = message;
  el.statusCount.textContent = count;
  if (done != null && total) {
    el.bar.classList.remove('indeterminate');
    el.barFill.style.width = `${Math.max(2, Math.round((done / total) * 100))}%`;
  } else {
    el.bar.classList.add('indeterminate');
    el.barFill.style.width = '';
  }
}

function renderResult(kind: 'ok' | 'err', html: string): void {
  el.result.className = `result ${kind}`;
  el.result.innerHTML = `<button class="result-close" type="button" aria-label="关闭">×</button>${html}`;
  el.result.hidden = false;
  el.status.hidden = true;
  if (kind === 'err') {
    el.pageTitle.textContent = '无法保存这个页面';
    el.pageMeta.textContent = '';
  }
}

function bindResultClose(): void {
  el.result.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('.result-close')) {
      el.result.hidden = true;
      el.result.innerHTML = '';
    }
  });
}

// ---------------- 主题 ----------------

function currentThemePref(): ThemePref {
  const value = document.documentElement.dataset.themePref;
  return value === 'light' || value === 'dark' ? value : 'auto';
}

function updateThemeButton(): void {
  const label = THEME_LABEL[currentThemePref()];
  el.themeToggle.title = `主题：${label}（点击切换）`;
  el.themeToggle.setAttribute('aria-label', `当前主题：${label}，点击切换`);
}

function bindTheme(): void {
  updateThemeButton();
  el.themeToggle.addEventListener('click', () => {
    const order: ThemePref[] = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(currentThemePref()) + 1) % order.length];
    const apply = (window as unknown as { __setPage2mdTheme?: (pref: ThemePref) => void })
      .__setPage2mdTheme;
    apply?.(next);
    updateThemeButton();
  });
}

/** 直接打开浏览器的扩展快捷键设置页；打不开时给出可关闭的提示。 */
async function openShortcutSettings(): Promise<void> {
  try {
    await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    window.close();
  } catch {
    renderResult('ok', '在地址栏打开 <b>chrome://extensions/shortcuts</b> 即可修改快捷键。');
  }
}

function showFailure(message: string): void {
  ready = false;
  setButtonsEnabled(false);
  renderResult('err', escapeHtml(message));
}

function showUnsupported(): void {
  el.pageTitle.textContent = '此页面不支持保存';
  el.pageMeta.textContent = 'Chrome 内部页面、扩展商店不支持读取内容';
  el.pageHint.hidden = false;
  el.pageHint.textContent = '请切换到普通网页后重试';
  setButtonsEnabled(false);
  el.btnSave.disabled = true;
  el.btnCopy.disabled = true;
}

function renderDemo(): void {
  el.pageTitle.textContent = '2026 企业人才培养趋势报告：从岗位能力到组织能力';
  el.pageMeta.innerHTML =
    '<span>quantumedu.cn</span><i class="dot"></i><span>3,486 字</span><i class="dot"></i><span>8 张图</span>';
  el.btnSelection.hidden = false;
  el.pageHint.hidden = true;
  el.datePreview.textContent = `${datePrefix()}-标题.md`;
  settings = { ...DEFAULT_SETTINGS };
  applySettings();
  setButtonsEnabled(true);

  el.btnSave.addEventListener('click', () => {
    el.result.hidden = true;
    el.status.hidden = false;
    setProgress('正在嵌入图片 5/8', '5 / 8', 5, 8);
    window.setTimeout(() => {
      el.status.hidden = true;
      el.btnSelection.hidden = true;
      renderResult(
        'ok',
        '已保存 <b>2026 企业人才培养趋势报告.md</b><br>2.41 MB · 8 张图片全部内嵌 · 3,486 字',
      );
    }, 1200);
  });

  el.shortcutTip.addEventListener('click', () => {
    void openShortcutSettings();
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || '未知错误');
}
