import {
  DEFAULT_SETTINGS,
  type FetchImageResult,
  type SaveMode,
  type Settings,
} from './lib/types';

const MENU_PAGE = 'w2m-save-page';
const MENU_SELECTION = 'w2m-save-selection';
const IMAGE_TIMEOUT_MS = 25_000;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

type Bytes = Uint8Array<ArrayBuffer>;

chrome.runtime.onInstalled.addListener(() => setupMenus());
chrome.runtime.onStartup.addListener(() => setupMenus());
setupMenus();

let menusReady = false;

function setupMenus(): void {
  if (menusReady) return; // onInstalled 与启动事件可能同时触发
  menusReady = true;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: '保存整页为 Markdown',
      contexts: ['page', 'link', 'image', 'frame'],
    });
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: '保存选中内容为 Markdown',
      contexts: ['selection'],
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const mode: SaveMode = info.menuItemId === MENU_SELECTION ? 'selection' : 'page';
  void saveForTab(tab.id, mode);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab?.id) return;
  const mode: SaveMode = command === 'save-selection' ? 'selection' : 'page';
  void saveForTab(tab.id, mode);
});

/** 右键菜单 / 快捷键入口：注入内容脚本 → 触发保存（页面内浮层显示进度）。 */
async function saveForTab(tabId: number, mode: SaveMode): Promise<void> {
  try {
    const settings = await loadSettings();
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, {
      __w2m: true,
      type: 'BUILD',
      payload: { ...settings, mode, action: 'download', toast: true },
    });
  } catch (error) {
    console.warn('[Page2MD] 保存失败：', error);
    await flashBadge(tabId);
  }
}

/** 静默入口失败时（如受保护页面）用角标提示一下。 */
async function flashBadge(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    await chrome.action.setBadgeText({ tabId, text: '!' });
    setTimeout(() => {
      void chrome.action.setBadgeText({ tabId, text: '' });
    }, 5000);
  } catch {
    /* 标签页已关闭等情况忽略 */
  }
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { __w2m: true, type: 'PING' });
    return;
  } catch {
    /* 尚未注入 */
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await chrome.tabs.sendMessage(tabId, { __w2m: true, type: 'PING' });
}

async function loadSettings(): Promise<Settings> {
  try {
    const got = await chrome.storage.sync.get('settings');
    return { ...DEFAULT_SETTINGS, ...((got.settings as Partial<Settings>) ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// ---------------- 图片抓取 ----------------

interface ImageRequest {
  url: string;
  compressImages: boolean;
  maxEdge: number;
  quality: number;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.__w2m !== true) return undefined;

  if (message.type === 'FETCH_IMAGE') {
    fetchImage(message.payload as ImageRequest)
      .then(sendResponse)
      .catch((error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : '抓取失败' }),
      );
    return true;
  }
  return undefined;
});

async function fetchImage(request: ImageRequest): Promise<FetchImageResult> {
  if (!/^https?:/i.test(request.url)) return { ok: false, error: '不支持的地址' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, {
      credentials: 'include',
      signal: controller.signal,
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };

    const blob = await response.blob();
    if (blob.size === 0) return { ok: false, error: '空响应' };
    if (blob.size > MAX_IMAGE_BYTES) return { ok: false, error: '图片过大' };

    let bytes: Bytes = new Uint8Array(await blob.arrayBuffer());
    let mime = detectMime(bytes, blob.type, request.url);
    if (!mime.startsWith('image/')) return { ok: false, error: '响应不是图片' };

    if (request.compressImages) {
      try {
        const compressed = await compressImage(bytes, mime, request);
        if (compressed) {
          bytes = compressed.bytes;
          mime = compressed.mime;
        }
      } catch {
        /* 压缩失败就保留原图 */
      }
    }

    return {
      ok: true,
      dataUrl: `data:${mime};base64,${toBase64(bytes)}`,
      mime,
      bytes: bytes.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function compressImage(
  bytes: Bytes,
  mime: string,
  request: ImageRequest,
): Promise<{ bytes: Bytes; mime: string } | null> {
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) return null;

  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, request.maxEdge / longest);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  if (scale === 1 && bytes.length <= 400 * 1024) {
    bitmap.close();
    return null;
  }

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return null;
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const outMime = mime === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await canvas.convertToBlob({
    type: outMime,
    quality: outMime === 'image/jpeg' ? request.quality : undefined,
  });
  const out: Bytes = new Uint8Array(await blob.arrayBuffer());
  if (out.length >= bytes.length) return null;
  return { bytes: out, mime: outMime };
}

function toBase64(bytes: Bytes): string {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[],
    );
  }
  return btoa(binary);
}

/** 根据文件头识别真实类型（服务端 Content-Type 经常是错的）。 */
export function detectMime(bytes: Uint8Array, contentType: string, url: string): string {
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...Array.from(bytes.subarray(start, end)));

  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    ascii(1, 4) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length > 6 && (ascii(0, 4) === 'GIF8')) return 'image/gif';
  if (bytes.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length > 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand.startsWith('hei') || brand === 'mif1') return 'image/heic';
  }
  if (bytes.length > 2 && ascii(0, 2) === 'BM') return 'image/bmp';
  const head = ascii(0, Math.min(bytes.length, 400)).trimStart();
  if (/^<\?xml|^<svg/i.test(head) && /<svg[\s>]/i.test(head)) return 'image/svg+xml';

  const declared = (contentType || '').split(';')[0].trim().toLowerCase();
  if (declared.startsWith('image/')) return declared;

  const ext = /\.(jpe?g|png|gif|webp|avif|svg|bmp)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  const byExt: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
  };
  if (ext && byExt[ext]) return byExt[ext];

  return (contentType || '').trim() || 'application/octet-stream';
}
