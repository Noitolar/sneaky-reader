/**
 * 全局类型声明（仅用于静态检查，不参与运行时，也不会被打包进应用）。
 *
 * preload 通过 contextBridge 把白名单 API 注入到 window.readerAPI 上。
 * 静态分析看不到这个运行时注入的属性，会报「未解析的变量 readerAPI」，
 * 在这里声明一次即可让渲染进程的 JS 正确解析（WebStorm / VS Code 均适用）。
 */

interface ReaderAPI {
  /** 读取 config.yaml（不存在时由主进程生成带注释的模板）。 */
  loadConfig(): Promise<{
    theme: string;
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    palette: { bg: string; fg: string; title: string; border: string; error: string };
  }>;

  /** 读取并解析小说。 */
  loadNovel(): Promise<{
    ok: boolean;
    chapters: Array<{ index: number; title: string; paragraphs: string[] }>;
    restore: { chapter: number; paragraph: number };
    error?: string;
  }>;

  /** 保存阅读进度（章节索引 + 章节内段落索引）。 */
  saveProgress(chapter: number, paragraph: number): Promise<{ ok: boolean }>;

  /** 关闭窗口（左键双击触发）。 */
  closeWindow(): void;

  /** 开始拖动窗口。 */
  dragStart(): void;

  /** 结束拖动。 */
  dragEnd(): void;
}

interface Window {
  readerAPI: ReaderAPI;
}
