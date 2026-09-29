'use strict';

/**
 * 阅读主题表。
 *
 * 每个主题提供 5 个颜色令牌，主进程与渲染进程共用本表（单一数据源）：
 *   bg      背景色
 *   fg      正文颜色
 *   title   章节标题颜色（略高于正文的对比度）
 *   border  窗口描边颜色
 *   error   错误提示颜色
 *
 * 选色取向：低干扰、低蓝光、对比度适中，避免纯白/纯黑造成的刺眼感。
 */
const THEMES = {
  dark: {
    label: '暗色（默认）',
    bg: '#1A1A1A',
    fg: '#C8C8C8',
    title: '#E6E6E6',
    border: '#3A3A3A',
    error: '#D9534F',
  },
  light: {
    label: '亮色',
    bg: '#FFFFFF',
    fg: '#333333',
    title: '#1A1A1A',
    border: '#E3E3E3',
    error: '#C9302C',
  },
  gray: {
    label: '灰底白字',
    bg: '#383838',
    fg: '#F0F0F0',
    title: '#FFFFFF',
    border: '#4C4C4C',
    error: '#FF7A6E',
  },
  sepia: {
    label: '米黄纸感',
    bg: '#F4ECD8',
    fg: '#4A3F2F',
    title: '#2E2618',
    border: '#DCCFAF',
    error: '#B23B2E',
  },
  green: {
    label: '护眼豆沙绿',
    bg: '#C7EDCC',
    fg: '#2B3A2E',
    title: '#1B2A1F',
    border: '#A6D4AE',
    error: '#A8322A',
  },
  slate: {
    label: '石墨灰蓝',
    bg: '#1E2530',
    fg: '#C3CBD9',
    title: '#E4EAF2',
    border: '#333D4C',
    error: '#E06C75',
  },
  oled: {
    label: '纯黑高对比',
    bg: '#000000',
    fg: '#D6D6D6',
    title: '#FFFFFF',
    border: '#242424',
    error: '#FF6B60',
  },
};

const DEFAULT_THEME = 'dark';

/** 列出所有可用主题名。 */
function themeNames() {
  return Object.keys(THEMES);
}

/** 主题名是否合法。 */
function hasTheme(name) {
  return Object.prototype.hasOwnProperty.call(THEMES, name);
}

/** 取主题调色板；非法名称回退到默认主题。 */
function resolveTheme(name) {
  return hasTheme(name) ? THEMES[name] : THEMES[DEFAULT_THEME];
}

module.exports = { THEMES, DEFAULT_THEME, themeNames, hasTheme, resolveTheme };
