'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { THEMES, DEFAULT_THEME, hasTheme, resolveTheme } = require('./themes');

/**
 * 配置文件所在目录（可写、可编辑，config.yaml 就放在这里）。
 *
 * - 开发运行：项目根目录
 * - electron-builder 的单文件 portable 版：运行时由环境变量给出 exe 真实所在目录
 * - 其它打包形态：exe 所在目录（asar 内是只读的，不能放配置）
 */
function resolveConfigRoot() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return path.dirname(process.execPath);
  } catch {
    /* 非 Electron 环境（例如直接用 node 跑测试） */
  }
  return path.join(__dirname, '..');
}

/**
 * 配置文件目录（config.yaml 所在位置）。
 * 小说路径的相对路径也以本目录为基准，即「exe 旁边」。
 */
const CONFIG_ROOT = resolveConfigRoot();
const CONFIG_PATH = path.join(CONFIG_ROOT, 'config.yaml');

/** 窗口尺寸的合法下限（px），初始设置与记忆配置共用。 */
const MIN_WINDOW_WIDTH = 80;
const MIN_WINDOW_HEIGHT = 40;

/**
 * 内置默认配置，与需求 7~10 保持一致。
 *
 * window    —— 初始默认设置：由用户手写，首次启动或删除记忆配置后生效
 * remember  —— 记忆配置：由程序自动写入（关闭/拖动结束时记录窗口位置与尺寸）
 */
const DEFAULTS = {
  source: '',
  theme: DEFAULT_THEME,
  fontFamily: 'SimSun, Times New Roman, serif',
  fontSize: 10,
  lineHeight: 1.7,
  window: { width: 400, height: 160, position: 'top-left', opacity: 1, blur: false },
  remember: { window: { x: null, y: null, width: null, height: null } },
  progress: { chapter: 0, paragraph: 0 },
};

/** 窗口不透明度允许范围。 */
const MIN_OPACITY = 0.3;
const MAX_OPACITY = 1;

/** 生成主题清单注释（与 themes.js 保持同步）。 */
function themeCommentLines() {
  return Object.keys(THEMES)
    .map((name) => `#   ${name.padEnd(9)} ${THEMES[name].label}`)
    .join('\n');
}

/** 首启动写入的带注释模板。 */
const TEMPLATE = `# ============================================================
# sneaky-reader 配置文件
# 直接修改本文件并重启程序即可生效，无需任何可视化界面。
# ============================================================

# --- 小说来源（必填）------------------------------------------
# 把下面的 source 改成你自己的小说路径，支持三种写法：
#   1) 单个文件：  source: D:/小说/我的小说.txt
#   2) 多个文件：  source:
#                    - D:/小说/第一部.txt
#                    - D:/小说/第二部.txt
#   3) 一个目录：  source: D:/小说      （目录下所有 .txt 按文件名自然顺序合并）
# 相对路径以「本配置文件所在目录」为基准，也就是 exe 旁边。
# 路径填错或没填时，程序会直接在阅读窗口里给出提示。
source:

# --- 主题 -----------------------------------------------------
# 可选（均为低干扰的阅读配色）：
${themeCommentLines()}
theme: ${DEFAULT_THEME}

# --- 字体 -----------------------------------------------------
# 字体族，逗号分隔，按前后顺序回退（中文优先）
fontFamily: "SimSun, Times New Roman, serif"

# 正文字号（px）
fontSize: 10

# 行高倍数（相对字号），同时决定「逐行滚动」的步长
lineHeight: 1.7

# --- 窗口（初始默认设置）--------------------------------------
# 这里是你手写的初始设置：首次启动、或删除了下面的「记忆配置」后生效。
window:
  width: 400               # 窗口宽度（px）
  height: 160              # 窗口高度（px）
  position: top-left       # 首次启动位置：top-left / top-right / bottom-left / bottom-right / center
                           # 底部位置以「工作区」为基准，已自动避开 Windows 任务栏

  # 窗口不透明度：0.3 ~ 1，默认 1（完全不透明）。小于 1 时窗口半透明，
  # 可看到桌面背景。
  opacity: 1

  # 半透明高斯模糊：置为 true 时启用系统级模糊（Windows 11 亚克力材质），
  # 让桌面背景在窗口后方呈现毛玻璃效果。仅在 opacity < 1 时可见。
  # 注：Electron 的透明窗口不支持缩放，因此这里用系统材质实现，而非 CSS 透明背景。
  blur: false

# --- 记忆配置（程序自动写入，请勿手动修改）--------------------
# 程序会在关闭、拖动或缩放结束后记录窗口的位置与尺寸，
# 下次启动优先按它恢复。删除本块中任意一行，该项即回到上面的「初始默认设置」。
remember:
  window:
    x:                     # 上次关闭时的窗口横坐标
    y:                     # 上次关闭时的窗口纵坐标
    width:                 # 上次关闭时的窗口宽度（px）
    height:                # 上次关闭时的窗口高度（px）

# --- 阅读进度（程序自动写入，请勿手动修改）--------------------
progress:
  chapter: 0
  paragraph: 0
`;

/** 若 config.yaml 不存在，则生成带注释的默认模板。 */
function ensureConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, TEMPLATE, 'utf8');
  }
  return CONFIG_PATH;
}

/** 将任意原始对象规整为合法配置（合并默认值 + 类型/范围校验）。 */
function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cfg = {
    source: DEFAULTS.source,
    theme: DEFAULTS.theme,
    fontFamily: DEFAULTS.fontFamily,
    fontSize: DEFAULTS.fontSize,
    lineHeight: DEFAULTS.lineHeight,
    window: { ...DEFAULTS.window },
    remember: { window: { ...DEFAULTS.remember.window } },
    progress: { ...DEFAULTS.progress },
  };

  if (typeof src.source === 'string' || Array.isArray(src.source)) {
    cfg.source = src.source;
  }
  if (typeof src.theme === 'string' && hasTheme(src.theme)) {
    cfg.theme = src.theme;
  } else if (typeof src.theme === 'string') {
    console.warn(`[config] 未知主题 "${src.theme}"，回退为 ${DEFAULT_THEME}`);
  }
  if (typeof src.fontFamily === 'string' && src.fontFamily.trim()) {
    cfg.fontFamily = src.fontFamily.trim();
  }
  if (Number.isFinite(src.fontSize) && src.fontSize > 0) {
    cfg.fontSize = src.fontSize;
  }
  if (Number.isFinite(src.lineHeight) && src.lineHeight > 0) {
    cfg.lineHeight = src.lineHeight;
  }

  // --- 窗口初始默认设置（用户手写）---
  const w = src.window && typeof src.window === 'object' ? src.window : {};
  if (Number.isFinite(w.width) && w.width >= MIN_WINDOW_WIDTH) {
    cfg.window.width = Math.round(w.width);
  }
  if (Number.isFinite(w.height) && w.height >= MIN_WINDOW_HEIGHT) {
    cfg.window.height = Math.round(w.height);
  }
  if (typeof w.position === 'string' && w.position.trim()) {
    cfg.window.position = w.position.trim();
  }
  if (Number.isFinite(w.opacity)) {
    cfg.window.opacity = Math.min(Math.max(w.opacity, MIN_OPACITY), MAX_OPACITY);
  }
  if (typeof w.blur === 'boolean') {
    cfg.window.blur = w.blur;
  }

  // --- 记忆配置（程序自动写入，允许整块或单个键缺省）---
  const rememberedWindow =
    src.remember && typeof src.remember === 'object' && src.remember.window && typeof src.remember.window === 'object'
      ? src.remember.window
      : {};
  if (Number.isFinite(rememberedWindow.x) && Number.isFinite(rememberedWindow.y)) {
    cfg.remember.window.x = Math.round(rememberedWindow.x);
    cfg.remember.window.y = Math.round(rememberedWindow.y);
  }
  if (Number.isFinite(rememberedWindow.width) && rememberedWindow.width >= MIN_WINDOW_WIDTH) {
    cfg.remember.window.width = Math.round(rememberedWindow.width);
  }
  if (Number.isFinite(rememberedWindow.height) && rememberedWindow.height >= MIN_WINDOW_HEIGHT) {
    cfg.remember.window.height = Math.round(rememberedWindow.height);
  }

  // --- 实际生效的窗口状态：记忆配置优先，缺省则回落到初始默认设置 ---
  cfg.effectiveWindow = {
    width: cfg.remember.window.width || cfg.window.width,
    height: cfg.remember.window.height || cfg.window.height,
    x: cfg.remember.window.x,
    y: cfg.remember.window.y,
  };

  const p = src.progress && typeof src.progress === 'object' ? src.progress : {};
  if (Number.isInteger(p.chapter) && p.chapter >= 0) {
    cfg.progress.chapter = p.chapter;
  }
  if (Number.isInteger(p.paragraph) && p.paragraph >= 0) {
    cfg.progress.paragraph = p.paragraph;
  }

  // 把主题解析为具体调色板，供主进程（窗口底色）与渲染进程（CSS 变量）共用
  cfg.palette = resolveTheme(cfg.theme);

  return cfg;
}

/** 加载配置；文件缺失时自动生成，解析失败时回退默认值并打印日志。 */
function loadConfig() {
  ensureConfig();
  let raw = {};
  try {
    raw = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch (err) {
    console.error('[config] config.yaml 解析失败，将使用默认配置：', err.message);
    raw = {};
  }
  return normalize(raw);
}

/**
 * 匹配 config.yaml 中的 progress 块（含其缩进子行与尾随注释）。
 * 采用「文本替换」而非重新序列化整个 YAML，以保留用户手写的注释与格式。
 */
const PROGRESS_RE = /^progress:[^\n]*\n?(?:[ \t]+[^\n]*\n?)*/m;

/** 将阅读进度写回 config.yaml，保留文件其余内容与注释。 */
function saveProgress(chapter, paragraph) {
  const c = Number.isInteger(chapter) && chapter >= 0 ? chapter : 0;
  const p = Number.isInteger(paragraph) && paragraph >= 0 ? paragraph : 0;

  let text;
  try {
    text = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    text = TEMPLATE;
  }

  const block = `progress:\n  chapter: ${c}\n  paragraph: ${p}\n`;
  const next = PROGRESS_RE.test(text)
    ? text.replace(PROGRESS_RE, block)
    : `${text.replace(/\s*$/, '')}\n\n${block}`;

  fs.writeFileSync(CONFIG_PATH, next, 'utf8');
}

/** 记忆块的固定说明注释（仅在文件里还没有记忆块时随块写入）。 */
const REMEMBER_COMMENT = [
  '# --- 记忆配置（程序自动写入，请勿手动修改）--------------------',
  '# 程序会在关闭、拖动或缩放结束后记录窗口的位置与尺寸，',
  '# 下次启动优先按它恢复。删除本块中任意一行，该项即回到上面的「初始默认设置」。',
];

/**
 * remember 块本体（不含说明注释）。
 *
 * 说明注释必须与块体分开：替换时只重写块体，注释留在原地，
 * 否则每次保存都会再插一份说明注释，导致注释不断堆积。
 */
function formatRememberBody(state) {
  const rows = [
    ['x', state.x, '上次关闭时的窗口横坐标'],
    ['y', state.y, '上次关闭时的窗口纵坐标'],
    ['width', state.width, '上次关闭时的窗口宽度（px）'],
    ['height', state.height, '上次关闭时的窗口高度（px）'],
  ];
  // 按最长的「键: 值」对齐注释列
  const entries = rows.map(([key, value]) => `    ${key}: ${value}`);
  const pad = Math.max(...entries.map((line) => line.length)) + 2;

  return [
    'remember:',
    '  window:',
    ...rows.map(([, , note], i) => `${entries[i]}${' '.repeat(pad - entries[i].length)}# ${note}`),
  ];
}

/**
 * 把窗口状态写入 config.yaml 的 remember 块。
 *
 * 该块整体由程序维护，因此这里整体替换（而不是逐行改动）；
 * 块外的一切内容与注释保持原样，初始默认设置 window 块不受影响。
 */
function saveWindowState(state) {
  const x = Math.round(Number(state && state.x));
  const y = Math.round(Number(state && state.y));
  const width = Math.round(Number(state && state.width));
  const height = Math.round(Number(state && state.height));
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !(width >= MIN_WINDOW_WIDTH) ||
    !(height >= MIN_WINDOW_HEIGHT)
  ) {
    return;
  }

  let text;
  try {
    text = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    text = TEMPLATE;
  }

  const body = formatRememberBody({ x, y, width, height });

  // 文件里还没有记忆块：连同说明注释一起追加到末尾
  if (!/^remember:[ \t]*$/m.test(text)) {
    const appended = [...REMEMBER_COMMENT, ...body];
    fs.writeFileSync(
      CONFIG_PATH,
      `${text.replace(/\s*$/, '')}\n\n${appended.join('\n')}\n`,
      'utf8'
    );
    return;
  }

  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^remember:[ \t]*$/.test(line));

  // 一并纳入紧邻上方的说明注释，让「说明注释 + 块体」始终规整为一份
  // （同时清掉早期版本可能堆积的重复注释）
  let head = start;
  while (head - 1 >= 0 && REMEMBER_COMMENT.includes(lines[head - 1])) head -= 1;

  // 记忆块的结束位置：下一个顶格（非缩进、非空）的行
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === '' || /^[ \t]/.test(line)) end += 1;
    else break;
  }
  // 不吞掉块尾空行，保持原有段落间隔
  while (end - 1 > start && lines[end - 1].trim() === '') end -= 1;

  const replacement = head < start ? [...REMEMBER_COMMENT, ...body] : body;
  lines.splice(head, end - head, ...replacement);
  fs.writeFileSync(CONFIG_PATH, lines.join('\n'), 'utf8');
}

module.exports = {
  CONFIG_ROOT,
  CONFIG_PATH,
  DEFAULTS,
  TEMPLATE,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  ensureConfig,
  loadConfig,
  saveProgress,
  saveWindowState,
};
