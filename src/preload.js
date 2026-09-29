'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 通过 contextBridge 暴露最小的、类型安全的白名单 API。
 * 渲染进程不直接接触 Node / 文件系统。
 */
contextBridge.exposeInMainWorld('readerAPI', {
  /** 读取 config.yaml（不存在时由主进程自动生成带注释的模板）。 */
  loadConfig: () => ipcRenderer.invoke('config:load'),

  /** 读取并解析小说，返回 { ok, chapters, restore } 或 { ok:false, error }。 */
  loadNovel: () => ipcRenderer.invoke('novel:load'),

  /** 保存阅读进度（章节索引 + 章节内段落索引）。 */
  saveProgress: (chapter, paragraph) =>
    ipcRenderer.invoke('progress:save', chapter, paragraph),

  /** 关闭窗口（左键双击触发；主进程会先落盘窗口状态）。 */
  closeWindow: () => ipcRenderer.send('window:close'),

  /** 开始拖动窗口（由主进程依据屏幕光标绝对定位，避免漂移）。 */
  dragStart: () => ipcRenderer.send('window:drag-start'),

  /** 结束拖动。 */
  dragEnd: () => ipcRenderer.send('window:drag-end'),
});
