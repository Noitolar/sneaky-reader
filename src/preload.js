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

  /** 打开（或聚焦）独立的设置窗口。 */
  openSettings: () => ipcRenderer.send('settings:open'),

  /** 设置窗口「应用」：立即生效，但**不**写入 config.yaml（仅预览）。 */
  applyConfig: (patch) => ipcRenderer.invoke('config:apply', patch),

  /** 设置窗口「保存」：写入 config.yaml（只改传入的键，其余内容与手写注释保持不变）。 */
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),

  /** 用系统默认程序打开 config.yaml。 */
  openConfigFile: () => ipcRenderer.invoke('config:open-file'),

  /** 订阅配置变更（外部编辑 config.yaml 或菜单保存后由主进程广播）。返回取消订阅函数。 */
  onConfigChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('config:changed', listener);
    return () => ipcRenderer.removeListener('config:changed', listener);
  },
});
