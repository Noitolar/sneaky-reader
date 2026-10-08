'use strict';

(function () {
  /** preload 通过 contextBridge 暴露的白名单 API */
  const api = window.readerAPI;
  const readerEl = document.getElementById('reader');
  const contentEl = document.getElementById('content');

  /** 同时渲染的章节数（当前章节居中，上下留出缓冲，避免滚动到边界时卡顿） */
  const SPAN = 5;
  /** 重新选取渲染窗口时，当前章节距窗口起点的目标位置 */
  const EDGE = 2;

  /** 全量章节数据（主进程一次性下发，渲染层按窗口懒渲染） */
  let chapters = [];
  /** 当前已渲染的章节区间起始索引 */
  let windowStart = -1;
  /** 逐行滚动步长 = 字号 × 行高 */
  let lineStep = 17;
  /** 当前阅读锚点：{ chapter, paragraph, isTitle } */
  let currentAnchor = { chapter: 0, paragraph: 0, isTitle: true };

  let saveTimer = null;
  let scrollThrottleTimer = null;
  let lastScrollHandledAt = 0;
  let resizing = false;
  let resizeTimer = null;
  let savedAnchor = null;
  let booted = false;

  /** 锚点索引：仅在渲染窗口内有效，重渲染时重建 */
  const paraMap = new Map(); // `${chapter}:${paragraph}` -> 段落元素
  const titleMap = new Map(); // `${chapter}` -> 章节标题元素

  /* --------------------------- 正则替换 --------------------------- */

  /**
   * 已编译的显示层替换规则（来自 config.yaml 的 replace）。
   *
   * 规则在渲染时按顺序应用到「标题 + 段落」的文本上，只改变显示内容：
   * - 章节数组与段落索引始终是原始数据，因此阅读进度、章节识别都不受规则影响；
   *   改动规则后重开，进度仍指向同一段原文。
   * - 每次只对当前渲染窗口内的几百个段落执行替换，开销可以忽略。
   */
  let compiledRules = [];

  /** 编译规则；主进程已过滤过非法正则，这里再兜一层，避免一条坏规则导致白屏。 */
  function compileRules(list) {
    const rules = [];
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item.pattern !== 'string' || !item.pattern) continue;
      try {
        rules.push({
          re: new RegExp(
            item.pattern,
            typeof item.flags === 'string' && item.flags ? item.flags : 'g'
          ),
          to: typeof item.replace === 'string' ? item.replace : '',
        });
      } catch (err) {
        console.warn('[reader] 忽略无效的替换规则：', item.pattern, err.message);
      }
    }
    return rules;
  }

  /** 按顺序应用替换规则，返回用于显示的文本。 */
  function applyRules(text) {
    if (compiledRules.length === 0) return text;
    let out = text;
    for (const rule of compiledRules) {
      out = out.replace(rule.re, rule.to);
    }
    return out;
  }

  /** 替换后只剩空白（含全角空格）时，该段整体隐藏。 */
  function isBlank(text) {
    return text.trim() === '';
  }

  /* --------------------------- 启动流程 --------------------------- */

  async function boot() {
    let cfg;
    try {
      cfg = await api.loadConfig();
    } catch (err) {
      renderError('读取配置失败：' + err.message);
      return;
    }
    applyConfig(cfg);

    let novel;
    try {
      novel = await api.loadNovel();
    } catch (err) {
      renderError('读取小说失败：' + err.message);
      return;
    }

    if (!novel.ok) {
      renderError(novel.error || '未知错误');
      return;
    }

    chapters = novel.chapters || [];
    if (chapters.length === 0) {
      renderError('（空）未解析到任何章节内容。');
      return;
    }

    const restore = novel.restore || { chapter: 0, paragraph: 0 };
    const chapter = Number.isInteger(restore.chapter) ? restore.chapter : 0;
    const paragraph = Number.isInteger(restore.paragraph) ? restore.paragraph : 0;
    currentAnchor = {
      chapter: clampChapter(chapter),
      paragraph: Math.max(0, paragraph),
      isTitle: paragraph <= 0,
    };

    // 样式表已就绪，直接渲染并定位（getBoundingClientRect 会强制同步布局）
    setTimeout(() => {
      focusAnchor(currentAnchor, 0);
      booted = true;
      readerEl.focus();
      console.log(
        `[reader] 已渲染第 ${windowStart + 1} 章起共 ${Math.min(
          SPAN,
          chapters.length - windowStart
        )} 章，恢复至 章节 ${currentAnchor.chapter} / 段落 ${currentAnchor.paragraph}`
      );
    }, 0);
  }

  /** 应用主题调色板、字体族、字号、行高与正则替换规则（并同步滚动步长）。 */
  function applyConfig(cfg) {
    document.body.dataset.theme = cfg.theme;

    const root = document.documentElement;
    root.style.setProperty('--font-family', cfg.fontFamily);
    root.style.setProperty('--font-size', cfg.fontSize + 'px');
    root.style.setProperty('--line-height', String(cfg.lineHeight));

    // 主题调色板由主进程下发（与窗口底色同源，避免加载时闪色）
    const palette = cfg.palette || {};
    if (palette.bg) root.style.setProperty('--bg', palette.bg);
    if (palette.fg) root.style.setProperty('--fg', palette.fg);
    if (palette.title) root.style.setProperty('--fg-strong', palette.title);
    if (palette.border) root.style.setProperty('--border', palette.border);
    if (palette.error) root.style.setProperty('--error', palette.error);

    lineStep = Math.max(1, Math.round(cfg.fontSize * cfg.lineHeight));

    // 正则替换规则：只作用于随后渲染出来的文字
    compiledRules = compileRules(cfg.replace);
    if (compiledRules.length > 0) {
      console.log(`[reader] 已启用 ${compiledRules.length} 条正则替换规则`);
    }
  }

  /* --------------------------- 渲染 --------------------------- */

  function renderError(message) {
    paraMap.clear();
    titleMap.clear();
    contentEl.textContent = '';
    const node = document.createElement('div');
    node.className = 'para error';
    node.textContent = String(message);
    contentEl.appendChild(node);
  }

  function clampChapter(index) {
    if (chapters.length === 0) return 0;
    return Math.min(Math.max(index, 0), chapters.length - 1);
  }

  /** 渲染 [start, start + SPAN) 章节区间。 */
  function renderRange(start) {
    const end = Math.min(start + SPAN, chapters.length);
    paraMap.clear();
    titleMap.clear();

    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i += 1) {
      const chapter = chapters[i];

      const title = document.createElement('div');
      title.className = 'chapter-title';
      title.dataset.chapter = String(chapter.index);
      // 标题同样过一遍替换规则；即使被替换成空也保留节点，避免章节锚点取不到元素
      title.textContent = applyRules(chapter.title);
      frag.appendChild(title);
      titleMap.set(String(chapter.index), title);

      const paragraphs = chapter.paragraphs || [];
      for (let j = 0; j < paragraphs.length; j += 1) {
        const text = applyRules(paragraphs[j]);
        // 规则把整段替换成空白时隐藏该段（不留空行）。
        // 注意：段落序号 j 仍按原文计数，因此进度锚点不会因规则而错位。
        if (isBlank(text)) continue;

        const p = document.createElement('div');
        p.className = 'para';
        p.dataset.chapter = String(chapter.index);
        p.dataset.para = String(j);
        p.textContent = text;
        frag.appendChild(p);
        paraMap.set(chapter.index + ':' + j, p);
      }
    }

    contentEl.textContent = '';
    contentEl.appendChild(frag);
  }

  /** 若目标章节不在当前渲染窗口内，则重新选取并渲染窗口。 */
  function ensureWindow(anchor) {
    const total = chapters.length;
    if (total === 0) return;
    const maxStart = Math.max(total - SPAN, 0);
    const start = Math.min(Math.max(anchor.chapter - EDGE, 0), maxStart);
    if (start !== windowStart) {
      renderRange(start);
      windowStart = start;
    }
  }

  /* --------------------------- 锚点定位 --------------------------- */

  function elementFor(anchor) {
    if (anchor.isTitle) {
      return (
        titleMap.get(String(anchor.chapter)) ||
        paraMap.get(anchor.chapter + ':0') ||
        null
      );
    }
    // 目标段落可能被替换规则整段隐藏：向前找最近的可见段，
    // 再退化为章节标题，保证进度仍落在同一章内。
    for (let j = anchor.paragraph; j >= 0; j -= 1) {
      const el = paraMap.get(anchor.chapter + ':' + j);
      if (el) return el;
    }
    return titleMap.get(String(anchor.chapter)) || null;
  }

  /** 保证窗口存在并把 anchor 定位到视口顶部（可保留像素偏移）。 */
  function focusAnchor(anchor, pixelOffset) {
    ensureWindow(anchor);
    const target = elementFor(anchor);
    if (!target) return false;

    const delta =
      target.getBoundingClientRect().top -
      readerEl.getBoundingClientRect().top -
      pixelOffset;
    readerEl.scrollTop += delta;
    currentAnchor = { ...anchor };
    return true;
  }

  /** 跳到指定章节的开头（PageUp / PageDown 用），越界自动夹取。 */
  function goToChapter(index) {
    const target = Math.min(Math.max(index, 0), chapters.length - 1);
    if (target === currentAnchor.chapter) return;
    focusAnchor({ chapter: target, paragraph: 0, isTitle: true }, 0);
    flushSave();
  }

  /** 二分查找视口顶部的元素（子节点顺序即阅读顺序）。 */
  function findTopElement() {
    const children = contentEl.children;
    if (children.length === 0) return null;

    const readerTop = readerEl.getBoundingClientRect().top;
    let lo = 0;
    let hi = children.length - 1;
    let idx = children.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const rect = children[mid].getBoundingClientRect();
      if (rect.bottom > readerTop + 1) {
        idx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    return children[idx];
  }

  /** 把 DOM 元素换算为锚点对象。 */
  function anchorFromElement(el) {
    const isTitle = el.dataset.para === undefined;
    return {
      chapter: Number(el.dataset.chapter) || 0,
      paragraph: isTitle ? 0 : Number(el.dataset.para) || 0,
      isTitle,
    };
  }

  /* --------------------------- 滚动处理 --------------------------- */

  function handleScroll() {
    if (!booted || resizing) return;
    const el = findTopElement();
    if (!el) return;

    const anchor = anchorFromElement(el);
    const pixelOffset = el.getBoundingClientRect().top - readerEl.getBoundingClientRect().top;
    currentAnchor = anchor;

    const total = chapters.length;
    const maxStart = Math.max(total - SPAN, 0);
    // 当前章节已贴近渲染窗口边缘时，重新选取窗口（保留像素偏移，视觉无跳动）
    if (total > SPAN && (anchor.chapter <= windowStart || anchor.chapter >= windowStart + SPAN - 1)) {
      const desired = Math.min(Math.max(anchor.chapter - EDGE, 0), maxStart);
      if (desired !== windowStart) {
        renderRange(desired);
        windowStart = desired;
        focusAnchor(anchor, pixelOffset);
        currentAnchor = anchor;
      }
    }

    scheduleSave();
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      api
        .saveProgress(currentAnchor.chapter, currentAnchor.paragraph)
        .catch((err) => console.error('[progress] 保存失败：', err));
    }, 800);
  }

  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    api
      .saveProgress(currentAnchor.chapter, currentAnchor.paragraph)
      .catch(() => {});
  }

  /* --------------------------- 事件绑定 --------------------------- */

  readerEl.addEventListener(
    'scroll',
    () => {
      if (!booted || resizing) return;
      // 基于时间的节流（不使用 rAF：窗口被遮挡时 rAF 会被挂起）
      const now = Date.now();
      if (now - lastScrollHandledAt >= 50) {
        lastScrollHandledAt = now;
        handleScroll();
        return;
      }
      if (scrollThrottleTimer) return;
      scrollThrottleTimer = setTimeout(() => {
        scrollThrottleTimer = null;
        lastScrollHandledAt = Date.now();
        handleScroll();
      }, 50);
    },
    { passive: true }
  );

  window.addEventListener('keydown', (e) => {
    if (!booted) return;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        readerEl.scrollTop += lineStep;
        break;
      case 'ArrowUp':
        readerEl.scrollTop -= lineStep;
        break;
      case 'PageDown':
        goToChapter(currentAnchor.chapter + 1);
        break;
      case 'PageUp':
        goToChapter(currentAnchor.chapter - 1);
        break;
      // Home / End 已不再是快捷键。这里显式吞掉按键：否则会落到浏览器默认的
      // 「滚动到文档首/尾」行为上，把阅读位置带跑。
      case 'Home':
      case 'End':
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  });

  readerEl.addEventListener(
    'wheel',
    (e) => {
      if (!booted) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
      if (dir !== 0) readerEl.scrollTop += dir * lineStep;
    },
    { passive: false }
  );

  /* --------------------- 宽度变化：重排并保持章节 --------------------- */

  window.addEventListener('resize', () => {
    if (!booted) return;
    if (!resizing) {
      resizing = true;
      savedAnchor = { ...currentAnchor };
    }
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (savedAnchor) {
        // 重排完成后回到原章节/段落，保证「宽度变化后仍停留在当前章节」
        focusAnchor(savedAnchor, 0);
      }
      resizing = false;
      savedAnchor = null;
      scheduleSave();
    }, 140);
  });

  /* ------------------ 拖动移动 + 双击最小化 ------------------ */

  /**
   * 窗口四周存在系统「不可见缩放边缘」（约 8px，四角 16px）。
   * 拖动区必须避开该区域，否则按下时 Windows 会同时进入原生缩放循环，
   * 与拖动定位互相打架，导致窗口被越拉越大。边缘留给系统缩放。
   */
  const DRAG_INSET = 16;

  let dragPointerId = null;

  function dragInset() {
    const min = Math.min(window.innerWidth, window.innerHeight);
    return Math.min(DRAG_INSET, Math.max(4, Math.floor(min / 4)));
  }

  /** 判定按下点是否落在「可拖动内区」。 */
  function inDragArea(e) {
    const inset = dragInset();
    return (
      e.clientX >= inset &&
      e.clientX <= window.innerWidth - inset &&
      e.clientY >= inset &&
      e.clientY <= window.innerHeight - inset
    );
  }

  function endDrag() {
    if (dragPointerId === null) return;
    const id = dragPointerId;
    dragPointerId = null;
    try {
      document.documentElement.releasePointerCapture(id);
    } catch {
      /* 指针可能已释放，忽略 */
    }
    api.dragEnd();
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || dragPointerId !== null) return;
    // 落在窗口边缘：交给系统原生缩放，不启动拖动
    if (!inDragArea(e)) return;

    dragPointerId = e.pointerId;
    try {
      // 指针捕获：即使光标移出窗口也能收到 pointerup，避免拖动卡住
      document.documentElement.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    api.dragStart();
  });

  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  // 兜底：失焦（如被最小化）时结束拖动并落盘进度
  window.addEventListener('blur', () => {
    endDrag();
    if (booted) flushSave();
  });
  document.addEventListener('visibilitychange', () => {
    if (booted && document.hidden) flushSave();
  });

  /* ---------- 鼠标双击：左键双击关闭窗口 ---------- */

  // 无标题栏窗口不需要右键菜单
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  // 左键双击窗口任意位置关闭窗口。
  // 走 close()，主进程的 close 处理会先把窗口位置与尺寸落盘。
  document.addEventListener('dblclick', (e) => {
    if (e.button !== 0) return;
    api.closeWindow();
  });

  // 关闭/失焦前落盘，保证进度不丢失
  window.addEventListener('beforeunload', flushSave);

  boot().catch((err) => {
    console.error('[reader] 启动失败：', err);
    renderError('启动失败：' + (err && err.message ? err.message : err));
  });
})();
