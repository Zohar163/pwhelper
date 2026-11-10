/**
 * 配置持久化层：基于 chrome.storage.local，暴露 Promise 风格 API。
 * 同时在 storage.session（不支持时回退 local）维护「拾取会话」中间态。
 */
(function (global) {
  'use strict';

  var PW = (global.PW = global.PW || {});
  var util = PW.util;
  var schema = PW.schema;

  var CONFIG_KEY = 'pwhelper.config';
  var PICK_KEY = 'pwhelper.pick';
  var AUTH_PENDING_KEY = 'pwhelper.authPending';

  var store = (PW.store = {});

  function localArea() {
    return chrome.storage.local;
  }

  function sessionArea() {
    // chrome.storage.session 需要 Chrome 102+，不支持时回退到 local
    return (chrome.storage.session && chrome.storage.session.get) ? chrome.storage.session : chrome.storage.local;
  }

  function get(area, key, fallback) {
    return new Promise(function (resolve) {
      area.get(key, function (obj) {
        if (chrome.runtime.lastError) return resolve(fallback);
        var v = obj ? obj[key] : undefined;
        resolve(v == null ? fallback : v);
      });
    });
  }

  function set(area, obj) {
    return new Promise(function (resolve, reject) {
      area.set(obj, function () {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(true);
      });
    });
  }

  /* ---------------------------------- 配置 ---------------------------------- */

  store.load = function () {
    return get(localArea(), CONFIG_KEY, null).then(function (raw) {
      if (!raw) return schema.emptyConfig();
      return schema.normalize(raw);
    });
  };

  store.save = function (config) {
    var normalized = schema.normalize(config);
    return set(localArea(), { [CONFIG_KEY]: normalized }).then(function () { return normalized; });
  };

  store.replaceAll = function (config) {
    return store.save(config);
  };

  /** 按 URL 找出匹配的站点（可多个，因支持多套方案与不同 matchMode） */
  store.matchProfiles = function (url) {
    var host = util.hostOf(url);
    if (!host) return Promise.resolve([]);
    return store.load().then(function (config) {
      return (config.profiles || []).filter(function (p) { return util.matches(p, host, url); });
    });
  };

  store.findProfile = function (profileId) {
    return store.load().then(function (config) {
      return (config.profiles || []).filter(function (p) { return p.id === profileId; })[0] || null;
    });
  };

  /** 写入一个完整 profile（同 id 覆盖，无 id 追加） */
  store.upsertProfile = function (profile) {
    return store.load().then(function (config) {
      var idx = -1;
      config.profiles.forEach(function (p, i) { if (p.id === profile.id) idx = i; });
      if (idx === -1) config.profiles.push(profile);
      else config.profiles[idx] = profile;
      return store.save(config);
    });
  };

  store.removeProfile = function (profileId) {
    return store.load().then(function (config) {
      config.profiles = (config.profiles || []).filter(function (p) { return p.id !== profileId; });
      return store.save(config);
    });
  };

  store.renameProfile = function (profileId, name, matchMode, site) {
    return store.load().then(function (config) {
      var p = (config.profiles || []).filter(function (x) { return x.id === profileId; })[0];
      if (!p) return config;
      if (name != null) p.name = String(name).trim() || p.name;
      if (matchMode) p.matchMode = matchMode;
      if (site != null) {
        var next = schema.normalizeSite(site);
        if (next) p.site = next;
      }
      p.updatedAt = util.nowIso();
      return store.save(config);
    });
  };

  /* ---------------------------------- 方案 ---------------------------------- */

  store.addScheme = function (profileId, scheme) {
    return store.load().then(function (config) {
      var p = (config.profiles || []).filter(function (x) { return x.id === profileId; })[0];
      if (!p) throw new Error('站点不存在：' + profileId);
      p.schemes = p.schemes || [];
      p.schemes.push(scheme);
      p.updatedAt = util.nowIso();
      return store.save(config);
    });
  };

  store.updateScheme = function (profileId, schemeId, patch) {
    return store.load().then(function (config) {
      var p = (config.profiles || []).filter(function (x) { return x.id === profileId; })[0];
      if (!p) throw new Error('站点不存在：' + profileId);
      var s = (p.schemes || []).filter(function (x) { return x.id === schemeId; })[0];
      if (!s) throw new Error('方案不存在：' + schemeId);
      Object.keys(patch || {}).forEach(function (k) { s[k] = patch[k]; });
      s.updatedAt = util.nowIso();
      return store.save(config);
    });
  };

  store.removeScheme = function (profileId, schemeId) {
    return store.load().then(function (config) {
      var p = (config.profiles || []).filter(function (x) { return x.id === profileId; })[0];
      if (!p) return config;
      p.schemes = (p.schemes || []).filter(function (x) { return x.id !== schemeId; });
      p.updatedAt = util.nowIso();
      return store.save(config);
    });
  };

  /* ---------------------------------- 字段项 ---------------------------------- */

  store.updateItem = function (profileId, schemeId, itemId, patch) {
    return store.load().then(function (config) {
      var p = (config.profiles || []).filter(function (x) { return x.id === profileId; })[0];
      if (!p) throw new Error('站点不存在：' + profileId);
      var s = (p.schemes || []).filter(function (x) { return x.id === schemeId; })[0];
      if (!s) throw new Error('方案不存在：' + schemeId);
      var it = (s.items || []).filter(function (x) { return x.id === itemId; })[0];
      if (!it) throw new Error('字段不存在：' + itemId);
      Object.keys(patch || {}).forEach(function (k) { it[k] = patch[k]; });
      s.updatedAt = util.nowIso();
      return store.save(config);
    });
  };

  store.removeItem = function (profileId, schemeId, itemId) {
    return store.load().then(function (config) {
      var p = (config.profiles || []).filter(function (x) { return x.id === profileId; })[0];
      if (!p) return config;
      var s = (p.schemes || []).filter(function (x) { return x.id === schemeId; })[0];
      if (!s) return config;
      s.items = (s.items || []).filter(function (x) { return x.id !== itemId; });
      s.items.forEach(function (it, i) { it.order = i; });
      return store.save(config);
    });
  };

  store.addItem = function (profileId, schemeId, item) {
    return store.load().then(function (config) {
      var p = (config.profiles || []).filter(function (x) { return x.id === profileId; })[0];
      if (!p) throw new Error('站点不存在：' + profileId);
      var s = (p.schemes || []).filter(function (x) { return x.id === schemeId; })[0];
      if (!s) throw new Error('方案不存在：' + schemeId);
      s.items = s.items || [];
      item.order = Number.isFinite(item.order) ? item.order : s.items.length;
      s.items.push(item);
      s.items.sort(function (a, b) { return a.order - b.order; });
      return store.save(config);
    });
  };

  /* ---------------------------- HTTP 认证凭据 ---------------------------- */

  /** 取或创建某个站点（site + matchMode 唯一）对应的 profile */
  store.ensureProfile = function (site, matchMode) {
    var key = String(site || '').toLowerCase() + '|' + (matchMode || 'host');
    return store.load().then(function (config) {
      var found = (config.profiles || []).filter(function (p) { return schema.siteKey(p) === key; })[0];
      if (found) return { config: config, profile: found };
      var created = schema.createProfile({ site: site, name: String(site || ''), matchMode: matchMode || 'host' });
      config.profiles = config.profiles || [];
      config.profiles.push(created);
      return { config: config, profile: created };
    });
  };

  /**
   * 记录「该站点弹出过 HTTP 原生登录框但还没录凭据」，SW 随时会被回收，
   * 所以放进 session storage，整个浏览器会话内都能提示用户。
   */
  store.markAuthPending = function (key) {
    if (!key) return Promise.resolve({});
    return get(sessionArea(), AUTH_PENDING_KEY, {}).then(function (map) {
      var next = map || {};
      next[key] = Date.now();
      return set(sessionArea(), { [AUTH_PENDING_KEY]: next }).then(function () { return next; });
    });
  };

  store.isAuthPending = function (key) {
    if (!key) return Promise.resolve(false);
    return get(sessionArea(), AUTH_PENDING_KEY, {}).then(function (map) {
      return !!(map && map[key]);
    });
  };

  store.clearAuthPending = function (key) {
    if (!key) return Promise.resolve(null);
    return get(sessionArea(), AUTH_PENDING_KEY, {}).then(function (map) {
      if (!map || !map[key]) return null;
      delete map[key];
      return set(sessionArea(), { [AUTH_PENDING_KEY]: map }).then(function () { return map; });
    });
  };

  store.setHttpAuth = function (site, opts) {
    if (!site) return Promise.reject(new Error('缺少站点信息'));
    return store.ensureProfile(site).then(function (r) {
      r.profile.httpAuth = schema.normalizeHttpAuth(Object.assign({ enabled: true }, opts || {}));
      r.profile.updatedAt = util.nowIso();
      return store.save(r.config).then(function () {
        return { profileId: r.profile.id, httpAuth: r.profile.httpAuth };
      });
    });
  };

  store.clearHttpAuth = function (profileId) {
    return store.load().then(function (config) {
      var p = (config.profiles || []).filter(function (x) { return x.id === profileId; })[0];
      if (!p) return config;
      p.httpAuth = schema.normalizeHttpAuth({});
      p.updatedAt = util.nowIso();
      return store.save(config);
    });
  };

  /* -------------------------------- 自动填充查询 ------------------------------- */

  /** 返回该 URL 下第一个开启自动填充的方案（含重试参数） */
  store.autoFillPlan = function (url) {
    var host = util.hostOf(url);
    if (!host) return Promise.resolve(null);
    return store.load().then(function (config) {
      var profiles = (config.profiles || []).filter(function (p) { return util.matches(p, host, url); });
      for (var i = 0; i < profiles.length; i++) {
        var schemes = (profiles[i].schemes || []).filter(function (s) { return s.autoFill && (s.items || []).length; });
        if (schemes.length) {
          return {
            profileId: profiles[i].id,
            profileName: profiles[i].name,
            schemeId: schemes[0].id,
            schemeName: schemes[0].name,
            retry: Object.assign({}, schema.DEFAULT_RETRY, schemes[0].retry || {}),
            items: util.clone(schemes[0].items)
          };
        }
      }
      return null;
    });
  };

  /* -------------------------------- 拾取会话 -------------------------------- */

  store.getPickSession = function () {
    return get(sessionArea(), PICK_KEY, null);
  };

  store.setPickSession = function (session) {
    if (!session) return set(sessionArea(), { [PICK_KEY]: null }).then(function () { return null; });
    return set(sessionArea(), { [PICK_KEY]: session }).then(function () { return session; });
  };

  store.clearPickSession = function () {
    return new Promise(function (resolve) {
      sessionArea().remove(PICK_KEY, function () { resolve(true); });
    });
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
