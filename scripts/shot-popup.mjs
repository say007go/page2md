/**
 * 弹窗 UI 截图（开发用）：加载扩展 → 打开 demo 弹窗 → 截首屏与保存完成态。
 * 用法：node scripts/shot-popup.mjs [width] [height]
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'tests', '.tmp');
const width = Number(process.argv[2] ?? 380);
const height = Number(process.argv[3] ?? 700);

await fs.mkdir(OUT, { recursive: true });
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'w2m-shot-'));
const bundled = chromium.executablePath();
const context = await chromium.launchPersistentContext(dir, {
  channel: fsSync.existsSync(bundled) ? 'chromium' : 'msedge',
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  viewport: { width: 1280, height: 900 },
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const extensionId = new URL(sw.url()).host;

const page = await context.newPage();
await page.setViewportSize({ width, height });
await page.goto(`chrome-extension://${extensionId}/popup.html?demo=1`);
await page.waitForTimeout(300);
const h1 = await page.evaluate(() => Math.round(document.body.getBoundingClientRect().height));
await page.screenshot({ path: path.join(OUT, 'popup.png') });

await page.click('#btnSave');
await page.waitForSelector('.result.ok', { timeout: 5000 });
await page.waitForTimeout(150);
const h2 = await page.evaluate(() => Math.round(document.body.getBoundingClientRect().height));
await page.screenshot({ path: path.join(OUT, 'popup-success.png') });
console.log(`首屏高 ${h1}px / 完成态高 ${h2}px（Chrome 弹窗上限 600px）`);
console.log(`screenshot ${width}x${height} → tests/.tmp/popup.png, popup-success.png`);

// 不支持页面时的兜底状态（此时 active tab 是扩展页自身）
const errorPage = await context.newPage();
await errorPage.setViewportSize({ width, height });
await errorPage.goto(`chrome-extension://${extensionId}/popup.html`);
await errorPage.waitForTimeout(500);
await errorPage.screenshot({ path: path.join(OUT, 'popup-unsupported.png') });
console.log('screenshot → tests/.tmp/popup-unsupported.png');

await context.close();
await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
