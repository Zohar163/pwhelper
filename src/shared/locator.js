/**
 * 元素定位层（运行在页面上下文）：
 *  - buildLocators(el)：一次采集多重定位信息，越稳定越靠前
 *  - resolve(doc, locators)：按优先级依次尝试，返回第一个命中的可见元素
 */
(function (global) {
  'use strict';

  var PW = (global.PW = global.PW || {});
  var util = PW.util;
  var locator = (PW.locator = {});

  var FORM_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

  locator.FORM_SELECTOR = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';

  /** 判断元素是否是可用于填充的表单控件 */
  locator.isFillable = function (el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (FORM_TAGS.indexOf(tag) !== -1) {
      if (tag === 'INPUT') {
        var t = (el.getAttribute('type') || 'text').toLowerCase();
        // 这些类型不适合文本填充
        return ['button', 'submit', 'reset', 'image', 'file', 'hidden', 'radio', 'checkbox'].indexOf(t) === -1;
      }
      return true;
    }
    var ce = el.getAttribute('contenteditable');
    return ce === 'true' || ce === '';
  };

  /** 从事件目标向上找到可填充控件 */
  locator.findFillable = function (target) {
    var el = target;
    var depth = 0;
    while (el && el.nodeType === 1 && depth < 6) {
      if (locator.isFillable(el)) return el;
      // 常见组件库用 label 包裹 input，尝试向上找一层内部的 input
      var inner = el.querySelector ? el.querySelector(locator.FORM_SELECTOR) : null;
      if (inner && locator.isFillable(inner)) return inner;
      el = el.parentElement;
      depth += 1;
    }
    return null;
  };

  function attrOf(el, name) {
    return el.getAttribute ? (el.getAttribute(name) || '') : '';
  }

  /** 稳定的 class 指纹：取前 3 个非动态 class */
  function classHint(el) {
    var cls = String(el.className || '');
    if (typeof cls !== 'string' || !cls.trim()) return '';
    var list = cls.trim().split(/\s+/).filter(function (c) {
      return c && c.length < 40 && !/\d{4,}/.test(c) && !/^(css|sc|jsx|v)-/.test(c);
    });
    return list.slice(0, 3).join(' ');
  }

  /** 生成 CSS 选择器（优先 id / name / 属性组合，其次结构路径） */
  function buildCss(el) {
    var tag = el.tagName.toLowerCase();
    if (el.id && !/^\d/.test(el.id)) {
      var escId = util.cssEscape(el.id);
      try {
        if (document.querySelectorAll('#' + escId).length === 1) return '#' + escId;
      } catch (e) { /* ignore */ }
    }

    var parts = [tag];
    var name = attrOf(el, 'name');
    if (name) parts.push('[name="' + util.attrEscape(name) + '"]');
    var type = attrOf(el, 'type');
    if (type) parts.push('[type="' + util.attrEscape(type) + '"]');
    var auto = attrOf(el, 'autocomplete');
    if (auto) parts.push('[autocomplete="' + util.attrEscape(auto) + '"]');
    if (parts.length > 1) {
      var sel = parts.join('');
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch (e) { /* ignore */ }
    }

    return buildCssPath(el);
  }

  /** 结构路径兜底：tag:nth-of-type(...) */
  function buildCssPath(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 12) {
      var tag = node.tagName.toLowerCase();
      if (node.id && !/^\d/.test(node.id)) {
        parts.unshift('#' + util.cssEscape(node.id));
        break;
      }
      var parent = node.parentElement;
      var nth = 1;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        nth = siblings.indexOf(node) + 1;
      }
      parts.unshift(tag + ':nth-of-type(' + nth + ')');
      if (!parent || parent === document.documentElement) break;
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  }

  /** 绝对路径 XPath 兜底 */
  function buildXPath(el) {
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 12) {
      var tag = node.tagName.toLowerCase();
      var parent = node.parentElement;
      var idx = 1;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        idx = siblings.indexOf(node) + 1;
      }
      parts.unshift(tag + '[' + idx + ']');
      if (!parent || parent === document.documentElement) break;
      node = parent;
      depth += 1;
    }
    return '//' + parts.join('/');
  }

  /**
   * 采集元素的多重定位信息
   * @returns {{css:string, xpath:string, attr:Object, strategies:Array}}
   */
  locator.buildLocators = function (el) {
    if (!el) return { css: '', xpath: '', attr: {}, strategies: [] };

    var tag = el.tagName.toLowerCase();
    var attrs = {
      tag: tag,
      id: attrOf(el, 'id'),
      name: attrOf(el, 'name'),
      type: attrOf(el, 'type'),
      placeholder: attrOf(el, 'placeholder'),
      'aria-label': attrOf(el, 'aria-label'),
      autocomplete: attrOf(el, 'autocomplete'),
      classHint: classHint(el)
    };
    Object.keys(attrs).forEach(function (k) { if (!attrs[k]) delete attrs[k]; });

    var strategies = [];
    function push(type, value) {
      if (!value) return;
      if (strategies.some(function (s) { return s.type === type && s.value === value; })) return;
      strategies.push({ type: type, value: value });
    }

    var css = buildCss(el);
    var xpath = buildXPath(el);

    // 1) 完整 CSS 选择器（已含 id / name / 属性组合 / 结构路径）
    push('css', css);

    // 2) 单属性定位，稳定性从高到低
    if (attrs.id) push('css', tag + '[id="' + util.attrEscape(attrs.id) + '"]');
    if (attrs.name) push('css', tag + '[name="' + util.attrEscape(attrs.name) + '"]');
    if (attrs.autocomplete) push('css', '[autocomplete="' + util.attrEscape(attrs.autocomplete) + '"]');
    if (attrs['aria-label']) push('css', '[aria-label="' + util.attrEscape(attrs['aria-label']) + '"]');
    if (attrs.placeholder) push('css', '[placeholder="' + util.attrEscape(attrs.placeholder) + '"]');
    if (attrs.name && attrs.type) {
      push('css', tag + '[name="' + util.attrEscape(attrs.name) + '"][type="' + util.attrEscape(attrs.type) + '"]');
    }

    // 3) type + class 指纹组合（必须有 class 指纹，否则会退化成过于宽泛的选择器）
    if (attrs.classHint) {
      var combo = [tag];
      if (attrs.type) combo.push('[type="' + util.attrEscape(attrs.type) + '"]');
      combo.push('[class="' + util.attrEscape(attrs.classHint) + '"]');
      push('css', combo.join(''));
    }

    // 4) XPath 兜底
    push('xpath', xpath);

    return {
      css: css,
      xpath: xpath,
      attr: attrs,
      strategies: strategies
    };
  };

  function queryOne(doc, selector, type) {
    try {
      if (type === 'xpath') {
        var res = doc.evaluate(selector, doc, null, 9 /* FIRST_ORDERED_NODE_TYPE */, null);
        return res ? res.singleNodeValue : null;
      }
      return doc.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  function isUsable(el) {
    if (!el) return false;
    if (el.disabled) return false;
    var style = global.getComputedStyle ? global.getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return true;
  }

  /**
   * 按优先级回退解析元素
   * @returns {Element|null}
   */
  locator.resolve = function (doc, locators) {
    doc = doc || document;
    var list = (locators && locators.strategies) || [];
    if (locators && locators.css && !list.length) list = [{ type: 'css', value: locators.css }];

    var fallback = null;
    for (var i = 0; i < list.length; i++) {
      var el = queryOne(doc, list[i].value, list[i].type);
      if (!el) continue;
      if (!locator.isFillable(el)) continue;
      if (isUsable(el)) return el;
      if (!fallback) fallback = el;
    }
    return fallback;
  };

  /** 猜测字段标签：placeholder / aria-label / name / id / 前后文 */
  locator.guessLabel = function (el) {
    if (!el) return '字段';
    var candidates = [
      attrOf(el, 'placeholder'),
      attrOf(el, 'aria-label'),
      attrOf(el, 'name'),
      attrOf(el, 'autocomplete'),
      attrOf(el, 'id')
    ];
    for (var i = 0; i < candidates.length; i++) {
      var c = String(candidates[i] || '').trim();
      if (!c) continue;
      if (/^(txt|input|field|tb|el)/i.test(c) && c.length < 4) continue;
      return util.truncate(c.replace(/[_-]+/g, ' ').trim(), 20);
    }
    // 尝试 label[for]
    if (el.id) {
      var lab = document.querySelector('label[for="' + util.cssEscape(el.id) + '"]');
      if (lab && lab.textContent) return util.truncate(lab.textContent.trim(), 20);
    }
    return '字段';
  };

  /** 猜测是否敏感（密码框） */
  locator.guessSensitive = function (el) {
    if (!el) return false;
    var type = (attrOf(el, 'type') || '').toLowerCase();
    if (type === 'password') return true;
    var auto = (attrOf(el, 'autocomplete') || '').toLowerCase();
    if (auto.indexOf('password') !== -1 || auto.indexOf('secret') !== -1) return true;
    var all = ((attrOf(el, 'name') || '') + ' ' + (attrOf(el, 'id') || '') + ' ' + (attrOf(el, 'placeholder') || '')).toLowerCase();
    return /pass|pwd|secret|密码|口令/.test(all);
  };

  /** 供 UI 展示的定位摘要 */
  locator.summary = function (locators) {
    var a = (locators && locators.attr) || {};
    if (a.id) return '#' + a.id;
    if (a.name) return '[name=' + a.name + ']';
    if (a.placeholder) return '「' + util.truncate(a.placeholder, 14) + '」';
    if (a['aria-label']) return '「' + util.truncate(a['aria-label'], 14) + '」';
    if (locators && locators.css) return util.truncate(locators.css, 28);
    return '未知定位';
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
