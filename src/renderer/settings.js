'use strict';

/**
 * 设置窗口。
 *
 * 与阅读窗口是两个独立的 BrowserWindow（原窗口通常很小，放不下表单），
 * 通过同一套 preload 白名单 API 与主进程通信：
 *   - 「应用」→ applyConfig：立即生效但**不**写入 config.yaml（预览，可整体丢弃）
 *   - 「保存」→ saveConfig：写入 config.yaml（只改改动过的键，保留手写注释）
 * 关闭窗口时未保存的预览改动由主进程丢弃。
 */
(function () {
  const api = window.readerAPI;

  const headerEl = document.getElementById('settings-header');
  const statusEl = document.getElementById('settings-status');
  const themeSelect = document.getElementById('cfg-theme');
  const fontFamilyInput = document.getElementById('cfg-fontFamily');
  const fontSizeInput = document.getElementById('cfg-fontSize');
  const lineHeightInput = document.getElementById('cfg-lineHeight');
  const opacityInput = document.getElementById('cfg-opacity');
  const opacityValueEl = document.getElementById('cfg-opacity-value');
  const sourceInput = document.getElementById('cfg-source');
  const rulesEl = document.getElementById('cfg-rules');
  const addRuleBtn = document.getElementById('cfg-add-rule');
  const applyBtn = document.getElementById('btn-apply');
  const saveBtn = document.getElementById('btn-save');
  const resetBtn = document.getElementById('btn-reset');
  const openFileBtn = document.getElementById('btn-open-file');
  const closeBtn = document.getElementById('btn-close');

  /** 最近一次生效的配置（用于填充表单、取默认值） */
  let currentConfig = null;
  /** 是否有「已改动但未保存」的内容（仅用于状态提示） */
  let dirty = false;

  /* --------------------------- 主题配色 --------------------------- */

  /**
   * 把主题调色板写入 CSS 变量。
   *
   * 下拉框与滑块等原生控件不继承 body 的 color，必须显式上色，
   * 否则在浅色/深色主题下会出现「白底浅字」这类看不清字的情况。
   * 这里把主进程下发的完整调色板（含派生色 control / hover）一并写入。
   */
  function applyPalette(cfg) {
    document.body.dataset.theme = cfg.theme || 'dark';
    const palette = cfg.palette || {};
    const root = document.documentElement;
    const set = (name, value) => {
      if (value) root.style.setProperty(name, value);
    };
    set('--bg', palette.bg);
    set('--fg', palette.fg);
    set('--fg-strong', palette.title);
    set('--border', palette.border);
    set('--error', palette.error);
    set('--control', palette.control);
    set('--hover', palette.hover);
  }

  /* --------------------------- 状态提示 --------------------------- */

  function setStatus(message, kind) {
    statusEl.textContent = message || '';
    statusEl.className = 'settings-status' + (kind ? ' ' + kind : '');
  }

  function markDirty() {
    dirty = true;
    setStatus('有未保存的改动：「应用」只预览，「保存」才写入 config.yaml。', 'hint');
  }

  /* --------------------------- 表单 --------------------------- */

  function makeInput(className, placeholder, value) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = className;
    input.placeholder = placeholder;
    input.spellcheck = false;
    if (value !== undefined && value !== null) input.value = String(value);
    input.addEventListener('input', markDirty);
    return input;
  }

  /** 追加一行正则替换规则（rule 为空表示新增空行）。 */
  function addRuleRow(rule) {
    const row = document.createElement('div');
    row.className = 'rule-row';

    row.appendChild(makeInput('rule-pattern', 'pattern（正则）', rule && rule.pattern));
    row.appendChild(makeInput('rule-replace', 'replace（可空）', rule && rule.replace));
    row.appendChild(makeInput('rule-flags', 'flags', rule && rule.flags));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost';
    remove.title = '删除该规则';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      row.remove();
      markDirty();
    });
    row.appendChild(remove);

    rulesEl.appendChild(row);
  }

  function renderRuleRows(rules) {
    rulesEl.textContent = '';
    for (const rule of Array.isArray(rules) ? rules : []) addRuleRow(rule);
  }

  /** 用给定配置填充表单。 */
  function populate(cfg) {
    currentConfig = cfg;

    themeSelect.textContent = '';
    for (const item of cfg.themeList || []) {
      const option = document.createElement('option');
      option.value = item.name;
      option.textContent = item.label;
      themeSelect.appendChild(option);
    }
    themeSelect.value = cfg.theme;

    fontFamilyInput.value = cfg.fontFamily;
    fontSizeInput.value = String(cfg.fontSize);
    lineHeightInput.value = String(cfg.lineHeight);
    opacityInput.value = String(cfg.window.opacity);
    opacityValueEl.textContent = String(cfg.window.opacity);
    sourceInput.value = Array.isArray(cfg.source) ? cfg.source.join('\n') : cfg.source || '';
    renderRuleRows(cfg.replace);

    dirty = false;
    setStatus('');
  }

  /** 把表单值收集为主进程可直接校验的 patch。 */
  function collectPatch() {
    const lines = sourceInput.value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const patch = {
      theme: themeSelect.value,
      fontFamily: fontFamilyInput.value,
      fontSize: Number(fontSizeInput.value),
      lineHeight: Number(lineHeightInput.value),
      opacity: Number(opacityInput.value),
      replace: [],
    };

    // 单行 = 单文件或目录；多行 = 文件列表。留空则保持原来源不变。
    if (lines.length === 1) patch.source = lines[0];
    else if (lines.length > 1) patch.source = lines;

    for (const row of rulesEl.querySelectorAll('.rule-row')) {
      const pattern = row.querySelector('.rule-pattern').value;
      if (!pattern.trim()) continue;
      const item = { pattern, replace: row.querySelector('.rule-replace').value };
      const flags = row.querySelector('.rule-flags').value.trim();
      if (flags) item.flags = flags;
      patch.replace.push(item);
    }

    return patch;
  }

  /** 校验表单值，返回错误文案（空串表示通过）。 */
  function validate(patch) {
    if (!(patch.fontSize > 0)) return '字号必须为正数';
    if (!(patch.lineHeight > 0)) return '行高倍数必须为正数';
    if (!(patch.opacity >= 0.3 && patch.opacity <= 1)) return '不透明度需在 0.3 ~ 1 之间';
    return '';
  }

  /* --------------------------- 应用 / 保存 --------------------------- */

  async function applySettings() {
    const patch = collectPatch();
    const error = validate(patch);
    if (error) {
      setStatus(error, 'error');
      return;
    }

    applyBtn.disabled = true;
    try {
      const res = await api.applyConfig(patch);
      if (!res || !res.ok) {
        setStatus((res && res.error) || '应用失败', 'error');
        return;
      }
      if (res.config) {
        currentConfig = res.config;
        applyPalette(res.config);
      }
      dirty = true;
      setStatus('已应用（未保存）。预览只存在于内存中，点「保存」才会写入 config.yaml。', 'hint');
    } catch (err) {
      setStatus('应用失败：' + err.message, 'error');
    } finally {
      applyBtn.disabled = false;
    }
  }

  async function saveSettings() {
    const patch = collectPatch();
    const error = validate(patch);
    if (error) {
      setStatus(error, 'error');
      return;
    }

    saveBtn.disabled = true;
    try {
      const res = await api.saveConfig(patch);
      if (!res || !res.ok) {
        setStatus((res && res.error) || '保存失败', 'error');
        return;
      }
      if (res.config) {
        currentConfig = res.config;
        applyPalette(res.config);
      }
      dirty = false;
      setStatus('已保存到 config.yaml。', 'ok');
    } catch (err) {
      setStatus('保存失败：' + err.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  }

  /**
   * 恢复默认：只把「阅读设置」的默认值填进表单并标记为未保存，
   * 由用户决定「应用」预览还是「保存」落盘——与两个按钮的语义保持一致。
   */
  function restoreDefaults() {
    const defaults = currentConfig && currentConfig.readingDefaults;
    if (!defaults) return;

    themeSelect.value = defaults.theme;
    fontFamilyInput.value = defaults.fontFamily;
    fontSizeInput.value = String(defaults.fontSize);
    lineHeightInput.value = String(defaults.lineHeight);
    opacityInput.value = String(defaults.opacity);
    opacityValueEl.textContent = String(defaults.opacity);
    renderRuleRows([]);

    markDirty();
    setStatus('已填入默认的阅读设置（未保存），小说来源保持不变。', 'hint');
  }

  async function openConfigFile() {
    try {
      const res = await api.openConfigFile();
      if (res && !res.ok) setStatus('打开 config.yaml 失败：' + (res.error || '未知错误'), 'error');
    } catch (err) {
      setStatus('打开 config.yaml 失败：' + err.message, 'error');
    }
  }

  /* --------------------- 订阅配置变更（热加载 / 预览） --------------------- */

  function subscribe() {
    if (typeof api.onConfigChanged !== 'function') return;
    api.onConfigChanged((payload) => {
      const cfg = payload && payload.config;
      if (!cfg) return;
      // 只跟随配色：外部改配置或预览主题时，设置窗口自己也要跟着变色，
      // 但不覆盖用户正在编辑的表单内容。
      applyPalette(cfg);
      if (payload.sourceChanged && !dirty) {
        setStatus('小说来源已变更，阅读窗口已重新解析小说。', 'ok');
      }
    });
  }

  /* --------------------------- 窗口拖动 --------------------------- */

  /**
   * 无边框窗口四周有系统「不可见缩放边缘」（约 8px，四角 16px）。
   * 拖动区因此留出 16px 边距，避免按下时 Windows 同时进入原生缩放循环。
   */
  const DRAG_INSET = 16;

  let dragPointerId = null;

  function dragInset() {
    const min = Math.min(window.innerWidth, window.innerHeight);
    return Math.min(DRAG_INSET, Math.max(4, Math.floor(min / 4)));
  }

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

  headerEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || dragPointerId !== null) return;
    // 标题栏里的按钮不参与拖动
    if (e.target.closest && e.target.closest('button, input, select, textarea')) return;
    if (!inDragArea(e)) return;

    dragPointerId = e.pointerId;
    try {
      document.documentElement.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    api.dragStart();
  });

  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  // 表单控件保留原生右键（便于粘贴），其余位置不弹菜单
  document.addEventListener('contextmenu', (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveSettings();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      api.closeWindow();
    }
  });

  /* --------------------------- 事件绑定 --------------------------- */

  closeBtn.addEventListener('click', () => api.closeWindow());
  applyBtn.addEventListener('click', applySettings);
  saveBtn.addEventListener('click', saveSettings);
  resetBtn.addEventListener('click', restoreDefaults);
  openFileBtn.addEventListener('click', openConfigFile);
  addRuleBtn.addEventListener('click', () => {
    addRuleRow(null);
    markDirty();
  });

  opacityInput.addEventListener('input', () => {
    opacityValueEl.textContent = opacityInput.value;
    markDirty();
  });

  for (const el of [themeSelect, fontFamilyInput, fontSizeInput, lineHeightInput, sourceInput]) {
    el.addEventListener('input', markDirty);
    el.addEventListener('change', markDirty);
  }

  /* --------------------------- 启动 --------------------------- */

  async function boot() {
    try {
      const cfg = await api.loadConfig();
      applyPalette(cfg);
      populate(cfg);
    } catch (err) {
      setStatus('读取配置失败：' + err.message, 'error');
    }
    subscribe();
  }

  boot().catch((err) => {
    setStatus('启动失败：' + (err && err.message ? err.message : String(err)), 'error');
  });
})();
