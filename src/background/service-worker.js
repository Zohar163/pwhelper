/**
 * 后台 Service Worker：
 *  - 配置读写代理（popup 与 content script 都通过它访问存储）
 *  - 拾取会话中转（内容脚本捕获的元素 → 会话 → 落库）
 *  - 自动填充查询、填充请求转发
 *  - 不在后台巡检标签页：站点匹配只在用户点开插件时发生
 */
/* global importScripts, chrome */
importScripts('../shared/util.js', '../shared/schema.js', '../shared/crypto.js', '../shared/sync-store.js', '../shared/config-store.js');

var PW = self.PW;
var util = PW.util;
var schema = PW.schema;
var store = PW.store;
var pwcrypto = PW.crypto;
var syncStore = PW.syncStore;

var FILES = [
  'src/shared/util.js',
  'src/shared/locator.js',
  'src/shared/fill-engine.js',
  'src/content/content.js'
];

var CSS_FILES = ['src/content/picker.css'];

/* ------------------------ 浏览器原生登录弹窗（HTTP 认证） ------------------------ */

/**
 * 像 Knox 网关、路由器后台、内网 YARN UI 这类站点用的是 HTTP Basic/Digest 认证，
 * 登录框由浏览器自己绘制，不在页面 DOM 里，内容脚本永远拿不到。
 * 这里在网络层拦下认证挑战，用已保存的凭据直接应答 —— 之后访问就再也不会弹那个框了。
 */
var httpAuthAttempts = {};  // 站点标识 -> {n, ts}：防止凭据错误时被反复挑战
var httpAuthConfig = null;  // 配置快照：认证拦截器必须同步决策，不能临时读存储

function originKey(url) {
  return util.prettyHost(url) || util.hostOf(url) || '';
}

function refreshHttpAuthConfig() {
  return store.load().then(function (config) {
    httpAuthConfig = config;
    return config;
  }).catch(function () { return httpAuthConfig; });
}

refreshHttpAuthConfig();
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes && changes['pwhelper.config']) refreshHttpAuthConfig();
});

if (chrome.webRequest && chrome.webRequest.onAuthRequired) {
  // 按官方文档的同步写法：直接 return BlockingResponse
  chrome.webRequest.onAuthRequired.addListener(
    function (details) {
      var auth = schema.httpAuthFor(httpAuthConfig, details.url);
      var key = originKey(details.url);

      if (!auth) {
        // 没有保存凭据：完全不接管，交回浏览器原生弹窗
        if (key) store.markAuthPending(key);
        return;
      }

      var rec = httpAuthAttempts[key];
      var tries = (!rec || (Date.now() - rec.ts) > 15000) ? 0 : rec.n;
      if (tries >= 2) {
        // 连续被同一站点挑战多次，说明凭据不对，交给原生弹窗让用户重填
        return;
      }
      httpAuthAttempts[key] = { n: tries + 1, ts: Date.now() };
      if (key) store.clearAuthPending(key);

      return { authCredentials: { username: auth.username, password: auth.password } };
    },
    { urls: ['<all_urls>'] },
    ['blocking']
  );
}

/* ------------------------------ 通用工具 ------------------------------ */

function ok(res) {
  return Object.assign({ ok: true }, res || {});
}

function fail(error) {
  return { ok: false, error: String(error || '未知错误') };
}

function currentTab() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

/**
 * 定位目标标签页：优先按 URL 精确匹配，其次回退到当前激活页。
 * 显式匹配可以避免「当前激活页」判定不准导致把消息发到错误的标签页。
 */
function resolveTab(url) {
  return currentTab().then(function (tab) {
    if (!url) return tab;
    return new Promise(function (resolve) {
      chrome.tabs.query({}, function (tabs) {
        var list = (tabs || []).filter(function (t) {
          return t && t.url && (t.url === url || t.url.indexOf(url) === 0);
        });
        resolve(list.length ? list[list.length - 1] : tab);
      });
    });
  });
}

/* ---------------------------- 内容脚本注入兜底 ---------------------------- */

/** 让该标签页的所有 frame 退出拾取模式 */
function stopPickEverywhere(tabId) {
  if (!tabId) return;
  util.sendTabMessage(tabId, { type: 'PW_STOP_PICK' });
}

/**
 * 向标签页广播消息：不指定 frameId 时会发给所有 frame，返回首个响应。
 * 每个 frame 都会各自执行（拾取 / 填充），因此这里只需要知道「有没有人应答」。
 */
function pingTab(tabId) {
  return util.sendTabMessage(tabId, { type: 'PW_PING' }).then(function (res) {
    return !!(res && res.ok);
  });
}

function callApi(api, name, payload) {
  return new Promise(function (resolve) {
    try {
      var ret = api[name](payload);
      if (ret && typeof ret.then === 'function') {
        ret.then(function () { resolve(true); }, function () { resolve(false); });
      } else {
        resolve(true); // 回调式 API，忽略结果
      }
    } catch (e) {
      resolve(false);
    }
  });
}

/** MV3 注入（chrome.scripting），低版本内核不可用时返回 false */
function injectModern(tabId) {
  var s = chrome.scripting;
  if (!s || !s.executeScript) return Promise.resolve(false);
  return callApi(s, 'insertCSS', { target: { tabId: tabId, allFrames: true }, files: CSS_FILES })
    .then(function () {
      return callApi(s, 'executeScript', { target: { tabId: tabId, allFrames: true }, files: FILES });
    });
}

/** 低版本内核兜底：chrome.tabs.executeScript / insertCSS */
function injectLegacy(tabId) {
  var t = chrome.tabs;
  if (!t || !t.executeScript) return Promise.resolve(false);
  return new Promise(function (resolve) {
    try {
      if (t.insertCSS) {
        t.insertCSS(tabId, { allFrames: true, files: CSS_FILES }, function () { /* 忽略结果 */ });
      }
      t.executeScript(tabId, { allFrames: true, files: FILES }, function () {
        resolve(!chrome.runtime.lastError);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

/**
 * 确保内容脚本已注入到目标页（含页面内的 iframe）。
 * 页面先于扩展加载、或浏览器不自动注入时走程序化注入；两种 API 都试一遍以兼容不同内核。
 * @returns {Promise<boolean>} true 表示内容脚本可用
 */
function ensureContentScript(tabId) {
  return pingTab(tabId).then(function (alive) {
    if (alive) return true;
    return injectModern(tabId)
      .then(function () { return util.sleep(120); })
      .then(function () { return pingTab(tabId); })
      .then(function (alive2) {
        if (alive2) return true;
        return injectLegacy(tabId)
          .then(function () { return util.sleep(180); })
          .then(function () { return pingTab(tabId); });
      });
  });
}

/** 合并字段：同 label + 同主定位 视为同一项，更新内容，其余追加 */
function mergeItems(existing, incoming) {
  var list = (existing || []).slice();
  (incoming || []).forEach(function (item) {
    var key = (item.label || '') + '|' + ((item.locators && (item.locators.css || item.locators.xpath)) || '');
    var hit = list.filter(function (x) {
      return (x.label || '') + '|' + ((x.locators && (x.locators.css || x.locators.xpath)) || '') === key;
    })[0];
    if (hit) {
      hit.value = item.value;
      hit.sensitive = item.sensitive;
      hit.locators = item.locators;
      hit.delayMs = item.delayMs;
      hit.submitAfter = item.submitAfter;
    } else {
      item.order = list.length;
      list.push(item);
    }
  });
  list.forEach(function (it, i) { it.order = i; });
  return list;
}

function sessionForTab(tabUrl) {
  var host = util.hostOf(tabUrl);
  return {
    tabId: null,
    site: util.prettyHost(tabUrl) || host,
    host: host,
    hostPort: util.hostPortOf(tabUrl),
    url: tabUrl,
    schemeName: '',
    autoFill: false,
    items: [],
    existingSchemes: []
  };
}

/* ------------------------------ 徽标 ------------------------------ */

// 不监听标签页切换 / 页面加载，图标上也不显示任何数字：站点匹配只在点开插件时做一次。
// 这里只负责清掉旧版本留在各标签页上的徽标。
function clearBadges() {
  try {
    chrome.action.setBadgeText({ text: '' });
    chrome.tabs.query({}, function (tabs) {
      (tabs || []).forEach(function (t) {
        if (t.id != null) chrome.action.setBadgeText({ tabId: t.id, text: '' });
      });
    });
  } catch (e) { /* 忽略 */ }
}

clearBadges();

/* ------------------------------ 消息路由 ------------------------------ */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  var tabUrl = (sender && sender.tab && sender.tab.url) || '';
  var tabId = sender && sender.tab ? sender.tab.id : null;

  var handler = handlers[msg.type];
  if (!handler) return;

  Promise.resolve()
    .then(function () { return handler(msg, tabId, tabUrl); })
    .then(function (res) { sendResponse(res == null ? ok() : res); })
    .catch(function (err) { sendResponse(fail((err && err.message) || err)); });

  return true; // 异步响应
});

var handlers = {};

/* ------------------------------ 配置读取 ------------------------------ */

handlers.PW_CONFIG_GET = function () {
  return store.load().then(function (config) { return ok({ config: config }); });
};

handlers.PW_MATCH = function (msg, tabId, tabUrl) {
  var url = msg.url || tabUrl;
  return store.matchProfiles(url).then(function (profiles) {
    return ok({
      host: util.prettyHost(url) || util.hostOf(url),
      url: url,
      profiles: util.clone(profiles)
    });
  });
};

/* ---------------------------- HTTP 认证凭据接口 ---------------------------- */

handlers.PW_HTTPAUTH_STATE = function (msg) {
  var url = msg.url || '';
  var key = originKey(url);
  var host = util.hostOf(url);
  if (!key) return ok({ key: '', pending: false, profileId: null, username: '', enabled: false });

  return Promise.all([store.load(), store.isAuthPending(key)]).then(function (r) {
    var config = r[0];
    var pending = !!r[1];
    var profile = host
      ? (config.profiles || []).filter(function (p) { return util.matches(p, host, url); })[0]
      : null;
    var auth = profile ? schema.normalizeHttpAuth(profile.httpAuth) : null;
    var enabled = !!(auth && auth.enabled && auth.username);
    // 已保存凭据就不必再提示「检测到登录弹窗」
    return ok({
      key: key,
      pending: !enabled && pending,
      profileId: profile ? profile.id : null,
      username: auth ? auth.username : '',
      enabled: enabled
    });
  });
};

handlers.PW_HTTPAUTH_SET = function (msg) {
  var site = msg.site || originKey(msg.url);
  if (!site) return fail('无法确定当前站点');
  if (!msg.username) return fail('请填写账号');

  return store.setHttpAuth(site, {
    username: String(msg.username),
    password: String(msg.password || ''),
    enabled: true
  }).then(function (r) {
    store.clearAuthPending(site);
    // 立刻刷新配置快照，保证用户点保存后紧接着的重新加载就能自动通过
    return refreshHttpAuthConfig().then(function () {
      delete httpAuthAttempts[site];
      return ok(r);
    });
  });
};

handlers.PW_HTTPAUTH_CLEAR = function (msg) {
  if (!msg.profileId) return fail('缺少站点 id');
  return store.clearHttpAuth(msg.profileId).then(function () {
    return refreshHttpAuthConfig().then(function () { return ok(); });
  });
};

handlers.PW_PROFILE_DELETE = function (msg) {
  return store.removeProfile(msg.profileId).then(function () { return ok(); });
};

handlers.PW_PROFILE_UPDATE = function (msg) {
  return store.renameProfile(msg.profileId, msg.name, msg.matchMode, msg.site).then(function () { return ok(); });
};

handlers.PW_SCHEME_UPDATE = function (msg) {
  return store.updateScheme(msg.profileId, msg.schemeId, msg.patch || {}).then(function () { return ok(); });
};

handlers.PW_SCHEME_DELETE = function (msg) {
  return store.removeScheme(msg.profileId, msg.schemeId).then(function () { return ok(); });
};

handlers.PW_ITEM_UPDATE = function (msg) {
  return store.updateItem(msg.profileId, msg.schemeId, msg.itemId, msg.patch || {}).then(function () { return ok(); });
};

handlers.PW_ITEM_DELETE = function (msg) {
  return store.removeItem(msg.profileId, msg.schemeId, msg.itemId).then(function () { return ok(); });
};

handlers.PW_ITEM_ADD = function (msg) {
  return store.addItem(msg.profileId, msg.schemeId, schema.createItem(msg.item)).then(function () { return ok(); });
};

handlers.PW_REPLACE_ALL = function (msg) {
  return store.replaceAll(schema.normalize(msg.config)).then(function () { return ok(); });
};

/* ------------------------------ 拾取流程 ------------------------------ */

handlers.PW_PICK_START = function (msg, tabId, tabUrl) {
  return resolveTab(msg.url || tabUrl).then(function (tab) {
    // 优先使用按 URL 解析出的标签页，避免 sender 自身是标签页时定位错误
    var targetId = (tab && tab.id) || tabId;
    var url = msg.url || tabUrl || (tab && tab.url) || '';
    var host = util.hostOf(url);
    var siteKey = util.prettyHost(url);
    if (!targetId || !host) return fail('无法获取当前页面信息');

    return Promise.all([store.matchProfiles(url), store.getPickSession()]).then(function (results) {
      var profiles = results[0] || [];
      var prev = results[1];

      var existing = [];
      profiles.forEach(function (p) {
        (p.schemes || []).forEach(function (s) { existing.push(s.name); });
      });

      // 同一站点复用会话，避免重复启动时丢掉已捕获的字段
      var session = (prev && prev.site === siteKey) ? prev : sessionForTab(url);
      session.tabId = targetId;
      session.site = siteKey;
      session.host = host;
      session.hostPort = util.hostPortOf(url);
      session.url = url;
      session.existingSchemes = existing;
      if (msg.schemeName) session.schemeName = msg.schemeName;
      if (!session.schemeName) session.schemeName = existing.length ? existing[0] : '';

      return store.setPickSession(session).then(function () {
        return ensureContentScript(targetId).then(function (injected) {
          // 注入失败必须显式报错，否则用户只会看到「点了没反应」
          if (!injected) {
            return fail('无法注入到该页面，请刷新页面后重试（浏览器内置页、扩展商店等页面禁止注入脚本）');
          }
          return util.sendTabMessage(targetId, { type: 'PW_START_PICK', session: session }).then(function (r) {
            if (!r) return fail('页面未响应，请刷新页面后重试');
            return ok({ session: session });
          });
        });
      });
    });
  });
};

handlers.PW_PICK_GET = function () {
  return store.getPickSession().then(function (session) {
    return ok({ session: session || null });
  });
};

handlers.PW_PICK_ADD = function (msg, tabId, tabUrl) {
  return store.getPickSession().then(function (session) {
    if (!session) {
      session = sessionForTab(tabUrl || '');
      session.tabId = tabId;
    }
    if (msg.schemeName) session.schemeName = msg.schemeName;
    if (msg.autoFill != null) session.autoFill = !!msg.autoFill;

    var item = schema.createItem(Object.assign({}, msg.item, { order: session.items.length }));
    session.items.push(item);
    return store.setPickSession(session).then(function () {
      return ok({ count: session.items.length, itemId: item.id });
    });
  });
};

handlers.PW_PICK_UPDATE = function (msg) {
  return store.getPickSession().then(function (session) {
    if (!session || !session.items[msg.index]) return fail('拾取会话不存在');
    var item = session.items[msg.index];
    var patch = msg.patch || {};
    ['label', 'value', 'sensitive', 'delayMs', 'submitAfter'].forEach(function (k) {
      if (patch[k] !== undefined) item[k] = patch[k];
    });
    return store.setPickSession(session).then(function () { return ok({ count: session.items.length }); });
  });
};

handlers.PW_PICK_REMOVE = function (msg) {
  return store.getPickSession().then(function (session) {
    if (!session) return fail('拾取会话不存在');
    session.items.splice(msg.index, 1);
    session.items.forEach(function (it, i) { it.order = i; });
    return store.setPickSession(session).then(function () { return ok({ count: session.items.length }); });
  });
};

handlers.PW_PICK_FINISH = function (msg, tabId) {
  return store.getPickSession().then(function (session) {
    if (!session || !session.items.length) return fail('没有待保存的字段');

    var schemeName = (msg.schemeName || session.schemeName || '方案 1').trim();
    var items = session.items.map(function (it) { return schema.createItem(it); });

    return store.load().then(function (config) {
      var profile = (config.profiles || []).filter(function (p) {
        return p.site === session.site && (p.matchMode || 'host') === 'host';
      })[0];

      if (!profile) {
        profile = schema.createProfile({ site: session.site, name: session.site, matchMode: 'host' });
        config.profiles.push(profile);
      }

      var scheme = (profile.schemes || []).filter(function (s) { return s.name === schemeName; })[0];
      if (!scheme) {
        scheme = schema.createScheme({
          name: schemeName,
          autoFill: !!msg.autoFill,
          items: items
        });
        profile.schemes = profile.schemes || [];
        profile.schemes.push(scheme);
      } else {
        scheme.items = mergeItems(scheme.items, items);
        if (msg.autoFill !== undefined) scheme.autoFill = !!msg.autoFill;
        scheme.updatedAt = util.nowIso();
      }

      profile.updatedAt = util.nowIso();
      return store.save(config).then(function () {
        return store.clearPickSession().then(function () {
          // 通知所有 frame 退出拾取（可能是在 iframe 里完成的）
          stopPickEverywhere(tabId);
          return ok({
            count: items.length,
            profileId: profile.id,
            schemeId: scheme.id,
            schemeName: schemeName
          });
        });
      });
    });
  });
};

handlers.PW_PICK_CANCEL = function (msg, tabId) {
  return store.clearPickSession().then(function () {
    stopPickEverywhere(tabId);
    return ok();
  });
};

/* ------------------------------ 填充执行 ------------------------------ */

/* 多条 frame 各自汇报，取每个字段的最好结果 */
var fillCollectorMap = {};

function mergeFillReports(reports, items) {
  var best = {};
  (reports || []).forEach(function (list) {
    (list || []).forEach(function (r) {
      var key = String(r.label);
      if (!best[key] || (!best[key].ok && r.ok)) best[key] = r;
    });
  });
  return (items || []).map(function (it) {
    return best[String(it.label)] || { label: it.label, ok: false, reason: '未找到匹配元素' };
  });
}

/**
 * 广播填充请求到页面的所有 frame（字段可能记录在 iframe 里），
 * 各 frame 汇报自己能填的部分，汇总后返回。
 */
function fillAcrossFrames(tabId, items, retry) {
  var requestId = util.uid('fill');
  return new Promise(function (resolve) {
    var collector = { reports: [], timer: null, settled: false };
    fillCollectorMap[requestId] = collector;

    function settle() {
      if (collector.settled) return;
      collector.settled = true;
      if (collector.timer) clearTimeout(collector.timer);
      delete fillCollectorMap[requestId];
      resolve(ok({ report: mergeFillReports(collector.reports, items) }));
    }

    util.sendTabMessage(tabId, { type: 'PW_FILL', requestId: requestId, items: items, retry: retry })
      .then(function (res) {
        if (res && res.report) collector.reports.push(res.report);
        var merged = mergeFillReports(collector.reports, items);
        var allHit = merged.length > 0 && merged.every(function (r) { return r.ok; });
        if (allHit) setTimeout(settle, 40); // 全命中就不必再等其它 frame
      });

    collector.timer = setTimeout(settle, 2600);
  });
}

handlers.PW_FILL_REPORT = function (msg) {
  var c = fillCollectorMap[msg.requestId];
  if (c && msg.report) c.reports.push(msg.report);
  return ok();
};

handlers.PW_FILL_SCHEME = function (msg, tabId, tabUrl) {
  return resolveTab(msg.url || tabUrl).then(function (tab) {
    if (!tab || !tab.id) return fail('无法获取当前标签页');
    return store.load().then(function (config) {
      var profile = (config.profiles || []).filter(function (p) { return p.id === msg.profileId; })[0];
      if (!profile) return fail('站点配置不存在');
      var scheme = (profile.schemes || []).filter(function (s) { return s.id === msg.schemeId; })[0];
      if (!scheme) return fail('方案不存在');
      if (!scheme.items || !scheme.items.length) return fail('该方案没有字段');

      return ensureContentScript(tab.id).then(function (injected) {
        if (!injected) return fail('无法注入到该页面，请刷新页面后重试');
        return fillAcrossFrames(
          tab.id,
          util.clone(scheme.items),
          Object.assign({}, schema.DEFAULT_RETRY, scheme.retry || {})
        );
      });
    });
  });
};

handlers.PW_AUTOFILL_QUERY = function (msg, tabId, tabUrl) {
  var url = msg.url || tabUrl || '';
  return store.autoFillPlan(url).then(function (plan) {
    if (!plan) return ok({ items: [] });
    return ok(plan);
  });
};

/* --------------------- 云同步（浏览器账号云端，手动推送/拉取） --------------------- */

function configStats(config) {
  var sites = 0;
  var schemes = 0;
  var items = 0;
  (config.profiles || []).forEach(function (p) {
    sites += 1;
    (p.schemes || []).forEach(function (s) {
      schemes += 1;
      items += (s.items || []).length;
    });
  });
  return { sites: sites, schemes: schemes, items: items };
}

handlers.PW_SYNC_STATE = function () {
  return Promise.all([syncStore.cloudState(), syncStore.getMaster(), store.load()]).then(function (r) {
    return ok({
      cloud: r[0],
      remembered: !!r[1],
      stats: configStats(r[2])
    });
  });
};

handlers.PW_SYNC_UPLOAD = function (msg) {
  return Promise.all([store.load(), syncStore.getMaster()]).then(function (r) {
    var config = r[0];
    if (!(config.profiles || []).length) return fail('本机还没有任何配置，无需上传');
    // 未输入主密码时使用本机记住的（弹层里勾选「记住」时保存过）
    var pwd = String(msg.masterPassword || r[1] || '');
    return syncStore.upload(config, pwd, !!msg.remember).then(function (res) {
      res.stats = configStats(config);
      return ok(res);
    });
  });
};

handlers.PW_SYNC_DOWNLOAD = function (msg) {
  return Promise.all([syncStore.readEnvelope(), syncStore.getMaster()])
    .then(function (r) {
      var pwd = String(msg.masterPassword || r[1] || '');
      return pwcrypto.decryptJson(r[0], pwd);
    })
    .then(function (config) {
      var check = schema.validateImport(config);
      if (!check.ok) return fail((check.errors || []).join('；') || '云端数据校验未通过');
      return ok({ config: check.config });
    });
};

handlers.PW_SYNC_CLEAR = function () {
  return syncStore.clear().then(function () { return ok(); });
};

handlers.PW_SYNC_FORGET = function () {
  return syncStore.forgetMaster().then(function () { return ok(); });
};

/* ------------------------------ 安装初始化 ------------------------------ */

chrome.runtime.onInstalled.addListener(function () {
  store.load().then(function (config) {
    if (!config || !config.profiles) return store.save(schema.emptyConfig());
    return null;
  }).catch(function () { /* ignore */ });
});
