import { isTinyImage, pickImageSource } from '../lib/urls';
import type { FetchImageResult } from '../lib/types';

export interface ImageItem {
  id: number;
  url: string;
  /** 已经是 data: 内联图，无需抓取 */
  inline: boolean;
}

export interface CollectResult {
  items: ImageItem[];
  /** 图片元素上没有可用地址、已从 DOM 移除的数量 */
  dropped: number;
}

/**
 * 遍历正文里的 <img>，解析出最佳地址、写入 data-w2m-id 占位标记。
 * 相同 URL 只抓一次（同一图片在页面上重复出现很常见）。
 */
export function collectImages(root: Element, baseUrl: string): CollectResult {
  const items: ImageItem[] = [];
  const seen = new Map<string, number>();
  let dropped = 0;

  for (const node of Array.from(root.querySelectorAll('img'))) {
    const img = node as HTMLImageElement;
    const url = pickImageSource(img, baseUrl);
    if (!url || isTinyImage(img, url)) {
      img.remove();
      dropped++;
      continue;
    }

    let id = seen.get(url);
    if (id === undefined) {
      id = items.length;
      seen.set(url, id);
      items.push({ id, url, inline: /^data:/i.test(url) });
    }

    img.setAttribute('data-w2m-id', String(id));
    img.setAttribute('src', url);
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    img.removeAttribute('loading');
  }

  return { items, dropped };
}

export interface EmbedOptions {
  compressImages: boolean;
  maxEdge: number;
  quality: number;
}

/**
 * 并发抓取图片并转成 dataURI。单张失败不影响其它图片，最终落回原始 URL。
 */
export async function embedImages(
  items: ImageItem[],
  options: EmbedOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, string>> {
  const results = new Map<number, string>();
  const queue: ImageItem[] = [];

  for (const item of items) {
    if (item.inline) results.set(item.id, item.url);
    else queue.push(item);
  }

  const total = queue.length;
  let done = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= queue.length) return;
      const item = queue[index];
      const dataUrl = await fetchOne(item.url, options);
      if (dataUrl) results.set(item.id, dataUrl);
      done++;
      onProgress?.(done, total);
    }
  };

  const workers = Math.min(6, total);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

async function fetchOne(url: string, options: EmbedOptions): Promise<string | null> {
  // blob: 地址只存在于页面上下文，只能在前台取
  if (url.startsWith('blob:')) return blobUrlToDataUrl(url);

  const first = await backgroundFetch(url, options);
  if (first.ok) return first.dataUrl;

  // 兜底 1：同源图片用页面上下文再取一次（带页面 referer，可绕过部分防盗链）
  if (isSameOrigin(url)) {
    const fromPage = await pageFetch(url);
    if (fromPage) return fromPage;
  }

  // 兜底 2：网络抖动/超时重试一次；4xx 说明资源确实不存在，不再重试
  if (!/^HTTP 4\d\d/.test(first.error)) {
    const second = await backgroundFetch(url, options);
    if (second.ok) return second.dataUrl;
  }
  return null;
}

async function backgroundFetch(
  url: string,
  options: EmbedOptions,
): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }> {
  try {
    const res = (await chrome.runtime.sendMessage({
      __w2m: true,
      type: 'FETCH_IMAGE',
      payload: { url, ...options },
    })) as FetchImageResult | undefined;
    if (res?.ok) return { ok: true, dataUrl: res.dataUrl };
    return { ok: false, error: res?.error ?? 'no-response' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'send-failed' };
  }
}

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

async function pageFetch(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return await blobToDataUrl(await res.blob());
  } catch {
    return null;
  }
}

async function blobUrlToDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    return await blobToDataUrl(await res.blob());
  } catch {
    return null;
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}
