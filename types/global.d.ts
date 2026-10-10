/**
 * 全局类型声明（仅用于静态检查，不参与运行时，也不会被打包进应用）。
 *
 * preload 通过 contextBridge 把白名单 API 注入到 window.readerAPI 上。
 * 阅读窗口（renderer.js）与设置窗口（settings.js）共用同一套 API。
 */

interface ReaderThemeOption {
  name: string;
  label: string;
}

interface ReaderPalette {
  bg: string;
  fg: string;
  title: string;
  border: string;
  error: string;
  /** 控件底色（由主题派生，保证原生控件在任何主题下都清晰可辨） */
  control: string;
  /** 控件 hover / 强调底色 */
  hover: string;
}

interface ReaderConfig {
  source: string | string[];
  theme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  replace: Array<{ pattern: string; replace: string; flags: string }>;
  window: { width: number; height: number; position: string; opacity: number };
  settingsWindow: { width: number; height: number; position: string };
  progress: { chapter: number; paragraph: number };
  palette: ReaderPalette;
  /** 设置窗口的主题下拉项 */
  themeList: ReaderThemeOption[];
  /** 设置窗口「恢复默认」用的阅读设置默认值（不含小说来源） */
  readingDefaults: {
    theme: string;
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    opacity: number;
    replace: Array<{ pattern: string; replace: string; flags: string }>;
  };
}

/** 设置窗口提交的改动（只包含需要改写的键）。 */
interface ReaderConfigPatch {
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  opacity?: number;
  source?: string | string[];
  replace?: Array<{ pattern: string; replace?: string; flags?: string }>;
}

interface ReaderAPI {
  /** 读取「当前生效」的配置（含未保存的预览改动）。 */
  loadConfig(): Promise<ReaderConfig>;

  /** 读取并解析小说。 */
  loadNovel(): Promise<{
    ok: boolean;
    chapters: Array<{ index: number; title: string; paragraphs: string[] }>;
    restore: { chapter: number; paragraph: number };
    error?: string;
  }>;

  /** 保存阅读进度（章节索引 + 章节内段落索引）。预览期间主进程会跳过落盘。 */
  saveProgress(chapter: number, paragraph: number): Promise<{ ok: boolean }>;

  /** 打开（或聚焦）独立的设置窗口。 */
  openSettings(): void;

  /** 「应用」：立即生效，但不写入 config.yaml（仅预览）。 */
  applyConfig(
    patch: ReaderConfigPatch
  ): Promise<{ ok: boolean; config?: ReaderConfig; error?: string }>;

  /** 「保存」：写入 config.yaml（只改传入的键）。 */
  saveConfig(
    patch: ReaderConfigPatch
  ): Promise<{ ok: boolean; config?: ReaderConfig; error?: string }>;

  /** 用系统默认程序打开 config.yaml。 */
  openConfigFile(): Promise<{ ok: boolean; error?: string }>;

  /** 订阅配置变更；返回取消订阅函数。 */
  onConfigChanged(
    callback: (payload: { config: ReaderConfig; sourceChanged: boolean }) => void
  ): () => void;

  /** 关闭当前窗口（阅读窗口由双击触发；设置窗口由 × 触发）。 */
  closeWindow(): void;

  /** 开始拖动当前窗口。 */
  dragStart(): void;

  /** 结束拖动。 */
  dragEnd(): void;
}

interface Window {
  readerAPI: ReaderAPI;
}
