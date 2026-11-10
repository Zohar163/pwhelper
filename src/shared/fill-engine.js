/**
 * 填充引擎（运行在页面上下文）：
 *  - 用原生 setter 赋值并派发 input/change/keyup，兼容 React / Vue 受控表单
 *  - 支持等待元素出现（轮询 + MutationObserver 及时唤醒）
 *  - 支持逐项延迟与填完自动提交
 */
(function (global) {
  'use strict';

  var PW = (global.PW = global.PW || {});
  var util = PW.util;
  var locator = PW.locator;
  var fill = (PW.fill = {});

  function valueSetter(el) {
    var proto = null;
    if (el instanceof global.HTMLTextAreaElement) proto = global.HTMLTextAreaElement.prototype;
    else if (el instanceof global.HTMLSelectElement) proto = global.HTMLSelectElement.prototype;
    else if (el instanceof global.HTMLInputElement) proto = global.HTMLInputElement.prototype;
    if (proto) {
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) return desc.set;
    }
    return null;
  }

  /**
   * 给元素赋值并派发事件
   * @returns {boolean} 是否成功
   */
  fill.setValue = function (el, value) {
    if (!el) return false;
    var text = value == null ? '' : String(value);

    try { el.focus && el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }

    if (el.getAttribute && el.getAttribute('contenteditable') !== null &&
        (el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '')) {
      el.textContent = text;
      el.dispatchEvent(new global.Event('input', { bubbles: true }));
      el.dispatchEvent(new global.Event('blur', { bubbles: true }));
      return true;
    }

    if (el instanceof global.HTMLSelectElement) {
      // select：优先按 value 匹配，其次按可见文本匹配
      var opts = Array.prototype.slice.call(el.options || []);
      var hit = opts.filter(function (o) { return o.value === text; })[0]
        || opts.filter(function (o) { return (o.textContent || '').trim() === text; })[0];
      if (!hit) return false;
    }

    var setter = valueSetter(el);
    if (setter) {
      setter.call(el, text);
    } else {
      el.value = text;
    }

    el.dispatchEvent(new global.Event('input', { bubbles: true }));
    el.dispatchEvent(new global.Event('change', { bubbles: true }));
    el.dispatchEvent(new global.KeyboardEvent('keyup', { bubbles: true, key: 'a', keyCode: 65 }));
    try { el.blur && el.blur(); } catch (e) { /* ignore */ }
    return true;
  };

  /**
   * 等待元素出现
   * @param {Object} locators
   * @param {{times:number, intervalMs:number}} opts
   * @returns {Promise<Element|null>}
   */
  fill.waitForElement = function (locators, opts) {
    opts = opts || {};
    var times = Math.max(1, opts.times || 10);
    var interval = Math.max(50, opts.intervalMs || 400);

    return new Promise(function (resolve) {
      var finished = false;
      var timer = null;
      var observer = null;
      var pendingCheck = null;

      function done(el) {
        if (finished) return;
        finished = true;
        if (timer) clearInterval(timer);
        if (observer) observer.disconnect();
        if (pendingCheck) clearTimeout(pendingCheck);
        resolve(el || null);
      }

      function check() {
        var el = locator.resolve(document, locators);
        if (el) { done(el); return true; }
        return false;
      }

      // 首次立即检查
      if (check()) return;

      // DOM 变化时尽快复查（去抖，避免高频抖动）
      if (global.MutationObserver) {
        observer = new global.MutationObserver(function () {
          if (pendingCheck) return;
          pendingCheck = setTimeout(function () {
            pendingCheck = null;
            check();
          }, 60);
        });
        try {
          observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
        } catch (e) { observer = null; }
      }

      var n = 0;
      timer = setInterval(function () {
        if (check()) return;
        if (++n >= times) done(null);
      }, interval);

      // 总时长硬上限，避免无限等待
      setTimeout(function () { done(null); }, interval * times + 3000);
    });
  };

  /** 依次填充一组字段项 */
  fill.fillItems = function (items, opts) {
    opts = opts || {};
    var waitOpts = {
      times: opts.times || 10,
      intervalMs: opts.intervalMs || 400
    };

    var sorted = (items || []).slice().sort(function (a, b) {
      return (a.order || 0) - (b.order || 0);
    });

    var report = [];
    var lastEl = null;

    return sorted.reduce(function (chain, item) {
      return chain.then(function () {
        return fill.waitForElement(item.locators, waitOpts).then(function (el) {
          if (!el) {
            report.push({ id: item.id, label: item.label, ok: false, reason: '未找到匹配元素' });
            return null;
          }
          var ok = fill.setValue(el, item.value);
          report.push({ id: item.id, label: item.label, ok: ok, reason: ok ? '' : '赋值失败' });
          if (ok) lastEl = el;
          if (item.delayMs) return util.sleep(item.delayMs);
          return null;
        });
      });
    }, Promise.resolve()).then(function () {
      var needSubmit = sorted.some(function (it) { return it.submitAfter; });
      if (needSubmit && lastEl) fill.submitForm(lastEl);
      return report;
    });
  };

  /** 提交表单：优先点击提交按钮，其次 requestSubmit */
  fill.submitForm = function (el) {
    if (!el || !el.closest) return false;
    var form = el.closest('form');
    if (!form) {
      // 无 form 时退化为回车
      el.dispatchEvent(new global.KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }));
      return true;
    }
    try {
      var btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (btn && !btn.disabled) {
        btn.click();
        return true;
      }
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        return true;
      }
      form.dispatchEvent(new global.Event('submit', { bubbles: true, cancelable: true }));
      return true;
    } catch (e) {
      return false;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
