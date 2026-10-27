import { Readability } from '@mozilla/readability';
import { stampLiveImages } from './urls';
import { pruneNoiseContainers } from './clean';

export interface Extracted {
  html: string;
  title: string;
  byline: string;
  siteName: string;
  excerpt: string;
  publishedTime: string;
  method: 'readability' | 'fallback';
  textLength: number;
}

export interface PageMeta {
  title: string;
  byline: string;
  siteName: string;
  excerpt: string;
  published: string;
}

const MIN_TEXT = 160;

/** 从整页文档中抽取正文。Readability 为主，失败时退化为块密度算法。 */
export function extractArticle(live: Document): Extracted | null {
  const meta = readPageMeta(live);

  // 1) Readability
  const clone = live.cloneNode(true) as Document;
  stampLiveImages(live, clone);
  // 先摘掉明显的广告/分享/推荐容器，减少 Readability 的误判
  pruneNoiseContainers(clone.body ?? clone.documentElement);
  let parsed: ReturnType<Readability['parse']> = null;
  try {
    const reader = new Readability(clone, { charThreshold: 180, keepClasses: true });
    parsed = reader.parse();
  } catch {
    parsed = null;
  }

  if (parsed?.content && (parsed.textContent ?? '').length >= MIN_TEXT) {
    const siteName = clean(parsed.siteName) || meta.siteName;
    return {
      html: parsed.content,
      title: stripSiteSuffix(clean(parsed.title) || meta.title, siteName),
      byline: sanitizePerson(clean(parsed.byline) || meta.byline),
      siteName,
      excerpt: clean(parsed.excerpt) || meta.excerpt,
      publishedTime: clean(parsed.publishedTime) || meta.published,
      method: 'readability',
      textLength: (parsed.textContent ?? '').length,
    };
  }

  // 2) 退化路径
  const clone2 = live.cloneNode(true) as Document;
  stampLiveImages(live, clone2);
  const fb = fallbackExtract(clone2);
  if (!fb) return null;
  return {
    html: fb.html,
    title: stripSiteSuffix(meta.title, meta.siteName),
    byline: meta.byline,
    siteName: meta.siteName,
    excerpt: meta.excerpt,
    publishedTime: meta.published,
    method: 'fallback',
    textLength: fb.textLength,
  };
}

/** 选区内容：保留用户选中的结构，标题沿用页面标题。 */
export function extractSelection(live: Document): Extracted | null {
  const sel = live.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const text = (sel.toString() || '').trim();
  if (text.length < 20) return null;

  const frag = range.cloneContents();
  const holder = live.createElement('div');
  holder.appendChild(frag);

  // 选区克隆与活 DOM 不同构，按 range 命中的图片顺序打标
  const liveImgs = Array.from(live.querySelectorAll('img')).filter((img) => {
    try {
      return range.intersectsNode(img);
    } catch {
      return false;
    }
  });
  const copyImgs = Array.from(holder.querySelectorAll('img'));
  const n = Math.min(liveImgs.length, copyImgs.length);
  for (let i = 0; i < n; i++) {
    const src = liveImgs[i] as HTMLImageElement;
    if (src.currentSrc && !src.currentSrc.startsWith('blob:')) {
      copyImgs[i].setAttribute('data-w2m-src', src.currentSrc);
    }
  }

  const meta = readPageMeta(live);
  return {
    html: holder.innerHTML,
    title: meta.title,
    byline: meta.byline,
    siteName: meta.siteName,
    excerpt: meta.excerpt,
    publishedTime: meta.published,
    method: 'readability',
    textLength: text.length,
  };
}

/** 页面上是否存在可用的文字选区。 */
export function hasTextSelection(live: Document): boolean {
  const sel = live.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  return (sel.toString() || '').trim().length >= 20;
}

export function readPageMeta(live: Document): PageMeta {
  const pick = (...selectors: string[]): string => {
    for (const s of selectors) {
      const el = live.querySelector<HTMLElement>(s);
      const v = el?.getAttribute('content') ?? el?.textContent ?? '';
      const t = clean(v);
      if (t) return t;
    }
    return '';
  };
  const url = live.location?.href ?? live.URL ?? '';
  let host = '';
  try {
    host = new URL(live.baseURI || url).hostname.replace(/^www\./, '');
  } catch {
    host = '';
  }
  const metaTitle = pick(
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'meta[name="title"]',
  );
  const docTitle = clean(live.title);
  const h1 = clean(
    (live.querySelector('article h1, main h1, [role="main"] h1, h1') as HTMLElement | null)
      ?.textContent ?? '',
  );
  let title = metaTitle || docTitle || h1;
  // 站点标题常带 "- 站点名" 后缀，而正文 H1 通常是干净标题
  if (h1 && h1.length >= 6 && h1.length <= title.length && title.startsWith(h1)) {
    title = h1;
  }

  return {
    title,
    byline: sanitizePerson(
      pick('meta[name="author"]', 'meta[property="article:author"]', '[rel="author"]'),
    ),
    siteName: pick('meta[property="og:site_name"]', 'meta[name="application-name"]') || host,
    excerpt: pick('meta[name="description"]', 'meta[property="og:description"]'),
    published: pick(
      'meta[property="article:published_time"]',
      'meta[name="date"]',
      'meta[name="pubdate"]',
      'time[datetime]',
    ),
  };
}

/** 站点常把页脚版权信息写进 author，过滤掉明显的机器字段。 */
function sanitizePerson(value: string): string {
  const v = clean(value);
  if (!v || v.length > 40) return '';
  if (/powered?\s*by|www\.|https?:\/\/|©|copyright|all rights reserved/i.test(v)) return '';
  return v;
}

/** "标题 - 站点名" → "标题" */
function stripSiteSuffix(title: string, siteName: string): string {
  const t = clean(title);
  const site = clean(siteName);
  if (!t || !site || t === site) return t;
  for (const sep of [' - ', ' | ', ' — ', ' – ', '｜', ' _ ', '-', '_']) {
    if (t.endsWith(sep + site)) return t.slice(0, -(sep.length + site.length)).trim();
  }
  return t;
}

function clean(v: unknown): string {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 块密度兜底：挑正文文本最多的容器（链接密度与段落数加权）。 */
function fallbackExtract(doc: Document): { html: string; textLength: number } | null {
  const body = doc.body;
  if (!body) return null;
  body.querySelectorAll('script,style,noscript,svg,canvas,iframe').forEach((n) => n.remove());

  const candidates = Array.from(
    body.querySelectorAll('article, main, [role="main"], section, div'),
  ).filter((el) => !el.closest('nav, aside, footer, header'));

  let best: Element | null = null;
  let bestScore = 0;
  for (const el of candidates) {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ');
    const len = text.length;
    if (len < MIN_TEXT) continue;
    const linkLen = Array.from(el.querySelectorAll('a')).reduce(
      (acc, a) => acc + (a.textContent ?? '').length,
      0,
    );
    const paragraphs = el.querySelectorAll('p').length;
    const density = 1 - Math.min(1, linkLen / Math.max(1, len));
    const score = len * density * (0.4 + Math.min(paragraphs, 40) / 40);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) return null;

  // 去掉外层导航残渣
  best.querySelectorAll('nav,aside,footer,script,style,noscript,form').forEach((n) => n.remove());
  const textLength = (best.textContent ?? '').replace(/\s+/g, ' ').trim().length;
  if (textLength < MIN_TEXT) return null;
  return { html: best.outerHTML, textLength };
}
