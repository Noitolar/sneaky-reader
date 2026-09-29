'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const config = require('./config');
const novel = require('./novel');

let mainWindow = null;

/* --------------------------- 窗口拖动 --------------------------- */

/**
 * 拖动会话。位置通过「屏幕光标绝对坐标」计算，而不是累加每帧增量：
 * - 光标由主进程的 screen.getCursorScreenPoint() 读取，与窗口坐标处于同一坐标系，
 *   避免渲染层事件坐标（CSS px）与窗口坐标（DIP）不一致导致的漂移；
 * - 以按下时的窗口位置为基准做绝对定位，不会累积舍入误差；
 * - 每 16ms 采样一次，即使光标移出窗口也能继续跟随；
 * - 移动时显式传入按下瞬间的宽高（setBounds 而非 setPosition）：在非 100% 缩放的
 *   Windows 上，setPosition 会因 DPI 换算让窗口尺寸逐步膨胀，必须锁定尺寸。
 */
let dragSession = null;
let windowStateSaveTimer = null;

function endDrag() {
  const session = dragSession;
  if (!session) return;
  clearInterval(session.timer);
  dragSession = null;

  // 拖动结束后立即落盘，避免异常退出（如任务管理器结束进程）丢失窗口状态
  if (session.armed) persistWindowState(session.win);
}

function applyDrag() {
  const session = dragSession;
  if (!session) return;

  const { win } = session;
  if (win.isDestroyed()) {
    endDrag();
    return;
  }

  // 安全兜底：异常情况下最长拖动 2 分钟后自动结束，避免窗口被"粘"在光标上
  if (Date.now() - session.startedAt > 120000) {
    endDrag();
    return;
  }

  const cursor = screen.getCursorScreenPoint();

  // 位移阈值：区分「点击」与「拖动」，并在真正开始拖动时重新取基准，避免起步跳动
  if (!session.armed) {
    const ddx = cursor.x - session.cursorStart.x;
    const ddy = cursor.y - session.cursorStart.y;
    if (Math.hypot(ddx, ddy) <= 3) return;
    const [x, y] = win.getPosition();
    session.armed = true;
    session.origin = { x, y };
    session.cursorStart = cursor;
    return;
  }

  const targetX = session.origin.x + (cursor.x - session.cursorStart.x);
  const targetY = session.origin.y + (cursor.y - session.cursorStart.y);
  if (session.lastX === targetX && session.lastY === targetY) return;
  session.lastX = targetX;
  session.lastY = targetY;

  // 关键：显式传入按下瞬间的宽高，避免 DPI 换算导致窗口尺寸膨胀
  win.setBounds({
    x: targetX,
    y: targetY,
    width: session.bounds.width,
    height: session.bounds.height,
  });
}

/** 锚定位置与可用区域边缘之间的留白（px），避免窗口紧贴任务栏或屏幕边缘。 */
const ANCHOR_INSET = 6;

/**
 * 「整数物理像素」网格的步长（DIP）。
 *
 * 在非整数缩放下（125% → 5/4），DIP 坐标若不在该网格上，物理像素就会落在半个像素上，
 * Windows 会反过来微调窗口尺寸（实测 400x100 变成 402x102）。把坐标对齐到网格即可避免。
 */
function physicalGridStep() {
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  for (let step = 1; step <= 8; step += 1) {
    if (Math.abs(step * scale - Math.round(step * scale)) < 1e-6) return step;
  }
  return 1;
}

/**
 * 依据 position 计算窗口左上角坐标（默认左上）。
 *
 * 基准是显示器的「工作区」workArea —— 它已经扣除了 Windows 任务栏占用的空间，
 * 因此左下 / 右下不会被任务栏遮挡；最后再夹取一次，保证窗口完整落在工作区内
 * （窗口比工作区还大时贴住工作区左上角）。
 */
function computePosition(position, width, height) {
  const { workArea } = screen.getPrimaryDisplay();
  const grid = physicalGridStep();
  // 留白也落在网格上，避免它自己把坐标带偏
  const inset = Math.max(grid, Math.round(ANCHOR_INSET / grid) * grid);
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;

  let x;
  let y;
  switch (position) {
    case 'bottom-left':
      x = minX + inset;
      y = maxY - inset;
      break;
    case 'top-right':
      x = maxX - inset;
      y = minY + inset;
      break;
    case 'bottom-right':
      x = maxX - inset;
      y = maxY - inset;
      break;
    case 'center':
      x = Math.round((workArea.x + (workArea.width - width) / 2) / grid) * grid;
      y = Math.round((workArea.y + (workArea.height - height) / 2) / grid) * grid;
      break;
    case 'top-left':
    default:
      x = minX + inset;
      y = minY + inset;
      break;
  }

  // 夹取到工作区内，并统一对齐到物理像素网格
  const clampedX = Math.min(Math.max(x, minX), Math.max(minX, maxX));
  const clampedY = Math.min(Math.max(y, minY), Math.max(minY, maxY));
  return [
    Math.round(clampedX / grid) * grid,
    Math.round(clampedY / grid) * grid,
  ];
}

/**
 * 记忆配置里的窗口坐标是否仍然可用：
 * 至少要有足够大的一块落在某个显示器的可用区域内，否则视为显示器变更后的失效坐标。
 */
function isPositionUsable(x, y, width, height) {
  const needW = Math.min(width, 60);
  const needH = Math.min(height, 24);
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const overlapW = Math.min(x + width, a.x + a.width) - Math.max(x, a.x);
    const overlapH = Math.min(y + height, a.y + a.height) - Math.max(y, a.y);
    return overlapW >= needW && overlapH >= needH;
  });
}

/**
 * 解析窗口初始状态：
 * 尺寸与位置优先取记忆配置；坐标缺失或已不可见时，按初始默认设置的 position 重新定位
 * （此时仍沿用记忆到的尺寸）。
 */
function resolveWindowState(cfg) {
  const grid = physicalGridStep();
  const alignPos = (value) => Math.round(value / grid) * grid;
  // 尺寸也要对齐：宽高若落在半个物理像素上，Windows 会向上取整，
  // 而记录下来的值下次又会对齐出更大的尺寸，导致每次重启都长大一点。
  const alignSize = (value, min) =>
    Math.max(Math.round(value / grid) * grid, Math.ceil(min / grid) * grid);

  const width = alignSize(cfg.effectiveWindow.width, config.MIN_WINDOW_WIDTH);
  const height = alignSize(cfg.effectiveWindow.height, config.MIN_WINDOW_HEIGHT);
  const { x, y } = cfg.effectiveWindow;

  if (Number.isFinite(x) && Number.isFinite(y) && isPositionUsable(x, y, width, height)) {
    // 记忆到的坐标同样对齐到物理像素网格（偏差不超过半个网格，肉眼不可见）
    return { x: alignPos(x), y: alignPos(y), width, height, fromMemory: true };
  }

  const [anchoredX, anchoredY] = computePosition(cfg.window.position, width, height);
  return { x: anchoredX, y: anchoredY, width, height, fromMemory: false };
}

/**
 * 把「读取小说失败」整理成用户可操作的提示，直接显示在阅读窗口里。
 * 相对路径以配置文件所在目录（exe 旁边）为基准。
 */
function describeNovelError(err) {
  return [
    `读取失败：${err.message}`,
    '',
    '请在 config.yaml 中把 source 改成你自己的小说路径：',
    '  · 单个文件：source: D:/小说/我的小说.txt',
    '  · 一个目录：source: D:/小说      （目录下所有 .txt 按文件名顺序合并）',
    '  · 相对路径以配置文件所在目录（exe 旁边）为基准',
    '',
    `配置文件：${config.CONFIG_PATH}`,
  ].join('\n');
}

/** 把窗口当前的位置与尺寸写入记忆配置。 */
function persistWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    config.saveWindowState({ x: b.x, y: b.y, width: b.width, height: b.height });
    console.log(`[window] 已记录窗口状态 (${b.x}, ${b.y}) ${b.width}x${b.height}`);
  } catch (err) {
    console.error('[window] 记录窗口状态失败：', err.message);
  }
}

function createWindow() {
  const cfg = config.loadConfig();
  const state = resolveWindowState(cfg);
  const translucent = cfg.window.opacity < 1;
  const blurred = translucent && cfg.window.blur;
  console.log(
    `[window] 主题=${cfg.theme} 尺寸=${state.width}x${state.height} 位置=(${state.x}, ${state.y}) ` +
      `不透明度=${cfg.window.opacity}${blurred ? ' +亚克力模糊' : ''} ` +
      (state.fromMemory ? '(来自记忆配置)' : `(来自初始默认设置 position: ${cfg.window.position})`)
  );

  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    frame: false, // 无标题栏
    resizable: true, // 可调整大小（宽度变化后文字重排）
    maximizable: false,
    fullscreenable: false,
    thickFrame: true, // 保留系统边缘缩放热区
    show: false,
    backgroundColor: cfg.palette.bg,
    // 窗口图标：开发模式下跑的是 electron.exe，不设就会显示 Electron 默认图标
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  // 构造阶段在非 100% 缩放的 Windows 上可能被 DPI 取整（如高度 100 → 103），
  // 显式 setBounds 一次即可精确落位，保证「记录 → 下次启动」零漂移。
  win.setBounds({ x: state.x, y: state.y, width: state.width, height: state.height });

  // 半透明：setOpacity 作用于整个窗口，无需 transparent 窗口，
  // 因此不会影响边缘缩放（Electron 的透明窗口是不支持缩放的）。
  if (translucent) {
    win.setOpacity(cfg.window.opacity);
  }

  // 高斯模糊：使用 Windows 系统材质（亚克力），而不是 CSS backdrop-filter
  // ——后者只能模糊页面自身内容，无法模糊窗口下方的桌面。
  // 亚克力由 DWM 绘制在窗口后方，配合上面的半透明即可看到毛玻璃效果。
  if (blurred) {
    if (typeof win.setBackgroundMaterial === 'function') {
      try {
        win.setBackgroundMaterial('acrylic');
      } catch (err) {
        console.warn('[window] 设置亚克力材质失败，已忽略 blur：', err.message);
      }
    } else {
      console.warn('[window] 当前 Electron 版本不支持背景材质，已忽略 blur');
    }
  }

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  // 关闭时记录窗口状态，下次启动恢复
  win.on('close', () => {
    endDrag();
    persistWindowState(win);
  });

  // 用户拖拽边缘缩放结束后记录（去抖，避免拖动过程中频繁写盘）
  win.on('resized', () => {
    if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = setTimeout(() => {
      windowStateSaveTimer = null;
      persistWindowState(win);
    }, 400);
  });

  win.on('closed', () => {
    if (windowStateSaveTimer) {
      clearTimeout(windowStateSaveTimer);
      windowStateSaveTimer = null;
    }
    endDrag();
    mainWindow = null;
  });

  mainWindow = win;
}

function registerIpc() {
  ipcMain.handle('config:load', () => config.loadConfig());

  ipcMain.handle('novel:load', () => {
    try {
      const cfg = config.loadConfig();
      const { chapters } = novel.loadNovel(cfg.source, config.CONFIG_ROOT);
      console.log(`[novel] 已加载 ${chapters.length} 章`);
      return { ok: true, chapters, restore: cfg.progress };
    } catch (err) {
      console.error('[novel] 加载失败：', err.message);
      return {
        ok: false,
        error: describeNovelError(err),
        chapters: [],
        restore: { chapter: 0, paragraph: 0 },
      };
    }
  });

  ipcMain.handle('progress:save', (_event, chapter, paragraph) => {
    try {
      config.saveProgress(chapter, paragraph);
      return { ok: true };
    } catch (err) {
      console.error('[progress] 保存失败：', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
  });

  ipcMain.on('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    // 用 close() 而非 destroy()，保证先触发 close 事件把窗口状态落盘
    if (win) win.close();
  });

  ipcMain.on('window:drag-start', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    endDrag();
    // 在窗口尚未移动时锁定尺寸，整个拖动过程都用这一份宽高
    const bounds = win.getBounds();
    dragSession = {
      win,
      bounds,
      origin: { x: bounds.x, y: bounds.y },
      cursorStart: screen.getCursorScreenPoint(),
      armed: false,
      lastX: null,
      lastY: null,
      startedAt: Date.now(),
      timer: setInterval(applyDrag, 16),
    };
  });

  ipcMain.on('window:drag-end', () => endDrag());
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
