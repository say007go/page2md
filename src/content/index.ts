import { cleanArticle, ensureTitleHeading, refineTitleFromContent } from '../lib/clean';
import { extractArticle, extractSelection, hasTextSelection, type Extracted } from '../lib/extract';
import { htmlToMarkdown } from '../lib/markdown';
import {
  buildFrontMatter,
  countWords,
  datePrefix,
  formatBytes,
  localIso,
  safeFilename,
} from '../lib/text';
import type {
  AnalyzeResult,
  BuildOptions,
  BuildResult,
  BuildStats,
  ProgressEvent,
  SaveMode,
  Stage,
} from '../lib/types';
import { collectImages, embedImages, type ImageItem } from './images';
import { Toast } from './toast';

(() => {
  const flagged = window as unknown as Record<string, unknown>;
  if (flagged.__w2mContentLoaded) return;
  flagged.__w2mContentLoaded = true;

  let running = false;
  const ports = new Set<chrome.runtime.Port>();

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'w2m-progress') return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.__w2m !== true) return undefined;

    switch (message.type) {
      case 'PING':
        sendResponse({ ok: true, loaded: true });
        return undefined;
      case 'ANALYZE':
        try {
          sendResponse(analyze());
        } catch (error) {
          sendResponse({ ok: false, error: describe(error) });
        }
        return undefined;
      case 'BUILD': {
        const opts = message.payload as BuildOptions;
        runBuild(opts)
          .then(sendResponse)
          .catch((error) => sendResponse({ ok: false, error: describe(error) }));
        return true;
      }
      default:
        return undefined;
    }
  });

  // ---------------- 分析 ----------------

  function analyze(): AnalyzeResult {
    try {
      const prepared = prepare('page', (stage) => {
        void stage;
      });
      if (!prepared) return { ok: false, error: '未识别到正文，试试选中正文后保存。' };
      return {
        ok: true,
        title: prepared.title,
        site: prepared.extracted.siteName || hostOf(),
        chars: prepared.extracted.textLength,
        images: prepared.items.length,
        hasSelection: hasTextSelection(document),
      };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  }

  // ---------------- 主流程 ----------------

  interface Prepared {
    root: Element;
    items: ImageItem[];
    extracted: Extracted;
    title: string;
    hasTitleHeading: boolean;
  }

  function prepare(mode: SaveMode, onStage: (stage: Stage, message: string) => void): Prepared | null {
    onStage('extract', mode === 'selection' ? '正在提取选中内容…' : '正在识别页面正文…');
    // 选区失效（例如右键菜单打开后选区被清空）时自动退回整页
    const selection = mode === 'selection' ? extractSelection(document) : null;
    const usedSelection = Boolean(selection);
    const extracted = selection ?? extractArticle(document);
    if (!extracted) return null;

    onStage('clean', '正在清除导航、广告、推荐位…');
    const parsed = new DOMParser().parseFromString(
      '<!doctype html><html><body><div id="w2m-root"></div></body></html>',
      'text/html',
    );
    const root = parsed.getElementById('w2m-root');
    if (!root) return null;
    root.innerHTML = extracted.html;

    cleanArticle(root, document.baseURI || location.href);

    const { items } = collectImages(root, document.baseURI || location.href);
    const rawTitle = (extracted.title || document.title || '').trim() || '未命名页面';
    const refined = refineTitleFromContent(root, rawTitle);
    // 摘录文件单独命名，避免与整页保存重名
    const title = usedSelection ? `${refined}（摘录）` : refined;
    const hasTitleHeading = ensureTitleHeading(root, title);

    return { root, items, extracted, title, hasTitleHeading };
  }

  async function runBuild(opts: BuildOptions): Promise<BuildResult> {
    if (running) return { ok: false, error: '上一个保存任务还在进行中，请稍候。' };
    running = true;
    const started = performance.now();
    const toast = opts.toast ? new Toast() : null;

    const emit = (event: ProgressEvent) => {
      for (const port of ports) {
        try {
          port.postMessage(event);
        } catch {
          ports.delete(port);
        }
      }
      if (toast) {
        toast.set(event.message, event.total ? `${event.done ?? 0} / ${event.total}` : '');
        if (event.stage === 'images') toast.setProgress(event.done ?? 0, event.total);
      }
    };

    try {
      const tExtract = performance.now();
      const prepared = prepare(opts.mode, (stage, message) =>
        emit({ type: 'progress', stage, message }),
      );
      if (!prepared) {
        toast?.error('没能识别出正文');
        return {
          ok: false,
          error: '没有识别出正文。可以先选中正文，再用「仅保存当前选中的内容」重试。',
        };
      }

      const { root, items, extracted, title, hasTitleHeading } = prepared;
      const tImages = performance.now();

      // 图片：抓取 + Base64
      let embedded = new Map<number, string>();
      const embeddedIds = new Set<number>();
      const failedIds = new Set<number>();
      const itemById = new Map(items.map((item) => [item.id, item] as const));

      if (opts.embedImages && items.length) {
        const fetchable = items.filter((i) => !i.inline).length;
        emit({
          type: 'progress',
          stage: 'images',
          message: fetchable ? '正在抓取图片…' : '正在整理内联图片…',
          done: 0,
          total: fetchable,
        });
        embedded = await embedImages(
          items,
          {
            compressImages: opts.compressImages,
            maxEdge: opts.maxEdge,
            quality: opts.quality,
          },
          (done, total) =>
            emit({
              type: 'progress',
              stage: 'images',
              message: `正在嵌入图片 ${done}/${total}`,
              done,
              total,
            }),
        );
      }

      emit({ type: 'progress', stage: 'markdown', message: '正在转换为 Markdown…' });
      const tMarkdown = performance.now();
      let markdown = htmlToMarkdown(root.innerHTML, { embedImages: opts.embedImages });
      // 字数必须在回填 Base64 之前统计，否则图片数据会被当成英文单词
      const plainText = markdown.replace(/\{\{W2M_IMG_\d+\}\}/g, '');
      const words = countWords(plainText);

      if (opts.embedImages) {
        markdown = markdown.replace(/\{\{W2M_IMG_(\d+)\}\}/g, (whole: string, idText: string) => {
          const id = Number(idText);
          const dataUrl = embedded.get(id);
          if (dataUrl) {
            embeddedIds.add(id);
            return safeUrl(dataUrl);
          }
          failedIds.add(id);
          const item = itemById.get(id);
          return item ? safeUrl(item.url) : whole;
        });
      }
      markdown = markdown.trim();

      const now = new Date();
      const frontMatter = opts.includeMeta
        ? buildFrontMatter({
            title,
            source: canonicalUrl(),
            author: extracted.byline,
            published: extracted.publishedTime,
            site: extracted.siteName,
            saved: localIso(now),
            words,
            images: items.length,
          })
        : '';

      const heading = hasTitleHeading ? '' : `# ${title}\n\n`;
      const documentText = `${frontMatter}${heading}${markdown}\n`;
      const bytes = new Blob([documentText]).size;
      const filename = `${opts.datePrefix ? `${datePrefix(now)}-` : ''}${safeFilename(title)}.md`;

      // 复制模式要把全文通过消息通道送回弹窗，超大文件会撞上消息体积上限
      if (opts.action === 'copy' && documentText.length > 20_000_000) {
        toast?.error('文件过大，请直接保存');
        return {
          ok: false,
          error: '内容超过 20MB（图片较多），请改用「保存 .md」直接写入文件。',
        };
      }

      if (opts.action === 'download') {
        emit({ type: 'progress', stage: 'download', message: '正在保存文件…' });
        downloadText(filename, documentText);
      }

      const stats: BuildStats = {
        title,
        filename,
        chars: documentText.length,
        words,
        images: items.length,
        imagesEmbedded: embeddedIds.size,
        imagesFailed: failedIds.size,
        bytes,
        method: extracted.method,
        elapsedMs: Math.round(performance.now() - started),
        timings: {
          extract: Math.round(tImages - tExtract),
          images: Math.round(tMarkdown - tImages),
          markdown: Math.round(performance.now() - tMarkdown),
        },
      };

      emit({ type: 'progress', stage: 'done', message: '完成' });
      if (toast) {
        const imgNote =
          items.length === 0
            ? '无图片'
            : failedIds.size
              ? `${embeddedIds.size}/${items.length} 张图片已内嵌`
              : `${items.length} 张图片已内嵌`;
        toast.success(`已保存 ${filename}`, `${imgNote} · ${formatBytes(bytes)}`);
      }

      return {
        ok: true,
        stats,
        markdown: opts.action === 'copy' ? documentText : undefined,
      };    } catch (error) {
      toast?.error(describe(error));
      return { ok: false, error: describe(error) };
    } finally {
      running = false;
    }
  }

  function downloadText(filename: string, text: string): void {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    link.style.display = 'none';
    (document.body || document.documentElement).appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /** dataURI 里的括号会破坏 Markdown 链接语法；普通 URL 里有括号/空格时用尖括号包裹。 */
  function safeUrl(url: string): string {
    if (url.startsWith('data:')) return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
    if (/[()\s]/.test(url)) return `<${url.replace(/>/g, '%3E')}>`;
    return url;
  }

  /** 优先使用 canonical 地址，避免把跟踪参数写进 front matter。 */
  function canonicalUrl(): string {
    const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const href = link?.href?.trim() ?? '';
    return /^https?:/i.test(href) ? href : location.href;
  }

  function hostOf(): string {
    try {
      return new URL(location.href).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function describe(error: unknown): string {
    if (error instanceof Error) return error.message || '未知错误';
    return String(error) || '未知错误';
  }
})();
