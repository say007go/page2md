import { absoluteUrl, isTinyImage, pickImageSource } from './urls';

/**
 * 正文清洗：在 Readability 已筛出正文的基础上，再去掉残留的
 * 分享条 / 广告位 / 相关推荐 / 评论区 / 面包屑 / 翻页器 等噪声。
 */

const ALWAYS_REMOVE = [
  'script',
  'style',
  'noscript',
  'template',
  'link',
  'meta',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'nav',
  'footer',
  'aside',
  'dialog',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[role="search"]',
  '[aria-hidden="true"]',
  '[hidden]',
  '[style*="display:none"]',
  '[style*="display: none"]',
  '[style*="visibility:hidden"]',
  '[style*="visibility: hidden"]',
];

const JUNK_RE =
  /(?:^|[\s_-])(?:ads?|adv|adbox|adslot|advert|advertisement|sponsor|sponsored|promo|promotion|share|sharing|sharebar|share_bar|social|socials|related|recommend|recommendation|newsletter|subscribe|subscription|cookie|consent|sidebar|pagination|pager|breadcrumb|modal|popup|popover|toolbar|comment|comments|disqus|backtop|download-app|qrcode)(?:[\s_-]|$)/i;

const RELATED_HEADING =
  /^(?:相关(?:阅读|推荐|文章|链接|新闻|内容|专题|视频)|推荐(?:阅读|内容|文章|新闻|资讯)?|猜你喜欢|热门(?:推荐|文章|阅读|内容|标签|专题)?|延伸阅读|更多(?:阅读|推荐|文章|内容)|为您推荐|相关推荐|相关热文|精彩推荐|编辑推荐)\s*[:：]?$/;

const CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'ASIDE', 'NAV', 'FOOTER', 'HEADER', 'UL', 'OL', 'FORM', 'TABLE']);

export function cleanArticle(root: Element, baseUrl: string): void {
  for (const selector of ALWAYS_REMOVE) {
    root.querySelectorAll(selector).forEach((el) => {
      if (el === root) return;
      el.remove();
    });
  }

  pruneNoiseContainers(root);
  removeRelatedSections(root);
  removeLinkFarms(root);
  removeSocialLines(root);
  removeMetaLines(root);
  normalizeLinks(root, baseUrl);
  dropBrokenImages(root, baseUrl);
  vacuum(root);
}

/**
 * 用正文里的大标题修正页面标题：很多站点的 <title> 会带 "- 站点名" 后缀，
 * 而正文 H1/H2 通常是干净标题。
 */
export function refineTitleFromContent(root: Element, title: string): string {
  const normalized = normalizeSpace(title);
  if (!normalized) return title;
  for (const heading of Array.from(root.querySelectorAll('h1, h2, h3, h4'))) {
    const text = normalizeSpace(heading.textContent ?? '');
    if (!text || text.length < 8) continue;
    if (text === normalized) return text;
    if (normalized.startsWith(text) && text.length >= normalized.length * 0.5) return text;
  }
  return title;
}

/**
 * 找出正文里代表「文章标题」的标题节点。
 * Readability 常把 h1 降级成 h2，这里统一提升为 h1；返回是否已存在标题。
 */
export function ensureTitleHeading(root: Element, title: string): boolean {
  if (root.querySelector('h1')) return true;
  const normalized = normalizeSpace(title);
  if (!normalized) return false;

  const headings = Array.from(root.querySelectorAll('h2, h3, h4'));
  const match = headings.find((h) => {
    const text = normalizeSpace(h.textContent ?? '');
    if (!text) return false;
    return text === normalized || (text.length > 4 && (text.includes(normalized) || normalized.includes(text)));
  });
  if (!match) return false;

  const heading = root.ownerDocument.createElement('h1');
  heading.innerHTML = match.innerHTML;
  match.replaceWith(heading);
  return true;
}

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function linkDensity(el: Element): number {
  const len = textOf(el).length;
  if (len === 0) return 1;
  const linkLen = Array.from(el.querySelectorAll('a')).reduce(
    (acc, a) => acc + (a.textContent ?? '').trim().length,
    0,
  );
  return linkLen / len;
}

/** 类名/ID 命中广告、分享、推荐等特征的容器（提取前也会在原始 DOM 上跑一遍）。 */
export function pruneNoiseContainers(root: Element): void {
  const candidates = Array.from(root.querySelectorAll('*'));
  for (const el of candidates) {
    if (!CONTAINER_TAGS.has(el.tagName)) continue;
    const sig = `${el.id} ${el.className} ${el.getAttribute('role') ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
    if (!JUNK_RE.test(sig)) continue;
    if (el.querySelector('h1')) continue; // 可能是正文标题容器
    const len = textOf(el).length;
    const density = linkDensity(el);
    if (len < 1200 || density > 0.5 || el.querySelectorAll('a').length >= 4) {
      el.remove();
    }
  }
}

/** 「相关阅读 / 猜你喜欢」标题 + 其后的兄弟节点。 */
function removeRelatedSections(root: Element): void {
  const headings = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,strong,b,div,span')).filter(
    (el) => {
      const t = textOf(el);
      if (!t || t.length > 24) return false;
      if (!RELATED_HEADING.test(t)) return false;
      // 只接受「独占一行的小标题」，避免误伤正文句子
      return el.children.length === 0 || el.tagName.startsWith('H');
    },
  );

  for (const h of headings) {
    if (!h.parentNode) continue;
    const level = h.tagName.startsWith('H') ? Number(h.tagName[1]) : 6;
    let cursor: Element | null = h.nextElementSibling;
    let removed = 0;
    while (cursor && removed < 10) {
      const next: Element | null = cursor.nextElementSibling;
      const isHeading = /^H[1-6]$/.test(cursor.tagName);
      if (isHeading && Number(cursor.tagName[1]) <= level) break;
      cursor.remove();
      removed++;
      cursor = next;
    }
    h.remove();
  }
}

const SOCIAL_START =
  /^(?:分享(?:到|至|给)?|点击分享|一键分享|扫码分享|分享本文|微信扫一扫|扫一扫|复制链接|收藏(?:本)?文(?:章)?|点赞|在看|点个在看|阅读原文|返回顶部|回到顶部|上一篇|下一篇)\s*[:：]?/;
const SOCIAL_HIT = /分享到|分享至|朋友圈|微博|QQ空间|社交平台/g;

/** 残留的分享条：Readability 会把 div 重构成 p 并丢掉 class，只能按文案兜底。 */
function removeSocialLines(root: Element): void {
  for (const el of Array.from(root.querySelectorAll('p,div,span,section'))) {
    if (!el.parentNode) continue;
    const text = textOf(el);
    if (!text || text.length > 100) continue;
    if (el.querySelector('img,table,pre,blockquote')) continue;
    if (SOCIAL_START.test(text)) {
      el.remove();
      continue;
    }
    if (text.length < 60 && (text.match(SOCIAL_HIT)?.length ?? 0) >= 2) el.remove();
  }
}

/** 阅读量 / 日期 / 编辑署名之类的元信息行（作者已写入 front matter）。 */
function removeMetaLines(root: Element): void {
  const CREDIT =
    /^(?:供稿|供稿人|编辑|责任编辑|责编|审核|校对|来源|作者|摄影|排版|美编|监制|签发|编发)\s*[:：]/;
  for (const el of Array.from(root.querySelectorAll('p,div,span'))) {
    if (!el.parentNode) continue;
    const text = textOf(el);
    if (!text || text.length > 60) continue;
    if (el.querySelector('img,a,table,pre')) continue;
    if (/[。！？!?；;]/.test(text)) continue;
    if (CREDIT.test(text)) {
      el.remove();
      continue;
    }
    const hasDate = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(text);
    const hasCount = /(?:阅读|浏览|点击|点赞|收藏)\s*[:：]?\s*[\d,.]+\s*万?/.test(text);
    if (hasDate || hasCount) el.remove();
  }
}

/** 链接农场：链接密度极高、文本很短的小区块（推荐位 / 标签云 / 目录）。 */
function removeLinkFarms(root: Element): void {
  for (const el of Array.from(root.querySelectorAll('div,section,ul,ol,table'))) {
    if (!el.parentNode) continue;
    const links = el.querySelectorAll('a');
    if (links.length < 4) continue;
    const len = textOf(el).length;
    if (len === 0 || len > 800) continue;
    if (el.querySelector('p') || el.querySelector('img')) continue;
    if (linkDensity(el) > 0.7) el.remove();
  }
}

function normalizeLinks(root: Element, baseUrl: string): void {
  for (const a of Array.from(root.querySelectorAll('a'))) {
    const href = a.getAttribute('href');
    if (!href || /^\s*javascript:/i.test(href)) {
      a.removeAttribute('href');
      continue;
    }
    const abs = absoluteUrl(href, baseUrl);
    if (abs) a.setAttribute('href', abs);
    else a.removeAttribute('href');
  }
}

/** 去掉追踪像素、无源图片。 */
function dropBrokenImages(root: Element, baseUrl: string): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = pickImageSource(img, baseUrl);
    if (!src || isTinyImage(img, src)) {
      img.remove();
      continue;
    }
  }
}

/** 清掉空容器（多轮，处理嵌套）。 */
function vacuum(root: Element): void {
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const el of Array.from(root.querySelectorAll('div,section,span,figure,p'))) {
      if (!el.parentNode) continue;
      if (el.querySelector('img,iframe,video,audio,table,hr,br')) continue;
      if (textOf(el).length > 0) continue;
      el.remove();
      changed = true;
    }
    if (!changed) break;
  }
}
