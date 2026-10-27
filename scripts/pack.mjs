import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const out = path.join('release', `page2md-${pkg.version}.zip`);
mkdirSync('release', { recursive: true });
rmSync(out, { force: true });

const ps = [
  '-NoProfile',
  '-Command',
  `Compress-Archive -Path 'dist\\*' -DestinationPath '${out.replace(/\\/g, '\\\\')}' -Force`,
];
execFileSync('powershell', ps, { stdio: 'inherit' });
console.log(`\n✓ 已打包 ${out}`);
