'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 章节标题行匹配：以「第」开头 + 中文/阿拉伯数字 + 「章」。
 * 例：第一章 阳芝武毅 / 第2015章 显光破世存
 */
const CHAPTER_RE = /^[ \t]*第[0-9零一二三四五六七八九十百千万两]+章/;

/**
 * 把 source 配置解析为实际要读取的文件绝对路径列表。
 * - 目录：读取其下所有 .txt，按文件名自然顺序排序（1-500 在 501-1000 之前）。
 * - 文件：直接加入。
 * - 相对路径：相对于 baseDir（项目根目录）。
 */
function resolveSourceFiles(source, baseDir) {
  const items = Array.isArray(source) ? source : [source];
  const files = [];

  for (const item of items) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const target = path.isAbsolute(item) ? item : path.join(baseDir, item);

    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      throw new Error(`路径不存在：${target}`);
    }

    if (stat.isDirectory()) {
      const entries = fs
        .readdirSync(target)
        .filter((name) => /\.txt$/i.test(name))
        .sort((a, b) =>
          a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
        )
        .map((name) => path.join(target, name));
      if (entries.length === 0) {
        throw new Error(`该目录下没有 .txt 文件：${target}`);
      }
      files.push(...entries);
    } else if (stat.isFile()) {
      files.push(target);
    }
  }

  return files;
}

/**
 * 将整本小说文本解析为章节数组。
 * 首个章节标题之前的内容（书名 / 作者 / 来源 / 网址）一律忽略。
 * @returns {{ index:number, title:string, paragraphs:string[] }[]}
 */
function parseChapters(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let current = null;

  for (const line of lines) {
    const clean = line.replace(/[ \t\u3000]+$/, '');

    if (CHAPTER_RE.test(clean)) {
      current = { index: chapters.length, title: clean.trim(), paragraphs: [] };
      chapters.push(current);
      continue;
    }

    if (!current) continue; // 章节标题之前的书头元信息
    if (clean.trim() === '') continue; // 空行不作为段落

    // 保留段首全角缩进（U+3000），仅去除行尾空白
    current.paragraphs.push(line.replace(/[ \t]+$/, ''));
  }

  return chapters;
}

/**
 * 读取并合并所有来源文件，解析为章节数组。
 * @throws {Error} 路径不存在 / 无 txt 文件 / 未解析到章节
 */
function loadNovel(source, baseDir) {
  const files = resolveSourceFiles(source, baseDir);
  if (files.length === 0) {
    throw new Error('尚未配置小说路径（config.yaml 里的 source 为空）');
  }

  const chunks = [];
  for (const file of files) {
    chunks.push(fs.readFileSync(file, 'utf8'));
  }

  const chapters = parseChapters(chunks.join('\n'));
  if (chapters.length === 0) {
    throw new Error(
      '未能解析出任何章节，请检查 txt 内容或章节标题格式（例如「第一章 标题」）。'
    );
  }

  return { files, chapters };
}

module.exports = { loadNovel };
