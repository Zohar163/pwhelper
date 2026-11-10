/**
 * 通用工具层：可同时被 content script / popup / service worker 加载的经典脚本。
 * 通过全局命名空间 PW 共享，避免 MV3 下模块格式差异。
 */
(function (global) {
  'use strict';

  var PW = (global.PW = global.PW || {});
  var util = (PW.util = {});

  util.APP = 'pwhelper';

  /** 生成短唯一 id */
  util.uid = function (prefix) {
    var rand = Math.random().toString(36).slice(2, 8);
    return (prefix || 'id') + '_' + Date.now().toString(36).slice(-5) + rand;
  };

  util.nowIso = function () {
    return new Date().toISOString();
  };

  /** 文件时间戳：YYYYMMDD-HHmm */
  util.fileStamp = function (date) {
    var d = date || new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  };

  /** 从 URL 取 hostname */
  util.hostOf = function (url) {
    try {
      return new URL(url).hostname || '';
    } catch (e) {
      return '';
    }
  };

  /** 协议默认端口 */
  util.defaultPortOf = function (url) {
    try {
      var u = new URL(url);
      if (u.protocol === 'https:') return '443';
      if (u.protocol === 'http:') return '80';
      return '';
    } catch (e) {
      return '';
    }
  };

  /** 主机名 + 端口（端口缺省时补成协议默认端口，便于和 site 比较） */
  util.hostPortOf = function (url) {
    try {
      var u = new URL(url);
      var p = u.port || util.defaultPortOf(url);
      return p ? (u.hostname + ':' + p).toLowerCase() : u.hostname.toLowerCase();
    } catch (e) {
      return '';
    }
  };

  /** 展示 / 存储用的站点标识：默认端口省略，非默认端口显式带出 */
  util.prettyHost = function (url) {
    try {
      var u = new URL(url);
      if (!u.port || u.port === util.defaultPortOf(url)) return u.hostname.toLowerCase();
      return (u.hostname + ':' + u.port).toLowerCase();
    } catch (e) {
      return util.hostOf(url);
    }
  };

  /**
   * 站点匹配
   * matchMode: host(主机名+端口) | domain(主域名及其子域名) | prefix(URL 前缀)
   * site 可写成 "example.com"（匹配该协议的默认端口）或 "example.com:8080"（只匹配该端口）
   */
  util.MATCH_MODES = [
    { value: 'host', label: '主机名 + 端口' },
    { value: 'domain', label: '主域名含子域名' },
    { value: 'prefix', label: 'URL 前缀' }
  ];

  util.matches = function (profile, host, url) {
    var site = String((profile && profile.site) || '').toLowerCase().trim();
    if (!site) return false;

    var h = String(host || util.hostOf(url) || '').toLowerCase();
    var u = String(url || '').toLowerCase();
    var mode = (profile && profile.matchMode) || 'host';

    if (mode === 'prefix') {
      return u.indexOf(site) === 0 || h.indexOf(site) === 0;
    }

    var colonPos = site.lastIndexOf(':');
    var siteHasPort = colonPos !== -1;
    var siteHost = siteHasPort ? site.slice(0, colonPos) : site;

    if (mode === 'domain') {
      return h === siteHost || h.endsWith('.' + siteHost);
    }

    // host：主机名 + 端口。site 未写端口时，按当前 URL 协议的默认端口匹配
    var hostPort = util.hostPortOf(url);
    if (!hostPort) return h === siteHost;
    return hostPort === site || (!siteHasPort && hostPort === site + ':' + util.defaultPortOf(url));
  };

  /** 域名匹配的友好描述 */
  util.describeMatch = function (profile) {
    var mode = (profile && profile.matchMode) || 'host';
    if (mode === 'domain') return '含子域名';
    if (mode === 'prefix') return 'URL 前缀';
    var site = String((profile && profile.site) || '');
    return site.indexOf(':') === -1 ? '主机 + 默认端口' : '主机 + 端口';
  };

  util.throttle = function (fn, wait) {
    var last = 0;
    var timer = null;
    var lastArgs = null;
    return function () {
      lastArgs = arguments;
      var now = Date.now();
      var remaining = wait - (now - last);
      if (remaining <= 0) {
        if (timer) { clearTimeout(timer); timer = null; }
        last = now;
        fn.apply(null, lastArgs);
      } else if (!timer) {
        timer = setTimeout(function () {
          timer = null;
          last = Date.now();
          fn.apply(null, lastArgs);
        }, remaining);
      }
    };
  };

  util.sleep = function (ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms || 0); });
  };

  util.escapeHtml = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  /** CSS 标识符转义（选择器拼接用） */
  util.cssEscape = function (s) {
    var str = String(s == null ? '' : s);
    if (global.CSS && typeof global.CSS.escape === 'function') return global.CSS.escape(str);
    return str.replace(/["\\]/g, '\\$&');
  };

  /** 属性值转义（用于 [attr="value"]） */
  util.attrEscape = function (s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  };

  /** XPath 字符串字面量转义 */
  util.xpathQuote = function (s) {
    var str = String(s == null ? '' : s);
    if (str.indexOf("'") === -1) return "'" + str + "'";
    if (str.indexOf('"') === -1) return '"' + str + '"';
    var parts = str.split("'");
    return 'concat(' + parts.map(function (p) { return "'" + p + "'"; }).join(',"\'",') + ')';
  };

  /** 敏感值掩码 */
  util.mask = function (v) {
    var s = String(v == null ? '' : v);
    if (!s) return '';
    if (s.length <= 4) return '••••';
    return s.slice(0, 2) + '••••' + s.slice(-2);
  };

  util.clone = function (obj) {
    return obj == null ? obj : JSON.parse(JSON.stringify(obj));
  };

  util.truncate = function (s, n) {
    var str = String(s == null ? '' : s);
    return str.length > n ? str.slice(0, n) + '…' : str;
  };

  /** Promise 版 sendMessage，自动吞掉 "接收端不存在" 类错误 */
  util.sendMessage = function (msg) {
    if (!global.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      return Promise.resolve(null);
    }
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res);
        });
      } catch (e) {
        resolve(null);
      }
    });
  };

  util.sendTabMessage = function (tabId, msg) {
    if (!global.chrome || !chrome.tabs || !chrome.tabs.sendMessage) {
      return Promise.resolve(null);
    }
    return new Promise(function (resolve) {
      try {
        chrome.tabs.sendMessage(tabId, msg, function (res) {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res);
        });
      } catch (e) {
        resolve(null);
      }
    });
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
