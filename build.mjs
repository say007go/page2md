import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(root, 'public'), dist, { recursive: true });

const options = {
  entryPoints: {
    content: 'src/content/index.ts',
    background: 'src/background.ts',
    popup: 'src/popup/popup.ts',
  },
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  target: ['chrome109'],
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
  minify: process.argv.includes('--minify'),
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  plugins: [
    {
      name: 'build-summary',
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length) {
            console.error(`\n✗ 构建失败：${result.errors.length} 个错误`);
            return;
          }
          console.log('\n产物：');
          for (const [name, out] of Object.entries(result.metafile?.outputs ?? {})) {
            void name;
            void out;
          }
          const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
          const files = [manifest.background.service_worker, manifest.action.default_popup, 'popup.js', 'content.js'];
          const missing = [];
          for (const f of files) {
            try {
              await readFile(path.join(dist, f));
            } catch {
              missing.push(f);
            }
          }
          if (missing.length) console.error(`✗ 缺少文件：${missing.join(', ')}`);
          else console.log('✓ dist/ 就绪，可在 chrome://extensions 加载已解压的扩展程序');
        });
      },
    },
  ],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching…');
} else {
  await esbuild.build(options);
}
