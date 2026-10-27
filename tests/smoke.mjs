/**
 * 真实站点冒烟测试：对线上文章跑一遍完整流程，检查提取质量与图片抓取成功率。
 * 用法：node tests/smoke.mjs [url...]
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIST = path.join(process.cwd(), 'dist');
const TMP = path.join(process.cwd(), 'tests', '.tmp');

const urls = process.argv.slice(2);
if (!urls.length) {
  urls.push(
    'http://mp.weixin.qq.com/s?__biz=Mzk0NjQ2NTg4Ng==&mid=2247486305&idx=1&sn=622998814644fcc40cf8b83efe1e359c',
    'https://www.jiqizhixin.com/articles/2026-01-29-9',
    'https://ceea500.org.cn/news/detail/14/7264.html',
  );
}

await fs.mkdir(TMP, { recursive: true });

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'w2m-smoke-'));
const bundled = chromium.executablePath();
const context = await chromium.launchPersistentContext(dir, {
  channel: fsSync.existsSync(bundled) ? 'chromium' : 'msedge',
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  viewport: { width: 1400, height: 1000 },
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const extensionId = new URL(sw.url()).host;
console.log('extension', extensionId);

for (const [index, url] of urls.entries()) {
  const page = await context.newPage();
  console.log('\n===', index, url);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2500);
    const title = await page.title();
    console.log('页面标题:', title.slice(0, 80));

    const tabId = await sw.evaluate(async (target) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url === target)?.id ?? -1;
    }, page.url());
    if (tabId < 0) {
      console.log('未找到标签页');
      continue;
    }

    const started = Date.now();
    const result = await Promise.race([
      sw.evaluate(
        async ({ tabId }) => {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
          return await chrome.tabs.sendMessage(tabId, {
            __w2m: true,
            type: 'BUILD',
            payload: {
              embedImages: true,
              compressImages: false,
              maxEdge: 1600,
              quality: 0.85,
              includeMeta: true,
              datePrefix: false,
              mode: 'page',
              action: 'copy',
              toast: false,
            },
          });
        },
        { tabId },
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('60s 超时')), 60_000)),
    ]);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (!result?.ok) {
      console.log('✗ 失败:', result?.error);
      continue;
    }
    const { stats, markdown } = result;
    const file = path.join(TMP, `smoke-${index}.md`);
    await fs.writeFile(file, markdown, 'utf8');
    console.log(
      `✓ ${elapsed}s | ${stats.words} 字 | 图 ${stats.images}（内嵌 ${stats.imagesEmbedded}，失败 ${stats.imagesFailed}）| ${(stats.bytes / 1024).toFixed(0)} KB | ${stats.method}`,
    );
    console.log('文件名:', stats.filename, '| 耗时', JSON.stringify(stats.timings ?? {}));
    console.log('--- 开头 ---');
    console.log(
      markdown
        .split('\n')
        .filter(Boolean)
        .slice(0, 12)
        .map((l) => (l.length > 100 ? l.slice(0, 100) + '…' : l))
        .join('\n'),
    );
    console.log('--- 结尾 ---');
    console.log(
      markdown
        .split('\n')
        .filter(Boolean)
        .slice(-4)
        .map((l) => (l.length > 100 ? l.slice(0, 100) + '…' : l))
        .join('\n'),
    );
  } catch (error) {
    console.log('✗ 异常:', error.message);
  } finally {
    await page.close().catch(() => {});
  }
}

await context.close();
