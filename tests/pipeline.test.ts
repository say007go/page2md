import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { extractArticle, extractSelection } from '../src/lib/extract';
import { cleanArticle, ensureTitleHeading } from '../src/lib/clean';
import { htmlToMarkdown } from '../src/lib/markdown';
import { collectImages } from '../src/content/images';
import { bestSrcsetUrl, pickImageSource } from '../src/lib/urls';
import { buildFrontMatter, countWords, safeFilename } from '../src/lib/text';

const BASE = 'https://www.quantum-edu.cn/blog/five-actions';
const html = readFileSync(resolve(process.cwd(), 'tests/fixtures/article.html'), 'utf8');

function loadPage(): Document {
  return new JSDOM(html, { url: BASE }).window.document;
}

function pipeline(source = html, url = BASE) {
  const doc = new JSDOM(source, { url }).window.document;
  const extracted = extractArticle(doc);
  expect(extracted).not.toBeNull();
  if (!extracted) throw new Error('extract failed');

  const host = doc.createElement('div');
  host.innerHTML = extracted.html;
  cleanArticle(host, url);
  const { items } = collectImages(host, url);
  const hasTitle = ensureTitleHeading(host, extracted.title);
  const markdown = htmlToMarkdown(host.innerHTML, { embedImages: true });
  return { extracted, items, markdown, host, hasTitle };
}

describe('正文提取', () => {
  it('拿到标题与元信息', () => {
    const doc = loadPage();
    const extracted = extractArticle(doc);
    expect(extracted).not.toBeNull();
    expect(extracted?.method).toBe('readability');
    expect(extracted?.title).toContain('企业人才培养的五个关键动作');
    expect(extracted?.byline).toContain('圣婴');
    expect(extracted?.textLength).toBeGreaterThan(400);
  });

  it('去掉导航、广告、分享条、相关推荐、评论与页脚', () => {
    const { markdown } = pipeline();
    for (const noise of ['限时钜惠', '登录 / 注册', '分享到微信', '相关阅读', '热门文章', '京ICP备', '报名从速']) {
      expect(markdown).not.toContain(noise);
    }
  });

  it('保留正文结构：标题、列表、引用、代码、表格', () => {
    const { markdown } = pipeline();
    expect(markdown).toContain('## 一、从岗位能力出发');
    expect(markdown).toMatch(/-\s+线上：知识输入与测评/);
    expect(markdown).toContain('> 培养项目不是把课排满');
    expect(markdown).toContain('```js');
    expect(markdown).toContain('| 阶段 | 关键动作 | 产出 |');
    expect(markdown).toContain('| 诊断 | 业务访谈 + 能力测评 | 能力差距清单 |');
  });

  it('标题被提升为一级标题，不会重复生成', () => {
    const { markdown, hasTitle } = pipeline();
    expect(hasTitle).toBe(true);
    expect(markdown.startsWith('# 企业人才培养的五个关键动作')).toBe(true);
    expect(markdown.match(/^# /gm)).toHaveLength(1);
  });

  it('正文图片进入占位符，追踪像素被剔除', () => {
    const { items, markdown } = pipeline();
    expect(items.map((i) => i.url)).toEqual([
      'https://img.example.com/cover-capability.jpg',
      'https://img.example.com/blend-large.jpg',
    ]);
    expect(markdown).toContain('![岗位能力模型示意]({{W2M_IMG_0}})');
    expect(markdown).toContain('![混合式学习路径]({{W2M_IMG_1}})');
    expect(markdown.match(/\{\{W2M_IMG_/g)).toHaveLength(2);
    expect(markdown).not.toContain('lazy-placeholder');
  });

  it('未做内嵌时输出绝对地址', () => {
    const doc = new JSDOM(html, { url: BASE }).window.document;
    const extracted = extractArticle(doc)!;
    const host = doc.createElement('div');
    host.innerHTML = extracted.html;
    cleanArticle(host, BASE);
    collectImages(host, BASE);
    const markdown = htmlToMarkdown(host.innerHTML, { embedImages: false });
    expect(markdown).toContain('![岗位能力模型示意](https://img.example.com/cover-capability.jpg)');
  });
});

describe('图片地址解析', () => {
  it('srcset 取最大宽度', () => {
    expect(bestSrcsetUrl('a.jpg 480w, b.jpg 1200w, c.jpg 800w', BASE)).toBe(
      'https://www.quantum-edu.cn/blog/b.jpg',
    );
    expect(bestSrcsetUrl('a.jpg 1x, b.jpg 2x', BASE)).toBe(
      'https://www.quantum-edu.cn/blog/b.jpg',
    );
  });

  it('懒加载占位图回退到 data-src', () => {
    const doc = loadPage();
    const img = doc.querySelector('figure img')!;
    expect(pickImageSource(img, BASE)).toBe('https://img.example.com/cover-capability.jpg');
  });

  it('优先使用页面实际加载的图片（打标）', () => {
    const doc = loadPage();
    const host = doc.createElement('div');
    host.innerHTML = '<img src="https://img.example.com/thumb.jpg" data-w2m-src="https://img.example.com/full.jpg" />';
    const img = host.querySelector('img')!;
    expect(pickImageSource(img, BASE)).toBe('https://img.example.com/full.jpg');
  });

  it('相对地址与协议相对地址', () => {
    const doc = loadPage();
    const host = doc.createElement('div');
    host.innerHTML = '<img src="/a/b.png" /><img src="//cdn.example.com/c.png" />';
    const imgs = host.querySelectorAll('img');
    expect(pickImageSource(imgs[0], BASE)).toBe('https://www.quantum-edu.cn/a/b.png');
    expect(pickImageSource(imgs[1], BASE)).toBe('https://cdn.example.com/c.png');
  });
});

describe('Markdown 细节', () => {
  it('代码里的反引号不会破坏围栏', () => {
    const doc = loadPage();
    const host = doc.createElement('div');
    host.innerHTML = '<pre><code class="language-md">```js\nconsole.log(1)\n```</code></pre>';
    const markdown = htmlToMarkdown(host.innerHTML, { embedImages: true });
    expect(markdown).toContain('````md');
  });

  it('空标题/空段落不产生垃圾行', () => {
    const doc = loadPage();
    const host = doc.createElement('div');
    host.innerHTML = '<p>第一段</p><p>&nbsp;</p><p></p><p>第二段</p>';
    const markdown = htmlToMarkdown(host.innerHTML, { embedImages: true });
    expect(markdown.trim()).toBe('第一段\n\n第二段');
  });

  it('段落中的链接与强调保留', () => {
    const doc = loadPage();
    const host = doc.createElement('div');
    host.innerHTML = '<p>查看<a href="https://example.com/x">这个链接</a>，<strong>重点</strong>。</p>';
    const markdown = htmlToMarkdown(host.innerHTML, { embedImages: true });
    expect(markdown).toContain('[这个链接](https://example.com/x)');
    expect(markdown).toContain('**重点**');
  });
});

describe('选区提取', () => {
  it('可以把选中的段落转成 Markdown', () => {
    const doc = loadPage();
    const target = doc.querySelectorAll('article > p')[1];
    const range = doc.createRange();
    range.selectNodeContents(target);
    const selection = doc.getSelection() || (doc.defaultView as Window).getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const extracted = extractSelection(doc);
    expect(extracted).not.toBeNull();
    expect(extracted?.textLength).toBeGreaterThan(20);
    const host = doc.createElement('div');
    host.innerHTML = extracted!.html;
    cleanArticle(host, BASE);
    const markdown = htmlToMarkdown(host.innerHTML, { embedImages: true });
    expect(markdown.length).toBeGreaterThan(20);
  });
});

describe('文本工具', () => {
  it('中英混排字数统计', () => {
    expect(countWords('企业人才培养 five key actions')).toBe(9);
  });

  it('文件名清洗', () => {
    expect(safeFilename('  A/B: C? "D" | E  ')).toBe('A B C D E');
    expect(safeFilename('')).toBe('未命名页面');
  });

  it('front matter 合法且只输出非空字段', () => {
    const fm = buildFrontMatter({
      title: '标题: 带冒号',
      source: 'https://a.com/x',
      author: '',
      words: 12,
    });
    expect(fm).toBe(
      '---\ntitle: "标题: 带冒号"\nsource: "https://a.com/x"\nwords: 12\n---\n\n',
    );
  });
});
