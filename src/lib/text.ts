/** 文本统计、元信息、文件名等纯函数工具。 */

export function countWords(text: string): number {
  if (!text) return 0;
  const cjk = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const latin =
    text
      .replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ')
      .match(/[A-Za-z0-9][A-Za-z0-9'-]*/g)?.length ?? 0;
  return cjk + latin;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatNumber(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 去掉文件名中的非法字符，限制长度。 */
export function safeFilename(title: string, maxLen = 80): string {
  let s = (title || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!s) s = '未命名页面';
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

export function localIso(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
}

export function datePrefix(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface FrontMatterFields {
  [key: string]: string | number | undefined | null;
}

/** 生成 YAML front matter。值用 JSON 双引号转义（合法 YAML 标量）。 */
export function buildFrontMatter(fields: FrontMatterFields): string {
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === 'number' ? String(raw) : raw.trim();
    if (value === '') continue;
    lines.push(`${key}: ${typeof raw === 'number' ? raw : JSON.stringify(value)}`);
  }
  if (!lines.length) return '';
  return `---\n${lines.join('\n')}\n---\n\n`;
}
