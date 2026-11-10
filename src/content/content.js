/**
 * 内容脚本入口：
 *  1) 自动填充调度（页面加载后向后台查询是否配置了自动填充方案）
 *  2) 元素拾取模式（hover 高亮 → 点击捕获 → 浮层填写标签与内容 → 保存到拾取会话）
 */
(function () {
  'use strict';

  if (window.__PW_CONTENT_LOADED__) return;
  window.__PW_CONTENT_LOADED__ = true;

  var PW = window.PW;
  if (!PW || !PW.util || !PW.locator || !PW.fill) {
    console.error('[pwhelper] 依赖脚本未正确加载');
    return;
  }

  var util = PW.util;
  var locator = PW.locator;
  var fill = PW.fill;

  var state = {
    picking: false,
    count: 0,
    schemeName: '',
    banner: null,
    box: null,
    panel: null,
    current: null,
    toastTimer: null,
    warnTimer: null
  };

  /* ================================ 通用 UI ================================ */

  /** 页面可能还没有 body（iframe 仍在加载），统一取可用根节点 */
  function root() {
    return document.body || document.documentElement;
  }

  /** 取事件最深处真实目标，可穿透 Shadow DOM */
  function realTarget(e) {
    if (e && e.composedPath) {
      var path = e.composedPath();
      if (path && path.length) return path[0];
    }
    return e && e.target;
  }

  function inShadow(node) {
    try {
      var r = node && node.getRootNode ? node.getRootNode() : null;
      return !!(r && r.nodeType === 11);
    } catch (e) {
      return false;
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function toast(message, kind) {
    if (!root()) return;
    var old = document.querySelector('.pw-toast');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var node = el('div', 'pw-toast' + (kind ? ' pw-toast-' + kind : ''), message);
    root().appendChild(node);
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 2600);
  }

  function buildBanner() {
    if (state.banner) return state.banner;
    if (!root()) return null;
    var banner = el('div', 'pw-banner');
    var dot = el('span', 'pw-banner-dot');
    var text = el('span', 'pw-banner-text', '拾取中：点击页面上的输入框，按 Esc 退出');
    var count = el('span', 'pw-banner-count', '0 项');
    var close = el('button', 'pw-banner-close', '×');
    close.addEventListener('click', function (e) {
      e.stopPropagation();
      stopPick();
    });
    banner.appendChild(dot);
    banner.appendChild(text);
    banner.appendChild(count);
    banner.appendChild(close);
    root().appendChild(banner);
    state.banner = banner;
    return banner;
  }

  function updateBanner() {
    if (!state.banner) return;
    var count = state.banner.querySelector('.pw-banner-count');
    if (count) count.textContent = state.count + ' 项';
  }

  function removeBanner() {
    if (state.banner && state.banner.parentNode) state.banner.parentNode.removeChild(state.banner);
    state.banner = null;
  }

  function ensureHighlight() {
    if (state.box) return state.box;
    if (!root()) return null;
    var box = document.createElement('div');
    box.className = 'pw-highlight';
    var tag = el('span', 'pw-highlight-tag', '');
    box.appendChild(tag);
    root().appendChild(box);
    state.box = box;
    return box;
  }

  function moveHighlight(target) {
    var box = ensureHighlight();
    if (!box) return;
    var rect = target.getBoundingClientRect();
    box.style.top = (rect.top - 3) + 'px';
    box.style.left = (rect.left - 3) + 'px';
    box.style.width = (rect.width + 6) + 'px';
    box.style.height = (rect.height + 6) + 'px';
    var tag = box.querySelector('.pw-highlight-tag');
    if (tag) {
      var a = locator.buildLocators(target).attr || {};
      tag.textContent = (target.tagName || '').toLowerCase() + (a.name ? ' · ' + a.name : '');
    }
  }

  function clearHighlight() {
    if (state.box && state.box.parentNode) state.box.parentNode.removeChild(state.box);
    state.box = null;
  }

  /* ============================== 捕获输入面板 ============================== */

  function closePanel() {
    if (state.panel && state.panel.parentNode) state.panel.parentNode.removeChild(state.panel);
    state.panel = null;
    state.current = null;
  }

  function openPanel(payload) {
    closePanel();
    state.current = payload;

    var panel = el('div', 'pw-panel');
    var title = el('div', 'pw-panel-title');
    title.appendChild(el('span', null, '记录字段'));
    title.appendChild(el('span', null, '#' + (state.count + 1)));

    var target = el('div', 'pw-panel-target');
    target.textContent = '目标：' + (payload.summary || '') + '  (' + (payload.tag || '') + ')';

    function field(labelText, inputEl) {
      var wrap = el('div', 'pw-field');
      var lab = el('label', 'pw-label', labelText);
      wrap.appendChild(lab);
      wrap.appendChild(inputEl);
      return wrap;
    }

    var schemeInput = document.createElement('input');
    schemeInput.className = 'pw-input';
    schemeInput.type = 'text';
    schemeInput.value = state.schemeName || ('方案 ' + (((payload.existingSchemes || []).length) + 1));

    var labelInput = document.createElement('input');
    labelInput.className = 'pw-input';
    labelInput.type = 'text';
    labelInput.value = payload.guessLabel || '字段';

    var valueInput = document.createElement('input');
    valueInput.className = 'pw-input';
    valueInput.type = payload.guessSensitive ? 'password' : 'text';
    valueInput.placeholder = '要填充的内容';
    valueInput.value = '';

    var checkWrap = el('label', 'pw-checkbox');
    var check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = !!payload.guessSensitive;
    check.addEventListener('change', function () {
      valueInput.type = check.checked ? 'password' : 'text';
    });
    checkWrap.appendChild(check);
    checkWrap.appendChild(el('span', null, '敏感内容（列表中掩码显示）'));

    var actions = el('div', 'pw-actions');
    var btnSaveNext = el('button', 'pw-btn pw-btn-primary', '保存，继续拾取');
    var btnFinish = el('button', 'pw-btn pw-btn-ghost', '完成');
    var btnCancel = el('button', 'pw-btn pw-btn-ghost', '放弃');
    actions.appendChild(btnSaveNext);
    actions.appendChild(btnFinish);
    actions.appendChild(btnCancel);

    panel.appendChild(title);
    panel.appendChild(target);
    panel.appendChild(field('方案名称', schemeInput));
    panel.appendChild(field('字段标签', labelInput));
    panel.appendChild(field('填充内容', valueInput));
    panel.appendChild(checkWrap);
    panel.appendChild(actions);

    btnSaveNext.addEventListener('click', function () {
      state.schemeName = schemeInput.value.trim();
      commitItem({
        label: labelInput.value.trim() || '字段',
        value: valueInput.value,
        sensitive: check.checked
      }, false);
    });

    btnFinish.addEventListener('click', function () {
      state.schemeName = schemeInput.value.trim();
      commitItem({
        label: labelInput.value.trim() || '字段',
        value: valueInput.value,
        sensitive: check.checked
      }, true);
    });

    btnCancel.addEventListener('click', function () {
      closePanel();
      toast('已放弃本次捕获');
    });

    root().appendChild(panel);
    state.panel = panel;
    labelInput.focus();
  }

  function commitItem(patch, finish) {
    if (!state.current) return;
    var item = {
      label: patch.label,
      value: patch.value,
      sensitive: patch.sensitive,
      order: state.count,
      delayMs: 0,
      submitAfter: false,
      locators: state.current.locators,
      meta: { summary: state.current.summary, tag: state.current.tag }
    };

    util.sendMessage({
      type: 'PW_PICK_ADD',
      item: item,
      schemeName: state.schemeName,
      autoFill: false
    }).then(function (res) {
      if (!res || !res.ok) {
        toast((res && res.error) || '保存失败，请重试', 'err');
        return;
      }
      state.count = res.count;
      updateBanner();
      closePanel();
      if (finish) {
        util.sendMessage({
          type: 'PW_PICK_FINISH',
          schemeName: state.schemeName,
          autoFill: false
        }).then(function (r) {
          stopPick(true);
          if (r && r.ok) toast('已保存 ' + (r.count || 0) + ' 个字段', 'ok');
          else toast((r && r.error) || '保存失败', 'err');
        });
      } else {
        toast('已记录：' + item.label);
      }
    });
  }

  /* ================================ 拾取模式 ================================ */

  function warnOnce(message) {
    if (state.warnTimer) return;
    toast(message, 'err');
    state.warnTimer = setTimeout(function () { state.warnTimer = null; }, 3000);
  }

  function onMouseMove(e) {
    if (!state.picking) return;
    var t = realTarget(e);
    if (t && t.closest && t.closest('.pw-panel, .pw-banner')) {
      clearHighlight();
      return;
    }
    // 指针进入 iframe：交给那个 frame 显示 UI，本层隐藏，避免同屏出现两套拾取 UI
    if (t && t.tagName === 'IFRAME') {
      removeBanner();
      clearHighlight();
      return;
    }
    // 鼠标在哪个 frame 里动，哪个 frame 才进入可视化状态
    showPickUI();
    var target = locator.findFillable(t);
    if (!target) {
      clearHighlight();
      return;
    }
    moveHighlight(target);
  }

  function onClick(e) {
    if (!state.picking) return;
    var t = realTarget(e);
    if (t && t.closest && t.closest('.pw-panel, .pw-banner')) return;

    e.preventDefault();
    e.stopPropagation();

    var target = locator.findFillable(t);
    if (!target) {
      toast('请选择输入框 / 文本域 / 下拉框', 'err');
      return;
    }
    // Shadow DOM 内部的元素无法用跨根节点的选择器复原，记录也没有意义，直接提示
    if (inShadow(target)) {
      warnOnce('该输入框位于 Shadow DOM 内部，暂无法记录');
      return;
    }

    var locators = locator.buildLocators(target);
    openPanel({
      locators: locators,
      summary: locator.summary(locators),
      tag: (target.tagName || '').toLowerCase(),
      guessLabel: locator.guessLabel(target),
      guessSensitive: locator.guessSensitive(target),
      existingSchemes: state.existingSchemes || []
    });
    clearHighlight();
  }

  function onKeyDown(e) {
    if (!state.picking) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (state.panel) { closePanel(); return; }
      stopPick();
    }
  }

  var throttledMove = util.throttle(onMouseMove, 60);

  /**
   * 显示拾取 UI。延迟到鼠标真正进入本 frame 才显示，
   * 避免多 frame 页面同时弹出多个提示条。
   */
  function showPickUI() {
    if (!state.picking) return;
    if (state.banner) { updateBanner(); return; }
    buildBanner();
    updateBanner();
    // 字段可能刚在别的 frame 里捕获过，这里同步一次计数
    util.sendMessage({ type: 'PW_PICK_GET' }).then(function (res) {
      if (res && res.ok && res.session) {
        state.count = (res.session.items || []).length;
        if (res.session.schemeName) state.schemeName = res.session.schemeName;
      }
      updateBanner();
    });
  }

  function startPick(session) {
    if (state.picking) return;
    state.picking = true;
    state.count = (session && session.items ? session.items.length : 0) || 0;
    state.schemeName = (session && session.schemeName) || '';
    state.existingSchemes = (session && session.existingSchemes) || [];
    document.addEventListener('mousemove', throttledMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function stopPick(silent) {
    if (!state.picking) return;
    state.picking = false;
    document.removeEventListener('mousemove', throttledMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    closePanel();
    clearHighlight();
    removeBanner();
    if (state.warnTimer) { clearTimeout(state.warnTimer); state.warnTimer = null; }
    if (!silent) {
      util.sendMessage({ type: 'PW_PICK_CANCEL' });
      toast('已退出拾取模式');
    }
  }

  /* ================================ 填充执行 ================================ */

  function runFill(items, opts) {
    if (!items || !items.length) return Promise.resolve([]);
    return fill.fillItems(items, opts || {});
  }

  /* ================================ 消息路由 ================================ */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'PW_PING':
        sendResponse({ ok: true });
        break;

      case 'PW_START_PICK':
        startPick(msg.session);
        sendResponse({ ok: true });
        break;

      case 'PW_STOP_PICK':
        stopPick(true);
        sendResponse({ ok: true });
        break;

      case 'PW_FILL':
        runFill(msg.items, msg.retry).then(function (report) {
          sendResponse({ ok: true, report: report });
          // 本 frame 只填了部分字段时，额外汇报结果供后台跨 frame 汇总
          if (msg.requestId) {
            util.sendMessage({ type: 'PW_FILL_REPORT', requestId: msg.requestId, report: report });
          }
        }).catch(function (err) {
          sendResponse({ ok: false, error: String((err && err.message) || err) });
        });
        return true;

      default:
        break;
    }
  });

  /* ================================== 启动 ================================== */

  // 本脚本只在用户点开插件、需要拾取或填充时才被注入，注入后保持待命即可，
  // 不会在每个网站上常驻运行，也不主动读写页面。
})();
