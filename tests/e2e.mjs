/**
 * 端到端测试：在真实 Chromium 里加载扩展，走一遍
 * 「页面 → 正文提取 → 跨域抓图 → Base64 内嵌 → 下载 .md」的完整链路。
 *
 * 运行：npm run build && node tests/e2e.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const SITE = path.join(ROOT, 'tests', 'site');
const TMP = path.join(ROOT, 'tests', '.tmp');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function staticServer(root, { replace, cors } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/article.html';
    const file = path.join(root, pathname);
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      let data = await fs.readFile(file);
      const ext = path.extname(file).toLowerCase();
      // 只对 HTML 做占位符替换；二进制文件绝不能被当作文本处理
      if (replace && ext === '.html') data = Buffer.from(replace(data.toString('utf8')));
      const headers = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' };
      if (cors) headers['Access-Control-Allow-Origin'] = '*';
      res.writeHead(200, headers).end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    }
  });
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const log = (...args) => console.log('·', ...args);
const ok = (...args) => console.log('✓', ...args);

async function main() {
  await fs.mkdir(TMP, { recursive: true });
  log('构建扩展…');
  execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });

  // 图片服务（不同源、无 CORS 头）与页面服务
  const imgServer = staticServer(path.join(SITE, 'images'), { cors: false });
  const imgPort = await listen(imgServer);
  const imgOrigin = `http://127.0.0.1:${imgPort}`;

  const pageServer = staticServer(SITE, {
    replace: (html) => html.replace(/\{\{IMG\}\}/g, imgOrigin),
  });
  const pagePort = await listen(pageServer);
  const pageUrl = `http://127.0.0.1:${pagePort}/article.html`;
  log('测试页', pageUrl, '| 图片站', imgOrigin);

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'w2m-e2e-'));
  let context;
  try {
    const bundled = chromium.executablePath();
    const channel = fsSync.existsSync(bundled) ? 'chromium' : 'msedge';
    log('浏览器通道', channel);
    context = await chromium.launchPersistentContext(userDataDir, {
      channel,
      headless: true,
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(sw.url()).host;
    ok('扩展已加载，id =', extensionId);
    assert.equal(sw.url(), `chrome-extension://${extensionId}/background.js`);

    const swErrors = [];
    sw.on('console', (msg) => {
      if (msg.text().includes('[w2m-debug]')) console.log('   SW:', msg.text().slice(0, 160));
      if (msg.type() === 'error') swErrors.push(msg.text());
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (msg) => {
      if (msg.text().includes('[w2m-debug-item]')) console.log('   PAGE:', msg.text().slice(0, 160));
    });
    await page.goto(pageUrl, { waitUntil: 'load' });
    assert.equal(await page.title(), '端到端测试：图片内嵌验证 - 测试站');

    const tabId = await sw.evaluate(async (target) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url === target)?.id ?? -1;
    }, pageUrl);
    assert.ok(tabId > 0, '找不到测试标签页');

    const payload = {
      embedImages: true,
      compressImages: false,
      maxEdge: 1600,
      quality: 0.85,
      includeMeta: true,
      datePrefix: false,
      mode: 'page',
      action: 'copy',
      toast: false,
    };

    log('触发 BUILD（copy 模式）…');
    const result = await sw.evaluate(
      async ({ tabId, payload }) => {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        return await chrome.tabs.sendMessage(tabId, { __w2m: true, type: 'BUILD', payload });
      },
      { tabId, payload },
    );

    assert.ok(result?.ok, `BUILD 失败：${result?.error}`);
    const md = result.markdown;
    const stats = result.stats;
    await fs.writeFile(path.join(TMP, 'result.md'), md, 'utf8');
    log('生成', stats.filename, '|', stats.bytes, 'bytes |', stats.words, '字 |', stats.images, '图');

    // ---- 结构断言 ----
    assert.match(md, /^---\ntitle: "端到端测试：图片内嵌验证"/);
    assert.match(md, new RegExp(`source: "${pageUrl.replace(/[.]/g, '\\.')}"`));
    assert.match(md, /\nsaved: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}"/);
    assert.match(md, /# 端到端测试：图片内嵌验证/);
    assert.match(md, /\|\s*能力\s*\|\s*状态\s*\|/);
    assert.match(md, /```bash\nnpm run build && echo ok\n```/);
    assert.match(md, /> 好的转换器不是把网页拍扁/);
    assert.match(md, /- 图片：Base64 内嵌/);

    // ---- 噪声断言（只看正文，front matter 里的 author 是合法字段）----
    const body = md.replace(/^---\n[\s\S]*?\n---\n\n/, '');
    for (const noise of [
      '广告位',
      '分享到微信',
      '相关阅读',
      '热门推荐',
      '网友 A',
      '页脚信息',
      '限时课程优惠',
      '首页',
      '测试作者',
    ]) {
      assert.ok(!body.includes(noise), `正文里不应出现噪声：${noise}`);
    }

    // ---- 图片内嵌断言 ----
    const dataUris = md.match(/data:image\/[a-z+]+;base64,/g) ?? [];
    assert.equal(stats.images, 5, `图片数应为 5，实际 ${stats.images}`);
    assert.equal(stats.imagesEmbedded, 4, `内嵌数应为 4，实际 ${stats.imagesEmbedded}`);
    assert.equal(stats.imagesFailed, 1, `失败数应为 1，实际 ${stats.imagesFailed}`);
    assert.equal(dataUris.length, 4, `data URI 数量应为 4，实际 ${dataUris.length}`);
    assert.ok(!md.includes('{{W2M_IMG'), '占位符没有被替换');
    assert.ok(!md.includes(`${imgOrigin}/cover.png`), '跨域图片仍是链接');
    assert.ok(!md.includes(`${imgOrigin}/pixel.gif`), '追踪像素没有剔除');
    assert.match(md, /!\[缺失的图片\]\(http:\/\/127\.0\.0\.1:\d+\/images\/missing\.png\)/);
    assert.ok(!md.includes('/images/small.png'), 'srcset 应取最大图而不是 small');
    assert.match(md, /data:image\/png;base64,[A-Za-z0-9+/=]{40,}/);

    // 图片字节确实能被解码回 PNG
    const b64 = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(md)[1];
    const buf = Buffer.from(b64, 'base64');
    assert.equal(buf.subarray(1, 4).toString(), 'PNG');
    assert.ok(buf.length > 100, 'PNG 数据过小');

    // ---- 选区模式 ----
    log('选中一段文字并只保存选区…');
    await page.evaluate(() => {
      const target = document.querySelectorAll('article > p')[2];
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const selectionResult = await sw.evaluate(
      async ({ tabId, payload }) => {
        return await chrome.tabs.sendMessage(tabId, {
          __w2m: true,
          type: 'BUILD',
          payload: { ...payload, mode: 'selection' },
        });
      },
      { tabId, payload },
    );
    assert.ok(selectionResult?.ok, `选区保存失败：${selectionResult?.error}`);
    assert.ok(
      selectionResult.markdown.includes('第二段用来补足正文长度'),
      '选区内容缺失',
    );
    assert.ok(selectionResult.stats.words < 120, '选区模式不应该包含整页内容');
    assert.match(selectionResult.stats.filename, /（摘录）\.md$/, '选区文件应带摘录后缀');
    ok('选区模式', `${selectionResult.stats.words} 字`);

    // ---- 弹窗流程：识别 → 真实点击保存 → 下载 ----
    log('打开弹窗，对测试页执行保存…');
    const popupPage = await context.newPage();
    await popupPage.setViewportSize({ width: 380, height: 760 });
    popupPage.on('pageerror', (e) => pageErrors.push(`popup: ${e.message}`));
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
    await popupPage.waitForFunction(
      () => document.getElementById('pageTitle')?.textContent === '端到端测试：图片内嵌验证',
      undefined,
      { timeout: 20000 },
    );
    const previewMeta = (await popupPage.textContent('#pageMeta')) ?? '';
    assert.match(previewMeta, /5 张图/);
    ok('弹窗预览', previewMeta.replace(/\s+/g, ' ').trim());

    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await popupPage.click('#btnSave');
    const download = await downloadPromise;
    await popupPage.waitForSelector('.result.ok', { timeout: 25000 });
    const resultText = ((await popupPage.textContent('.result')) ?? '').replace(/\s+/g, ' ');
    assert.match(resultText, /已保存/);
    assert.match(resultText, /4\/5 张图片已内嵌/);
    ok('弹窗结果', resultText.trim());

    const suggested = download.suggestedFilename();
    const savedPath = path.join(TMP, suggested);
    await download.saveAs(savedPath);
    const savedText = await fs.readFile(savedPath, 'utf8');
    ok('下载文件名', suggested, '|', savedText.length, '字符');
    assert.equal(suggested, '端到端测试：图片内嵌验证.md');
    assert.ok(savedText.includes('data:image/png;base64,'));
    assert.ok(Math.abs(savedText.length - md.length) < 200, '下载内容与返回值不一致');

    // 右上角 GitHub 入口（当前占位，后续换仓库地址）
    assert.equal(await popupPage.getAttribute('.icon-link', 'href'), 'https://github.com/say007go/page2md');
    assert.equal(await popupPage.getAttribute('.icon-link', 'target'), '_blank');

    await popupPage.screenshot({ path: path.join(TMP, 'popup-success.png') });

    // 结果提示可关闭
    await popupPage.click('.result-close');
    assert.equal(
      await popupPage.evaluate(() => document.getElementById('result').hidden),
      true,
      '结果提示应能关闭',
    );

    // 主题切换：auto -> light -> dark -> auto
    const themeOf = () =>
      popupPage.evaluate(() => ({
        pref: document.documentElement.dataset.themePref,
        theme: document.documentElement.dataset.theme,
      }));
    assert.equal((await themeOf()).pref, 'auto');
    await popupPage.click('#themeToggle');
    assert.deepEqual(await themeOf(), { pref: 'light', theme: 'light' });
    await popupPage.click('#themeToggle');
    assert.deepEqual(await themeOf(), { pref: 'dark', theme: 'dark' });
    await popupPage.click('#themeToggle');
    assert.equal((await themeOf()).pref, 'auto');
    ok('主题切换 auto → light → dark → auto');

    await popupPage.close();

    // ---- 弹窗界面截图（demo 模式，稳定首屏）----
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 380, height: 620 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html?demo=1`);
    await popup.waitForTimeout(400);
    await popup.screenshot({ path: path.join(TMP, 'popup.png') });
    await popup.close();

    assert.deepEqual(swErrors, [], `后台报错：${swErrors.join(' | ')}`);
    assert.deepEqual(pageErrors, [], `页面报错：${pageErrors.join(' | ')}`);

    ok('全部端到端断言通过');
    console.log(
      '\n产物：',
      path.join(TMP, 'result.md'),
      '\n      ',
      path.join(TMP, 'popup.png'),
      '\n      ',
      path.join(TMP, 'popup-success.png'),
    );
  } finally {
    await context?.close().catch(() => {});
    imgServer.close();
    pageServer.close();
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('\n✗ 端到端测试失败：', error);
  process.exitCode = 1;
});
