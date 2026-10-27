/**
 * 图片地址解析。
 *
 * 关键背景：正文提取是在「离线文档」上进行的，图片元素没有真正加载，
 * `img.currentSrc` / `naturalWidth` 都是空的。所以真正渲染出来的那张图
 * 必须在提取前从**活的 DOM** 上打标（见 stampLiveImages），再沿 DOM 走下来。
 *
 * 优先级：页面上真正加载的那张（currentSrc） > srcset 最大候选 > 懒加载属性 > src。
 */

const LAZY_ATTRS = [
  'data-src',
  'data-original',
  'data-lazy-src',
  'data-lazyload',
  'data-actualsrc',
  'data-original-src',
  'data-echo',
  'data-hi-res-src',
  'data-large',
];

const SKIP_SCHEME = /^(javascript|about|chrome|chrome-extension|moz-extension|edge|view-source):/i;

export const STAMP_SRC = 'data-w2m-src';
export const STAMP_SMALL = 'data-w2m-small';
export const STAMP_W = 'data-w2m-w';
export const STAMP_H = 'data-w2m-h';

/** 把相对地址解析为绝对地址；不可用地址返回 null。data:/blob: 原样保留。 */
export function absoluteUrl(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  const v = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!v || v === '#' || SKIP_SCHEME.test(v)) return null;
  if (/^https?:/i.test(v) || /^data:/i.test(v) || /^blob:/i.test(v)) return v;
  try {
    return new URL(v, base).href;
  } catch {
    return null;
  }
}

/** 是否是占位图（1px gif、骨架图、blank.gif 之类）。 */
export function isPlaceholder(raw: string | null | undefined): boolean {
  if (!raw) return true;
  const v = raw.trim();
  if (!v) return true;
  if (/^data:image\/(gif|png|webp);base64,[A-Za-z0-9+/=\s]{0,400}$/i.test(v)) return true;
  if (/^data:image\/svg\+xml/i.test(v) && v.length < 400) return true;
  return /(?:^|[/_-])(?:blank|spacer|pixel|transparent|placeholder|lazy|loading|grey|gray|1x1)(?:[._/-]|$)/i.test(
    v,
  );
}

/**
 * 解析 srcset，返回清晰度最高的 URL。
 * 支持 `url 800w` / `url 2x` 两种描述符，也兼容无描述符。
 */
export function bestSrcsetUrl(srcset: string | null | undefined, base: string): string | null {
  if (!srcset) return null;
  const raw = srcset.trim();
  if (!raw) return null;
  if (/^data:/i.test(raw)) return raw; // data URI 内含逗号，无法安全切分

  let best: { url: string; score: number } | null = null;
  for (const part of raw.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const m = /^(\S+?)(?:\s+(\d+(?:\.\d+)?)([wx]))?$/.exec(seg);
    if (!m) continue;
    const url = absoluteUrl(m[1], base);
    if (!url) continue;
    const n = m[2] ? Number(m[2]) : 1;
    const score = m[3] === 'w' ? n : n * 1000;
    if (!best || score > best.score) best = { url, score };
  }
  return best?.url ?? null;
}

/** <picture> 内所有 <source srcset> 中最高清的候选。 */
function pictureBest(img: Element, base: string): string | null {
  const pic = img.closest('picture');
  if (!pic) return null;
  let best: { url: string; score: number } | null = null;
  for (const source of Array.from(pic.querySelectorAll('source'))) {
    for (const set of [source.getAttribute('srcset'), source.getAttribute('data-srcset')]) {
      if (!set) continue;
      for (const part of set.split(',')) {
        const m = /^(\S+?)(?:\s+(\d+(?:\.\d+)?)([wx]))?$/.exec(part.trim());
        if (!m) continue;
        const url = absoluteUrl(m[1], base);
        if (!url) continue;
        const n = m[2] ? Number(m[2]) : 1;
        const score = m[3] === 'w' ? n : n * 1000;
        if (!best || score > best.score) best = { url, score };
      }
    }
  }
  return best?.url ?? null;
}

/** 取页面上一张图片的「最佳可用地址」。 */
export function pickImageSource(img: Element, base: string): string | null {
  const attr = (n: string) => img.getAttribute(n);

  // 1. 页面上真正渲染出来的那张（提取前打标）
  const stamped = absoluteUrl(attr(STAMP_SRC), base);
  if (stamped && !isPlaceholder(stamped)) return stamped;

  // 2. srcset / <picture> 中最大的一张（通常在图片未加载时使用）
  const srcsetBest =
    bestSrcsetUrl(attr('srcset'), base) ??
    bestSrcsetUrl(attr('data-srcset'), base) ??
    bestSrcsetUrl(attr('data-lazy-srcset'), base) ??
    pictureBest(img, base);
  if (srcsetBest) return srcsetBest;

  const src = attr('src');
  const lazy = firstUsable(LAZY_ATTRS.map((a) => attr(a)), base);
  if (lazy && isPlaceholder(src)) return lazy;

  // 3. 普通 src，最后才是懒加载属性
  return absoluteUrl(src, base) ?? lazy ?? absoluteUrl((img as HTMLImageElement).currentSrc, base);
}

function firstUsable(values: Array<string | null>, base: string): string | null {
  for (const v of values) {
    if (!v || isPlaceholder(v)) continue;
    const url = absoluteUrl(v, base);
    if (url) return url;
  }
  return null;
}

/** 追踪像素 / 装饰性图标：不进入 Markdown。 */
export function isTinyImage(img: Element, url: string | null): boolean {
  if (img.getAttribute(STAMP_SMALL) === '1') return true;
  const w = Number(img.getAttribute('width') || 0);
  const h = Number(img.getAttribute('height') || 0);
  if ((w > 0 && w <= 2) || (h > 0 && h <= 2)) return true;

  // 页面上实际渲染尺寸很小（图标/星标/徽章）
  const rw = Number(img.getAttribute(STAMP_W) || 0);
  const rh = Number(img.getAttribute(STAMP_H) || 0);
  if (rw > 0 && rh > 0 && rw < 24 && rh < 24) return true;

  if (url && /(?:^|[/_-])(?:pixel|spacer|beacon|track)(?:[._/-]|$)/i.test(url)) return true;
  return false;
}

/**
 * 把活 DOM 上「真正渲染的图片信息」写到目标副本上。
 * live 与 target 必须结构同构（document.cloneNode / 选区克隆），按文档顺序配对。
 */
export function stampLiveImages(liveRoot: ParentNode, targetRoot: ParentNode): void {
  if (liveRoot === targetRoot) return;
  const live = liveRoot.querySelectorAll('img');
  const copies = targetRoot.querySelectorAll('img');
  const n = Math.min(live.length, copies.length);
  for (let i = 0; i < n; i++) {
    const src = live[i] as HTMLImageElement;
    const copy = copies[i];
    const current = src.currentSrc || '';
    if (current && !current.startsWith('blob:')) copy.setAttribute(STAMP_SRC, current);

    // 判断「渲染尺寸」而不是 natural 尺寸：1x1 占位图被放大显示时不能误杀
    const hasLazyCandidate =
      Boolean(src.getAttribute('srcset') || src.getAttribute('data-srcset')) ||
      LAZY_ATTRS.some((name) => Boolean(src.getAttribute(name)));
    if (hasLazyCandidate) continue;

    const rect = typeof src.getBoundingClientRect === 'function' ? src.getBoundingClientRect() : null;
    const width = rect && rect.width > 0 ? rect.width : Number(src.getAttribute('width') || 0);
    const height = rect && rect.height > 0 ? rect.height : Number(src.getAttribute('height') || 0);
    if (width > 0 && height > 0) {
      copy.setAttribute(STAMP_W, String(Math.round(width)));
      copy.setAttribute(STAMP_H, String(Math.round(height)));
      if (width <= 2 || height <= 2) copy.setAttribute(STAMP_SMALL, '1');
    }
  }
}
