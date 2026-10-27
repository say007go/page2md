/** 扩展内共享类型与协议定义。 */

export interface Settings {
  /** 图片以 Base64 dataURI 完整内嵌（核心特性） */
  embedImages: boolean;
  /** 对超大图做降采样 + 转码 */
  compressImages: boolean;
  /** 压缩时最长边 px */
  maxEdge: number;
  /** 压缩时 JPEG 质量 0-1 */
  quality: number;
  /** 写入 YAML 元信息块 */
  includeMeta: boolean;
  /** 文件名加日期前缀 */
  datePrefix: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  embedImages: true,
  compressImages: false,
  maxEdge: 1600,
  quality: 0.85,
  includeMeta: true,
  datePrefix: false,
};

export type SaveMode = 'page' | 'selection';
export type SaveAction = 'download' | 'copy';

export interface BuildOptions extends Settings {
  mode: SaveMode;
  action: SaveAction;
  /** 无弹窗流程（右键菜单/快捷键）时在页面内显示浮层进度 */
  toast?: boolean;
}

export type Stage = 'extract' | 'clean' | 'images' | 'markdown' | 'download' | 'done';

export interface ProgressEvent {
  type: 'progress';
  stage: Stage;
  message: string;
  done?: number;
  total?: number;
}

export interface BuildStats {
  title: string;
  filename: string;
  chars: number;
  words: number;
  images: number;
  imagesEmbedded: number;
  imagesFailed: number;
  bytes: number;
  method: string;
  elapsedMs: number;
  /** 各阶段耗时（毫秒），用于排查慢页面 */
  timings?: { extract: number; images: number; markdown: number };
}

export type BuildResult =
  | { ok: true; stats: BuildStats; markdown?: string }
  | { ok: false; error: string };

export type AnalyzeResult =
  | {
      ok: true;
      title: string;
      site: string;
      chars: number;
      images: number;
      hasSelection: boolean;
    }
  | { ok: false; error: string };

export type FetchImageResult =
  | { ok: true; dataUrl: string; mime: string; bytes: number }
  | { ok: false; error: string };

export const MSG = {
  PING: 'PING',
  ANALYZE: 'ANALYZE',
  BUILD: 'BUILD',
  FETCH_IMAGE: 'FETCH_IMAGE',
} as const;

export interface Envelope<T = unknown> {
  __w2m: true;
  type: string;
  payload?: T;
}
