'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const config = require('./config');
const novel = require('./novel');

let mainWindow = null;

/** 上一次已应用的 source 标识，用于判断是否切换了小说（换书需重置阅读进度）。 */
let lastSourceKey = null;
/** 已落盘（config.yaml 里）的 source 标识，用于判断磁盘上的进度是否该重置。 */
let persistedSourceKey = null;
/** config.yaml 的文件监听及其去抖计时器。 */
let configWatcher = null;
let configWatchTimer = null;

/* --------------------------- 窗口拖动 --------------------------- */

/**
 * 拖动会话。位置通过「屏幕光标绝对坐标」计算，而不是累加每帧增量：
 * - 光标由主进程的 screen.getCursorScreenPoint() 读取，与窗口坐标处于同一坐标系，
 *   避免渲染层事件坐标（CSS px）与窗口坐标（DIP）不一致导致的漂移；
 * - 以按下时的窗口位置为基准做绝对定位，不会累积舍入误差；
 * - 每 16ms 采样一次，即使光标移出窗口也能继续跟随；
 * - 移动时显式传入宽高（setBounds 而非 setPosition）：在非 100% 缩放的 Windows 上，
 *   setPosition 会因 DPI 换算让窗口尺寸逐步膨胀，必须锁定尺寸。
 */
let dragSession = null;
/** 各窗口「缩放结束」的去抖计时器（key: win.id）。 */
const windowStateSaveTimers = new Map();

/**
 * 各窗口尺寸的「权威值」（key: win.id）。
 *
 * 不能从 getBounds() 反推尺寸：当窗口停在「非整物理像素」的位置上时，Windows 会把
 * 物理矩形向外取整，导致报出的尺寸虚高 1~2px（实测 125% 缩放下 556x224 会报成 558x226）。
 * 把这个虚高值写回配置后，下次启动的网格对齐又会向上取整，于是每次「挪动 → 关闭 → 重启」
 * 窗口都会变大一圈。所以尺寸只由这里维护，仅在用户真正缩放窗口时更新。
 */
const windowSizes = new Map();

/** 设置窗口（单例；关闭后置空）。 */
let settingsWindow = null;

/**
 * 「应用」按钮带来、尚未落盘的配置改动（null 表示无）。
 *
 * 存在时有效配置 = 磁盘配置 + 这份改动。点「保存」「恢复默认」或关闭设置窗口即清除，
 * 因此「应用」只是预览，随时可以整体丢弃。
 */
let pendingPatch = null;

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

  // 位置必须落在「整数物理像素」网格上：否则 Windows 会把窗口的物理矩形向外取整，
  // 尺寸随之虚高，被记录后下次启动又向上对齐，窗口就会越挪越大。
  const targetX = alignToGrid(session.origin.x + (cursor.x - session.cursorStart.x), session.grid);
  const targetY = alignToGrid(session.origin.y + (cursor.y - session.cursorStart.y), session.grid);
  if (session.lastX === targetX && session.lastY === targetY) return;
  session.lastX = targetX;
  session.lastY = targetY;

  // 尺寸用权威值（不重新读 getBounds），彻底与位置解耦
  const size = windowSizes.get(win.id) || session.bounds;
  win.setBounds({
    x: targetX,
    y: targetY,
    width: size.width,
    height: size.height,
  });
}

/** 锚定位置与可用区域边缘之间的留白（px），避免窗口紧贴任务栏或屏幕边缘。 */
const ANCHOR_INSET = 6;

/**
 * 「整数物理像素」网格的步长（DIP）。
 *
 * 在非整数缩放下（125% → 5/4），DIP 坐标若不在该网格上，物理像素就落在半个像素上，
 * Windows 会把窗口的物理矩形向外取整：既会让报出的尺寸虚高 1~2px，也会让窗口尺寸在
 * 反复「记录 → 下次启动」后逐次变大。把坐标与尺寸都对齐到该网格即可根除。
 * 注意 setBounds 会把小数 DIP 向下取整，所以只能对齐到该网格、无法做到 1 物理像素步进。
 */
function physicalGridStep() {
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  for (let step = 1; step <= 8; step += 1) {
    if (Math.abs(step * scale - Math.round(step * scale)) < 1e-6) return step;
  }
  return 1;
}

/** 把坐标或尺寸对齐到整物理像素网格。 */
function alignToGrid(value, grid) {
  return Math.round(value / grid) * grid;
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
 * 解析某个窗口的初始状态。
 *
 * kind 为 'window'（阅读窗口）或 'settingsWindow'（设置窗口）：两者各有一套初始默认
 * 设置与记忆配置，尺寸下限也不同。尺寸与位置优先取记忆配置；坐标缺失或已不可见时，
 * 按该窗口初始默认设置的 position 重新定位（此时仍沿用记忆到的尺寸）。
 */
function resolveWindowState(cfg, kind) {
  const isSettings = kind === 'settingsWindow';
  const memory = isSettings ? cfg.effectiveSettingsWindow : cfg.effectiveWindow;
  const initial = isSettings ? cfg.settingsWindow : cfg.window;
  const minWidth = isSettings ? config.MIN_SETTINGS_WINDOW_WIDTH : config.MIN_WINDOW_WIDTH;
  const minHeight = isSettings ? config.MIN_SETTINGS_WINDOW_HEIGHT : config.MIN_WINDOW_HEIGHT;

  const grid = physicalGridStep();
  const alignPos = (value) => alignToGrid(value, grid);
  // 尺寸也要对齐：宽高若落在半个物理像素上，Windows 会向上取整，
  // 而记录下来的值下次又会对齐出更大的尺寸，导致每次重启都长大一点。
  const alignSize = (value, min) =>
    Math.max(alignToGrid(value, grid), Math.ceil(min / grid) * grid);

  const width = alignSize(memory.width, minWidth);
  const height = alignSize(memory.height, minHeight);
  const { x, y } = memory;

  if (Number.isFinite(x) && Number.isFinite(y) && isPositionUsable(x, y, width, height)) {
    // 记忆到的坐标同样对齐到物理像素网格（偏差不超过半个网格，肉眼不可见）
    return { x: alignPos(x), y: alignPos(y), width, height, fromMemory: true };
  }

  const [anchoredX, anchoredY] = computePosition(initial.position, width, height);
  return { x: anchoredX, y: anchoredY, width, height, fromMemory: false };
}

/** 窗口对应的记忆块名称（决定读写哪一套位置与尺寸）。 */
function rememberKind(win) {
  return win === settingsWindow ? 'settingsWindow' : 'window';
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

/**
 * 把窗口当前的位置与尺寸写入记忆配置。
 *
 * 位置取 getBounds() 的 x/y（就是我们设进去的、已对齐网格的值）；
 * 尺寸取 windowSizes 里的权威值，而不是 getBounds() —— 后者在非整物理像素位置上会虚高。
 */
function persistWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    const size = windowSizes.get(win.id) || { width: b.width, height: b.height };
    const kind = rememberKind(win);
    config.saveWindowState(kind, { x: b.x, y: b.y, width: size.width, height: size.height });
    console.log(
      `[window] 已记录${kind === 'settingsWindow' ? '设置窗口' : '窗口'}状态 ` +
        `(${b.x}, ${b.y}) ${size.width}x${size.height}`
    );
  } catch (err) {
    console.error('[window] 记录窗口状态失败：', err.message);
  }
}

/** 两个窗口共用的 webPreferences（同样的隔离与安全设置）。 */
function sharedWebPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false,
    backgroundThrottling: false,
  };
}

/** 窗口图标：开发模式下跑的是 electron.exe，不设就会显示 Electron 默认图标。 */
function windowIcon() {
  return path.join(__dirname, '..', 'build', 'icon.png');
}

/**
 * 用户拖拽边缘缩放结束后记录（去抖，避免拖动过程中频繁写盘）。
 * 计时器按窗口存放，两个窗口互不干扰。
 */
function scheduleWindowStateSave(win) {
  const previous = windowStateSaveTimers.get(win.id);
  if (previous) clearTimeout(previous);

  windowStateSaveTimers.set(
    win.id,
    setTimeout(() => {
      windowStateSaveTimers.delete(win.id);
      if (win.isDestroyed()) return;
      // 只有用户真正缩放过才更新权威尺寸。此时窗口位置必定落在物理像素网格上
      //（拖动与恢复都会对齐），因此 getBounds() 报出的尺寸是可信的。
      const b = win.getBounds();
      const grid = physicalGridStep();
      windowSizes.set(win.id, {
        width: alignToGrid(b.width, grid),
        height: alignToGrid(b.height, grid),
      });
      persistWindowState(win);
    }, 400)
  );
}

function createWindow() {
  const cfg = effectiveConfig();
  // 记录当前 source 标识：首次加载不算「换书」，避免误重置阅读进度
  lastSourceKey = sourceKey(cfg.source);
  persistedSourceKey = lastSourceKey;
  const state = resolveWindowState(cfg, 'window');
  const translucent = cfg.window.opacity < 1;
  console.log(
    `[window] 主题=${cfg.theme} 尺寸=${state.width}x${state.height} 位置=(${state.x}, ${state.y}) ` +
      `不透明度=${cfg.window.opacity} ` +
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
    icon: windowIcon(),
    webPreferences: sharedWebPreferences(),
  });

  // 记录权威尺寸，之后拖动与写回都以它为准
  windowSizes.set(win.id, { width: state.width, height: state.height });

  // 构造阶段在非 100% 缩放的 Windows 上可能被 DPI 取整（如高度 100 → 103），
  // 显式 setBounds 一次即可精确落位，保证「记录 → 下次启动」零漂移。
  win.setBounds({ x: state.x, y: state.y, width: state.width, height: state.height });

  // 半透明：setOpacity 作用于整个窗口，无需 transparent 窗口，
  // 因此不会影响边缘缩放（Electron 的透明窗口是不支持缩放的）。
  if (translucent) {
    win.setOpacity(cfg.window.opacity);
  }

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch((err) => {
    console.error('[window] 加载阅读页面失败：', err.message);
  });

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  // 关闭时记录窗口状态，下次启动恢复
  win.on('close', () => {
    endDrag();
    persistWindowState(win);
  });

  win.on('resized', () => {
    // 拖动过程中窗口位置/尺寸都由我们接管，这里的 WM_SIZE 不算用户缩放
    if (dragSession) return;
    scheduleWindowStateSave(win);
  });

  win.on('closed', () => {
    const timer = windowStateSaveTimers.get(win.id);
    if (timer) {
      clearTimeout(timer);
      windowStateSaveTimers.delete(win.id);
    }
    windowSizes.delete(win.id);
    endDrag();
    mainWindow = null;
    // 阅读窗口关闭即退出程序，设置窗口一并关闭
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  });

  mainWindow = win;
}

/**
 * 打开（或聚焦）设置窗口。
 *
 * 设置窗口是独立窗口：阅读窗口通常很小，独立出来才有空间放表单，
 * 也便于单独调整大小并记忆位置（落盘到 remember.settingsWindow）。
 * 单例：重复打开只做显示与聚焦。
 */
function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  const cfg = effectiveConfig();
  const state = resolveWindowState(cfg, 'settingsWindow');
  console.log(
    `[settings] 打开设置窗口 尺寸=${state.width}x${state.height} 位置=(${state.x}, ${state.y}) ` +
      (state.fromMemory
        ? '(来自记忆配置)'
        : `(来自初始默认设置 position: ${cfg.settingsWindow.position})`)
  );

  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    frame: false, // 无标题栏，与阅读窗口一致
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    thickFrame: true, // 保留系统边缘缩放热区
    show: false,
    // 设置窗口固定不透明：半透明会让表单更难读，且与主窗口的不透明度无关
    backgroundColor: cfg.palette.bg,
    icon: windowIcon(),
    webPreferences: sharedWebPreferences(),
  });

  windowSizes.set(win.id, { width: state.width, height: state.height });
  win.setBounds({ x: state.x, y: state.y, width: state.width, height: state.height });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'settings.html')).catch((err) => {
    console.error('[settings] 加载设置页面失败：', err.message);
  });

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.on('close', () => {
    endDrag();
    persistWindowState(win);
  });

  win.on('resized', () => {
    if (dragSession) return;
    scheduleWindowStateSave(win);
  });

  win.on('closed', () => {
    const timer = windowStateSaveTimers.get(win.id);
    if (timer) {
      clearTimeout(timer);
      windowStateSaveTimers.delete(win.id);
    }
    windowSizes.delete(win.id);
    endDrag();
    settingsWindow = null;

    // 关闭设置窗口即丢弃未保存的预览改动，回到磁盘上已保存的配置
    if (pendingPatch) {
      pendingPatch = null;
      console.log('[config] 设置窗口已关闭，丢弃未保存的预览改动');
      applyConfigChange();
    }
  });

  settingsWindow = win;
  return win;
}

/* --------------------------- 配置热加载 --------------------------- */

/** source 的可比较标识（字符串或数组统一序列化）。 */
function sourceKey(source) {
  return JSON.stringify(source === undefined || source === null ? '' : source);
}

/**
 * 当前应当生效的配置 = 磁盘配置 + 「应用」带来的未保存改动。
 * 所有读取配置的入口都走这里，保证「预览」与「已保存」只有一份真相。
 */
function effectiveConfig() {
  const base = config.loadConfig();
  return pendingPatch ? config.applyPatch(base, pendingPatch) : base;
}

/** 把最新配置广播给所有窗口（阅读窗口与设置窗口都要跟随主题等变化）。 */
function broadcastConfig(cfg, sourceChanged) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send('config:changed', { config: cfg, sourceChanged });
    } catch (err) {
      console.warn('[config] 广播配置变更失败：', err.message);
    }
  }
}

/** 把与主题/配置相关的窗口属性同步到所有窗口。 */
function applyWindowAppearance(cfg) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    // 半透明只作用于阅读窗口：设置窗口需要稳定的可读性
    if (win === mainWindow) {
      try {
        win.setOpacity(cfg.window.opacity);
      } catch (err) {
        console.warn('[config] 应用不透明度失败：', err.message);
      }
    }
    // 窗口底色与主题同源，避免主题切换时出现不一致的底色
    try {
      win.setBackgroundColor(cfg.palette.bg);
    } catch (err) {
      console.warn('[config] 应用窗口底色失败：', err.message);
    }
  }
}

/**
 * 重新读取并应用配置。
 *
 * 这是「应用」「保存」「恢复默认」「外部编辑 config.yaml」四条路径的统一入口：
 * 主进程负责窗口相关项（不透明度、底色），排版与内容交给渲染层；
 * 一旦 source 发生变化即视为换书，重置阅读进度并让渲染层重新解析。
 *
 * 预览期间（存在 pendingPatch）不把「换书后的进度 0」写进磁盘，
 * 否则关掉设置窗口丢弃预览时，已保存的进度就被破坏了。
 */
function applyConfigChange() {
  const cfg = effectiveConfig();
  const key = sourceKey(cfg.source);
  const sourceChanged = key !== lastSourceKey;
  lastSourceKey = key;

  if (pendingPatch) {
    // 预览：只在内存里生效，磁盘上的来源与进度都不动
    if (sourceChanged) {
      cfg.progress = { chapter: 0, paragraph: 0 };
      console.log('[config] 预览换书（未保存），阅读进度暂不落盘');
    }
  } else if (key !== persistedSourceKey) {
    // 已落盘的来源发生变化（外部编辑，或预览后点了「保存」）：进度按新书归零
    try {
      config.saveProgress(0, 0);
      persistedSourceKey = key;
      cfg.progress = { chapter: 0, paragraph: 0 };
      console.log('[config] 小说来源已变更，阅读进度重置为第 1 章');
    } catch (err) {
      console.warn('[config] 重置阅读进度失败：', err.message);
    }
  } else if (sourceChanged) {
    // 从预览换书退回已保存的书：沿用磁盘上的进度
    cfg.progress = { chapter: 0, paragraph: 0 };
  }

  applyWindowAppearance(cfg);

  console.log(
    `[config] 已应用配置（主题=${cfg.theme} 字号=${cfg.fontSize} 行高=${cfg.lineHeight} ` +
      `不透明度=${cfg.window.opacity} 替换规则=${cfg.replace.length} 条` +
      `${sourceChanged ? ' 换书' : ''}${pendingPatch ? ' 预览未保存' : ''}）`
  );

  broadcastConfig(cfg, sourceChanged);
  return cfg;
}

/**
 * 监听 config.yaml 的外部改动并热加载。
 *
 * 监听「配置目录」而不是文件本身：编辑器保存常用「写临时文件 + 重命名」，
 * 直接监听文件会在被替换后丢掉目标；监听目录并按文件名过滤更稳。
 *
 * 去重交给 config.hasConfigChanged()（与程序自身最近读写的内容比对），
 * 因此进度、窗口状态这类程序写入不会触发无谓的重新加载，也不会自触发成环。
 */
function setupConfigWatcher() {
  if (configWatcher) return;
  try {
    configWatcher = fs.watch(config.CONFIG_ROOT, (_event, filename) => {
      if (filename && path.basename(String(filename)).toLowerCase() !== 'config.yaml') return;
      if (configWatchTimer) clearTimeout(configWatchTimer);
      configWatchTimer = setTimeout(() => {
        configWatchTimer = null;
        if (!config.hasConfigChanged()) return;
        // 文件被外部改动：以文件为准，未保存的预览改动作废
        if (pendingPatch) {
          pendingPatch = null;
          console.log('[config] config.yaml 已被外部修改，丢弃未保存的预览改动');
        }
        console.log('[config] 检测到 config.yaml 外部改动，热加载配置');
        applyConfigChange();
      }, 200);
    });
    configWatcher.on('error', (err) => {
      console.warn('[config] 监听 config.yaml 失败，热加载可能失效：', err.message);
    });
  } catch (err) {
    console.warn('[config] 无法监听 config.yaml，配置热加载不可用：', err.message);
  }
}

function registerIpc() {
  // 读取「当前生效」的配置：设置窗口用它填充表单，阅读窗口启动时用它初始化
  ipcMain.handle('config:load', () => effectiveConfig());

  ipcMain.handle('novel:load', () => {
    try {
      const cfg = effectiveConfig();
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
    // 预览期间（存在未保存改动）不落盘：避免预览换书覆盖掉已保存的进度
    if (pendingPatch) return { ok: true, skipped: 'preview' };
    try {
      config.saveProgress(chapter, paragraph);
      return { ok: true };
    } catch (err) {
      console.error('[progress] 保存失败：', err.message);
      return { ok: false, error: err.message };
    }
  });

  // 打开（或聚焦）设置窗口
  ipcMain.on('settings:open', () => createSettingsWindow());

  ipcMain.on('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    // 用 close() 而非 destroy()，保证先触发 close 事件把窗口状态落盘
    if (win) win.close();
  });

  ipcMain.on('window:drag-start', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    endDrag();
    // 会话内固定住网格步长与尺寸基准，拖动过程中不再读取 getBounds()
    const bounds = win.getBounds();
    dragSession = {
      win,
      bounds,
      grid: physicalGridStep(),
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

  // 设置窗口「应用」：只做预览（不写 config.yaml）
  ipcMain.handle('config:apply', (_event, patch) => {
    try {
      pendingPatch = patch && typeof patch === 'object' ? patch : {};
      const cfg = applyConfigChange();
      return { ok: true, config: cfg };
    } catch (err) {
      console.error('[config] 应用配置失败：', err.message);
      return { ok: false, error: err.message };
    }
  });

  // 设置窗口「保存」：写入 config.yaml（只改传入的键，保留注释），并清掉预览改动
  ipcMain.handle('config:save', (_event, patch) => {
    try {
      config.saveConfig(patch);
      pendingPatch = null;
      const cfg = applyConfigChange();
      return { ok: true, config: cfg };
    } catch (err) {
      console.error('[config] 保存配置失败：', err.message);
      return { ok: false, error: err.message };
    }
  });

  // 用系统默认程序打开 config.yaml
  ipcMain.handle('config:open-file', async () => {
    try {
      config.ensureConfig();
      const message = await shell.openPath(config.CONFIG_PATH);
      return message ? { ok: false, error: message } : { ok: true };
    } catch (err) {
      console.error('[config] 打开 config.yaml 失败：', err.message);
      return { ok: false, error: err.message };
    }
  });
}

app.whenReady().then(() => {
  registerIpc();
  setupConfigWatcher();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 退出前释放配置监听
app.on('will-quit', () => {
  if (configWatchTimer) {
    clearTimeout(configWatchTimer);
    configWatchTimer = null;
  }
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
