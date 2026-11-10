/**
 * 配置结构定义、默认值工厂、导入校验与规范化。
 * 结构：profiles(站点) -> schemes(方案) -> items(字段项)
 */
(function (global) {
  'use strict';

  var PW = (global.PW = global.PW || {});
  var util = PW.util || {};
  var schema = (PW.schema = {});

  schema.APP = 'pwhelper';
  schema.VERSION = 1;

  schema.DEFAULT_RETRY = { times: 10, intervalMs: 400, initialDelayMs: 600 };

  /** 允许手写 "https://example.com:8080/" 这类写法，统一成 "example.com:8080" */
  schema.normalizeSite = function (site) {
    var s = String(site == null ? '' : site).trim().replace(/\/+$/, '');
    if (s.indexOf('//') !== -1) {
      try { return util.prettyHost(s) || s; } catch (e) { /* 保持原样 */ }
    }
    return s;
  };

  /**
   * 在配置里找出该 URL 可用的 HTTP 认证凭据（第一个匹配且已启用的站点）。
   * 纯函数，方便单测；service worker 用缓存的 config 同步调用。
   */
  schema.httpAuthFor = function (config, url) {
    var host = util.hostOf(url);
    if (!host) return null;
    var list = ((config && config.profiles) || []).filter(function (p) { return util.matches(p, host, url); });
    for (var i = 0; i < list.length; i++) {
      var a = schema.normalizeHttpAuth(list[i].httpAuth);
      if (a.enabled && a.username) {
        return { profileId: list[i].id, username: a.username, password: a.password };
      }
    }
    return null;
  };

  /**
   * HTTP 认证凭据（对应浏览器原生的用户名/密码弹窗，如 Knox 网关、路由器后台等）。
   * native 弹窗不在页面 DOM 里，内容脚本无法拾取，只能由用户录入一次。
   */
  schema.normalizeHttpAuth = function (raw) {
    var a = raw || {};
    return {
      username: String(a.username == null ? '' : a.username),
      password: String(a.password == null ? '' : a.password),
      enabled: !!a.enabled
    };
  };

  schema.createProfile = function (opts) {
    opts = opts || {};
    return {
      id: opts.id || util.uid('p'),
      site: schema.normalizeSite(opts.site),
      name: String(opts.name || opts.site || '未命名站点').trim(),
      matchMode: opts.matchMode || 'host',
      httpAuth: schema.normalizeHttpAuth(opts.httpAuth),
      createdAt: opts.createdAt || util.nowIso(),
      updatedAt: opts.updatedAt || util.nowIso(),
      schemes: Array.isArray(opts.schemes) ? opts.schemes : []
    };
  };

  schema.createScheme = function (opts) {
    opts = opts || {};
    return {
      id: opts.id || util.uid('s'),
      name: String(opts.name || '方案 1').trim(),
      autoFill: !!opts.autoFill,
      retry: Object.assign({}, schema.DEFAULT_RETRY, opts.retry || {}),
      createdAt: opts.createdAt || util.nowIso(),
      updatedAt: opts.updatedAt || util.nowIso(),
      items: Array.isArray(opts.items) ? opts.items : []
    };
  };

  schema.createItem = function (opts) {
    opts = opts || {};
    return {
      id: opts.id || util.uid('i'),
      label: String(opts.label || '字段').trim(),
      value: opts.value == null ? '' : String(opts.value),
      sensitive: !!opts.sensitive,
      order: Number.isFinite(opts.order) ? opts.order : 0,
      delayMs: Number.isFinite(opts.delayMs) ? opts.delayMs : 0,
      submitAfter: !!opts.submitAfter,
      locators: schema.normalizeLocators(opts.locators),
      meta: opts.meta || {}
    };
  };

  /** 规范化定位信息，保证输出结构稳定 */
  schema.normalizeLocators = function (locators) {
    var l = locators || {};
    var attr = {};
    var rawAttr = l.attr || {};
    ['id', 'name', 'type', 'placeholder', 'aria-label', 'autocomplete', 'tag', 'classHint'].forEach(function (k) {
      if (rawAttr[k] != null && rawAttr[k] !== '') attr[k] = String(rawAttr[k]);
    });
    var strategies = Array.isArray(l.strategies)
      ? l.strategies.filter(function (s) { return s && s.value; }).map(function (s) {
          return { type: s.type === 'xpath' ? 'xpath' : 'css', value: String(s.value) };
        })
      : [];

    return {
      css: l.css ? String(l.css) : '',
      xpath: l.xpath ? String(l.xpath) : '',
      attr: attr,
      strategies: strategies
    };
  };

  /** 空配置 */
  schema.emptyConfig = function () {
    return { app: schema.APP, version: schema.VERSION, profiles: [] };
  };

  /**
   * 校验外部导入的数据。
   * @returns {{ok:boolean, errors:string[], config:Object|null}}
   */
  schema.validateImport = function (raw) {
    var errors = [];

    if (!raw || typeof raw !== 'object') {
      return { ok: false, errors: ['内容不是一个有效的 JSON 对象'], config: null };
    }
    if (raw.app && String(raw.app) !== schema.APP) {
      errors.push('字段 app 应为 "pwhelper"，实际为 "' + raw.app + '"');
    }
    if (raw.version != null && Number(raw.version) > schema.VERSION) {
      errors.push('配置版本 v' + raw.version + ' 高于当前支持的 v' + schema.VERSION);
    }
    if (!Array.isArray(raw.profiles)) {
      errors.push('缺少 profiles 数组');
      return { ok: false, errors: errors, config: null };
    }

    raw.profiles.forEach(function (p, pi) {
      if (!p || typeof p !== 'object') { errors.push('profiles[' + pi + '] 不是对象'); return; }
      if (!p.site) errors.push('profiles[' + pi + '] 缺少 site 字段');
      if (p.schemes != null && !Array.isArray(p.schemes)) errors.push('profiles[' + pi + '].schemes 必须是数组');
      (p.schemes || []).forEach(function (s, si) {
        if (!s || typeof s !== 'object') { errors.push('profiles[' + pi + '].schemes[' + si + '] 不是对象'); return; }
        if (s.items != null && !Array.isArray(s.items)) errors.push('profiles[' + pi + '].schemes[' + si + '].items 必须是数组');
      });
    });

    if (errors.length) return { ok: false, errors: errors, config: null };

    return { ok: true, errors: [], config: schema.normalize(raw) };
  };

  /** 补齐默认值、重排顺序、生成缺失 id */
  schema.normalize = function (raw) {
    var config = schema.emptyConfig();
    var profiles = Array.isArray(raw && raw.profiles) ? raw.profiles : [];

    config.profiles = profiles.map(function (p) {
      var profile = schema.createProfile({
        id: p.id,
        site: p.site,
        name: p.name || p.site,
        matchMode: p.matchMode || 'host',
        httpAuth: p.httpAuth,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
      });
      profile.schemes = (Array.isArray(p.schemes) ? p.schemes : []).map(function (s) {
        var scheme = schema.createScheme({
          id: s.id,
          name: s.name,
          autoFill: s.autoFill,
          retry: s.retry,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt
        });
        scheme.items = (Array.isArray(s.items) ? s.items : []).map(function (it, idx) {
          return schema.createItem({
            id: it.id,
            label: it.label,
            value: it.value,
            sensitive: it.sensitive,
            order: Number.isFinite(it.order) ? it.order : idx,
            delayMs: it.delayMs,
            submitAfter: it.submitAfter,
            locators: it.locators,
            meta: it.meta
          });
        }).sort(function (a, b) { return a.order - b.order; });
        return scheme;
      });
      return profile;
    });

    return config;
  };

  /** 导出序列化：只输出稳定的公开结构 */
  schema.serialize = function (config) {
    var src = config || schema.emptyConfig();
    return {
      app: schema.APP,
      version: schema.VERSION,
      exportedAt: util.nowIso(),
      profiles: (src.profiles || []).map(function (p) {
        return {
          id: p.id,
          site: p.site,
          name: p.name,
          matchMode: p.matchMode || 'host',
          httpAuth: schema.normalizeHttpAuth(p.httpAuth),
          schemes: (p.schemes || []).map(function (s) {
            return {
              id: s.id,
              name: s.name,
              autoFill: !!s.autoFill,
              retry: Object.assign({}, schema.DEFAULT_RETRY, s.retry || {}),
              items: (s.items || []).map(function (it) {
                return {
                  id: it.id,
                  label: it.label,
                  value: it.value,
                  sensitive: !!it.sensitive,
                  order: it.order,
                  delayMs: it.delayMs,
                  submitAfter: !!it.submitAfter,
                  locators: schema.normalizeLocators(it.locators)
                };
              })
            };
          })
        };
      })
    };
  };

  /** 统计信息：站点数 / 方案数 / 字段数 */
  schema.stats = function (config) {
    var profiles = (config && config.profiles) || [];
    var schemes = 0;
    var items = 0;
    profiles.forEach(function (p) {
      (p.schemes || []).forEach(function (s) {
        schemes += 1;
        items += (s.items || []).length;
      });
    });
    return { profiles: profiles.length, schemes: schemes, items: items };
  };

  /**
   * 把导入的配置合并进现有配置。
   * strategy: 'merge'(同 id 覆盖，新增追加) | 'replace'(全量替换)
   */
  schema.merge = function (current, incoming, strategy) {
    var base = schema.normalize(current || schema.emptyConfig());
    var inc = schema.normalize(incoming || schema.emptyConfig());

    if (strategy === 'replace') return inc;

    var profileMap = {};
    base.profiles.forEach(function (p) { profileMap[p.id] = p; });

    inc.profiles.forEach(function (p) {
      var exist = profileMap[p.id] || base.profiles.filter(function (x) {
        return x.site === p.site && (x.matchMode || 'host') === (p.matchMode || 'host');
      })[0];

      if (!exist) {
        base.profiles.push(p);
        profileMap[p.id] = p;
        return;
      }

      // 站点级：覆盖展示名，合并方案
      exist.name = p.name || exist.name;
      exist.updatedAt = util.nowIso();

      p.schemes.forEach(function (s) {
        var target = exist.schemes.filter(function (x) { return x.id === s.id; })[0]
          || exist.schemes.filter(function (x) { return x.name === s.name; })[0];
        if (!target) {
          exist.schemes.push(s);
        } else {
          target.name = s.name || target.name;
          target.autoFill = !!s.autoFill;
          target.retry = Object.assign({}, schema.DEFAULT_RETRY, s.retry || {});
          target.updatedAt = util.nowIso();
          target.items = s.items; // 方案内字段以导入为准
        }
      });
    });

    return base;
  };

  /* ------------------------------ 冲突式合并 ------------------------------ */

  /** 站点身份：site + matchMode，用于判断两边是不是「同一套配置」 */
  schema.siteKey = function (p) {
    return String((p && p.site) || '').toLowerCase() + '|' + ((p && p.matchMode) || 'host');
  };

  function itemFingerprint(it) {
    return JSON.stringify({
      value: String(it.value == null ? '' : it.value),
      sensitive: !!it.sensitive,
      locators: schema.normalizeLocators(it.locators)
    });
  }

  function dots(v) {
    var n = Math.min(10, String(v == null ? '' : v).length);
    return n ? new Array(n + 1).join('•') : '（空）';
  }

  function retryText(r) {
    var v = Object.assign({}, schema.DEFAULT_RETRY, r || {});
    return v.times + ' 次 / ' + v.intervalMs + 'ms';
  }

  function collectIds(config) {
    var used = {};
    (config.profiles || []).forEach(function (p) {
      used[p.id] = true;
      (p.schemes || []).forEach(function (s) {
        used[s.id] = true;
        (s.items || []).forEach(function (it) { used[it.id] = true; });
      });
    });
    return used;
  }

  function freshId(used, id, prefix) {
    var next = (!id || used[id]) ? util.uid(prefix) : id;
    used[next] = true;
    return next;
  }

  function cloneItem(it, used, order) {
    return schema.createItem({
      id: freshId(used, it.id, 'i'),
      label: it.label,
      value: it.value,
      sensitive: it.sensitive,
      order: Number.isFinite(it.order) ? it.order : order,
      delayMs: it.delayMs,
      submitAfter: it.submitAfter,
      locators: it.locators
    });
  }

  function cloneScheme(s, used) {
    var scheme = schema.createScheme({
      id: freshId(used, s.id, 's'),
      name: s.name,
      autoFill: s.autoFill,
      retry: s.retry
    });
    scheme.items = (s.items || []).map(function (it, idx) { return cloneItem(it, used, idx); });
    return scheme;
  }

  /**
   * 生成合并计划：新增内容统计 + 需要用户裁决的冲突列表。
   * 冲突粒度：站点名称 / 方案自动填充与重试参数 / 字段内容。
   * @returns {{adds:{profiles:number,schemes:number,items:number}, conflicts:Array}}
   */
  schema.planMerge = function (current, incoming) {
    var base = schema.normalize(current || schema.emptyConfig());
    var inc = schema.normalize(incoming || schema.emptyConfig());
    var conflicts = [];
    var adds = { profiles: 0, schemes: 0, items: 0 };

    inc.profiles.forEach(function (p) {
      var pKey = schema.siteKey(p);
      var exist = base.profiles.filter(function (x) { return schema.siteKey(x) === pKey; })[0];

      if (!exist) {
        adds.profiles += 1;
        adds.schemes += (p.schemes || []).length;
        (p.schemes || []).forEach(function (s) { adds.items += (s.items || []).length; });
        return;
      }

      if (String(exist.name || '') !== String(p.name || '')) {
        conflicts.push({
          key: 'profile:' + pKey,
          level: 'profile',
          field: '站点名称',
          path: String(p.site || ''),
          current: String(exist.name || ''),
          incoming: String(p.name || '')
        });
      }

      var curAuth = schema.normalizeHttpAuth(exist.httpAuth);
      var incAuth = schema.normalizeHttpAuth(p.httpAuth);
      if (incAuth.enabled && incAuth.username && (curAuth.username !== incAuth.username || curAuth.password !== incAuth.password)) {
        conflicts.push({
          key: 'httpauth:' + pKey,
          level: 'profile',
          field: 'HTTP 认证凭据',
          path: String(p.site || ''),
          current: curAuth.username ? (curAuth.username + ' / ' + dots(curAuth.password)) : '（未设置）',
          incoming: incAuth.username + ' / ' + dots(incAuth.password),
          sensitive: true
        });
      }

      (p.schemes || []).forEach(function (s) {
        var target = exist.schemes.filter(function (x) { return x.name === s.name; })[0];
        if (!target) {
          adds.schemes += 1;
          adds.items += (s.items || []).length;
          return;
        }

        var sBase = 'scheme:' + pKey + '|' + s.name;
        if (!!target.autoFill !== !!s.autoFill) {
          conflicts.push({
            key: sBase + '|autoFill',
            level: 'scheme',
            field: '自动填充',
            path: p.site + ' › ' + s.name,
            current: target.autoFill ? '开' : '关',
            incoming: s.autoFill ? '开' : '关'
          });
        }
        if (retryText(target.retry) !== retryText(s.retry)) {
          conflicts.push({
            key: sBase + '|retry',
            level: 'scheme',
            field: '重试参数',
            path: p.site + ' › ' + s.name,
            current: retryText(target.retry),
            incoming: retryText(s.retry)
          });
        }

        (s.items || []).forEach(function (it) {
          var hit = target.items.filter(function (x) { return x.label === it.label; })[0];
          if (!hit) { adds.items += 1; return; }
          if (itemFingerprint(hit) === itemFingerprint(it)) return;

          conflicts.push({
            key: 'item:' + pKey + '|' + s.name + '|' + it.label,
            level: 'item',
            field: '内容',
            path: p.site + ' › ' + s.name + ' › ' + it.label,
            current: String(hit.value == null ? '' : hit.value),
            incoming: String(it.value == null ? '' : it.value),
            sensitive: !!(hit.sensitive || it.sensitive),
            metaChanged: String(hit.value == null ? '' : hit.value) === String(it.value == null ? '' : it.value)
          });
        });
      });
    });

    return { adds: adds, conflicts: conflicts };
  };

  /**
   * 按冲突裁决结果合并。
   * decisions: { [conflict.key]: 'current' | 'incoming' }，缺省视为保留现有。
   */
  schema.applyMerge = function (current, incoming, decisions) {
    decisions = decisions || {};
    var base = schema.normalize(current || schema.emptyConfig());
    var inc = schema.normalize(incoming || schema.emptyConfig());
    var used = collectIds(base);

    function wants(key) { return decisions[key] === 'incoming'; }

    inc.profiles.forEach(function (p) {
      var pKey = schema.siteKey(p);
      var exist = base.profiles.filter(function (x) { return schema.siteKey(x) === pKey; })[0];

      if (!exist) {
        var created = schema.createProfile({
          id: freshId(used, p.id, 'p'),
          site: p.site,
          name: p.name,
          matchMode: p.matchMode,
          httpAuth: p.httpAuth
        });
        base.profiles.push(created);
        (p.schemes || []).forEach(function (s) { created.schemes.push(cloneScheme(s, used)); });
        return;
      }

      if (wants('profile:' + pKey)) {
        exist.name = p.name;
        exist.matchMode = p.matchMode;
      }
      if (wants('httpauth:' + pKey)) {
        exist.httpAuth = schema.normalizeHttpAuth(Object.assign({ enabled: true }, p.httpAuth));
      }
      exist.updatedAt = util.nowIso();

      (p.schemes || []).forEach(function (s) {
        var target = exist.schemes.filter(function (x) { return x.name === s.name; })[0];
        if (!target) { exist.schemes.push(cloneScheme(s, used)); return; }

        var sBase = 'scheme:' + pKey + '|' + s.name;
        if (wants(sBase + '|autoFill')) target.autoFill = !!s.autoFill;
        if (wants(sBase + '|retry')) target.retry = Object.assign({}, schema.DEFAULT_RETRY, s.retry || {});

        (s.items || []).forEach(function (it) {
          var hit = target.items.filter(function (x) { return x.label === it.label; })[0];
          if (!hit) { target.items.push(cloneItem(it, used, target.items.length)); return; }
          if (!wants('item:' + pKey + '|' + s.name + '|' + it.label)) return;
          hit.value = it.value;
          hit.sensitive = !!it.sensitive;
          hit.locators = schema.normalizeLocators(it.locators);
        });
      });
    });

    return base;
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
