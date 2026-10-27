import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

/** 图片占位符：先转义为 Markdown 再回填 Base64，避免把几 MB 字符串塞进 DOM 属性。 */
export const IMG_TOKEN = (id: string | number) => `{{W2M_IMG_${id}}}`;
export const IMG_TOKEN_RE = /\{\{W2M_IMG_(\d+)\}\}/g;

export interface MarkdownOptions {
  /** true：图片输出占位符，稍后回填 dataURI；false：直接输出绝对地址 */
  embedImages: boolean;
}

export function createTurndown(options: MarkdownOptions): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    linkReferenceStyle: 'full',
    br: '  ',
    blankReplacement: (_content: string, node: Node) =>
      (node as Element & { isBlock?: boolean }).isBlock ? '\n\n' : '',
  });

  service.use(gfm);

  // 代码块：带语言标注
  service.addRule('w2mFencedCode', {
    filter: 'pre',
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const codeEl = el.querySelector('code') ?? el;
      const text = (codeEl.textContent ?? '').replace(/\n+$/, '');
      if (!text.trim()) return '';
      const language = detectLanguage(el, codeEl);
      const longest = Math.max(0, ...(text.match(/`{3,}/g) ?? []).map((m) => m.length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
    },
  });

  // 图片：正文图统一输出占位符或绝对地址
  service.addRule('w2mImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as HTMLImageElement;
      const alt = (el.getAttribute('alt') ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[[\]]/g, (m) => `\\${m}`);
      const id = el.getAttribute('data-w2m-id');
      const src = (el.getAttribute('src') ?? '').trim();
      if (id != null && options.embedImages) {
        return `![${alt}](${IMG_TOKEN(id)})`;
      }
      if (!src) return '';
      return `![${alt}](${src})`;
    },
  });

  // 视频 / 嵌入内容：降级为链接，避免整段丢失
  service.addRule('w2mMedia', {
    filter: ['iframe', 'video', 'audio'],
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const src =
        el.getAttribute('src') ??
        el.querySelector('source')?.getAttribute('src') ??
        el.querySelector('source')?.getAttribute('srcset') ??
        '';
      if (!src) return '';
      const label =
        node.nodeName === 'VIDEO' ? '视频' : node.nodeName === 'AUDIO' ? '音频' : '嵌入内容';
      return `\n\n[▶ ${label}](${src})\n\n`;
    },
  });

  // KaTeX：还原成 $TeX$，否则一堆重复的无意义字形
  service.addRule('w2mKatex', {
    filter: (node) =>
      node.nodeType === 1 &&
      (node as Element).classList?.contains('katex') &&
      !(node as Element).classList?.contains('katex-html'),
    replacement: (_content, node) => {
      const el = node as Element;
      const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? '';
      if (!tex.trim()) return el.textContent ?? '';
      const display = el.closest('.katex-display') !== null;
      return display ? `\n\n$$${tex.trim()}$$\n\n` : `$${tex.trim()}$`;
    },
  });

  // 图注：斜体，单独成段
  service.addRule('w2mFigcaption', {
    filter: 'figcaption',
    replacement: (content) => {
      const text = content.replace(/\s+/g, ' ').trim();
      return text ? `\n\n*${text}*\n\n` : '';
    },
  });

  // 空链接保留地址，避免信息丢失（只处理纯文本为空的链接，图片链接不动）
  service.addRule('w2mEmptyLink', {
    filter: (node) =>
      node.nodeName === 'A' &&
      !(node.textContent ?? '').trim() &&
      !(node as Element).firstElementChild,
    replacement: (_content, node) => {
      const href = (node as HTMLAnchorElement).getAttribute('href');
      return href ? `[${href}](${href})` : '';
    },
  });

  return service;
}

function detectLanguage(pre: Element, code: Element): string {
  const sig = `${code.getAttribute('class') ?? ''} ${pre.getAttribute('class') ?? ''}`;
  const m = /(?:language|lang|highlight-source)-([\w+#.-]+)/i.exec(sig);
  return m ? m[1].toLowerCase() : '';
}

/** HTML 片段 → Markdown 文本（图片仍是占位符）。 */
export function htmlToMarkdown(html: string, options: MarkdownOptions): string {
  const service = createTurndown(options);
  return tidy(service.turndown(html));
}

export function tidy(markdown: string): string {
  return markdown
    .replace(/\u00a0/g, ' ')
    .replace(/^[ \t]*(?:&nbsp;)?[ \t]*$/gm, '')
    // Turndown 的列表标记是 "-   "（3 空格），中文排版下收成 "- "
    .replace(/^(\s*)([-*+])\s{3}/gm, '$1$2 ')
    .replace(/^(\s*)(\d+)\.\s{2}/gm, '$1$2. ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}
