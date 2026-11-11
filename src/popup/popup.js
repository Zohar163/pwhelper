/**
 * Popup 逻辑：填充 / 记录 / 管理 三个页签 + 导入导出。
 */
(function () {
  'use strict';

  var PW = window.PW;
  var util = PW.util;
  var schema = PW.schema;
  var pwcrypto = PW.crypto;

  var state = {
    url: '',
    host: '',
    profiles: [],
    allProfiles: [],
    manageQuery: '',
    pick: null,
    startupFilled: false,
    revealed: {},
    exportConfig: null,
    httpAuth: null,
    importConfig: null,
    importRaw: null,
    importEncrypted: false,
    importConflicts: [],
    importDecisions: {},
    conflictReveal: false,
    strategy: 'merge'
  };

  function $(id) { return document.getElementById(id); }

  function send(msg) {
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
  }

  /* --------------------------------- Toast --------------------------------- */

  var toastTimer = null;
  function toast(message, kind) {
    var t = $('toast');
    t.textContent = message;
    t.className = 'toast' + (kind ? ' is-' + kind : '');
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ------------------------------ DOM 辅助函数 ------------------------------ */

  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function input(className, value, placeholder) {
    var el = document.createElement('input');
    el.type = 'text';
    if (className) el.className = className;
    el.value = value == null ? '' : String(value);
    if (placeholder) el.placeholder = placeholder;
    return el;
  }

  function switchEl(checked, labelText, onChange) {
    var wrap = h('label', 'switch');
    wrap.appendChild(h('span', null, labelText));
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!checked;
    var track = h('span', 'switch-track');
    track.appendChild(h('span', 'switch-thumb'));
    box.addEventListener('change', function () { onChange(box.checked); });
    wrap.appendChild(box);
    wrap.appendChild(track);
    return wrap;
  }

  function iconBtn(text, className, onClick) {
    var b = h('button', 'icon-btn ' + (className || ''), text);
    b.type = 'button';
    b.title = text === '✕' ? '删除' : text;
    b.addEventListener('click', onClick);
    return b;
  }

  /* --------------------------------- 页签 --------------------------------- */

  function bindTabs() {
    var tabs = document.querySelectorAll('.tab');
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener('click', function () {
        Array.prototype.forEach.call(tabs, function (t) { t.classList.remove('is-active'); });
        tab.classList.add('is-active');
        Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) {
          p.classList.remove('is-active');
        });
        var panel = $('panel-' + tab.getAttribute('data-tab'));
        if (panel) panel.classList.add('is-active');
      });
    });
  }

  function activateTab(name) {
    var tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (tab) tab.click();
  }

  /* ------------------------------- 填充页渲染 ------------------------------- */

  function renderFill() {
    var list = $('fillList');
    list.textContent = '';

    var schemes = [];
    state.profiles.forEach(function (p) {
      (p.schemes || []).forEach(function (s) { schemes.push({ profile: p, scheme: s }); });
    });

    $('fillCount').textContent = String(schemes.length);
    $('fillEmpty').hidden = schemes.length > 0;

    schemes.forEach(function (entry) {
      var card = h('div', 'card');

      var head = h('div', 'card-head');
      head.appendChild(h('h3', 'card-title', entry.scheme.name));
      head.appendChild(h('span', 'chip', (entry.scheme.items || []).length + ' 项'));
      card.appendChild(head);

      card.appendChild(h('p', 'card-sub', entry.profile.site + ' · ' + util.describeMatch(entry.profile)));

      var chips = h('div', 'field-chips');
      (entry.scheme.items || []).forEach(function (it) {
        chips.appendChild(h('span', 'chip', it.label));
      });
      card.appendChild(chips);

      var foot = h('div', 'card-foot');
      foot.appendChild(switchEl(entry.scheme.autoFill, '点开即填充', function (checked) {
        send({
          type: 'PW_SCHEME_UPDATE',
          profileId: entry.profile.id,
          schemeId: entry.scheme.id,
          patch: { autoFill: checked }
        }).then(function (res) {
          if (!res || !res.ok) { toast('保存失败', 'err'); return; }
          entry.scheme.autoFill = checked;
          toast(checked ? '已开启：点开插件即自动填充' : '已关闭自动填充', 'ok');
        });
      }));

      var btn = h('button', 'btn btn-primary', '填充');
      btn.type = 'button';
      btn.addEventListener('click', function () { doFill(entry.profile.id, entry.scheme.id, btn); });
      foot.appendChild(btn);

      card.appendChild(foot);
      list.appendChild(card);
    });
  }

  /**
   * 点开插件＝触发点。
   * 内容脚本不再常驻，页面加载时无法自动填充，改为每次打开面板时检查本站点
   * 是否有开启「点开插件时自动填充」的方案，有就立即执行一次。
   */
  function runStartupAutoFill() {
    if (state.startupFilled || !state.url) return;
    state.startupFilled = true;

    send({ type: 'PW_AUTOFILL_QUERY', url: state.url }).then(function (plan) {
      if (!plan || !plan.ok || !plan.schemeId) return;
      send({ type: 'PW_FILL_SCHEME', profileId: plan.profileId, schemeId: plan.schemeId, url: state.url })
        .then(function (res) {
          if (!res || !res.ok) { toast((res && res.error) || '自动填充失败', 'err'); return; }
          var report = res.report || [];
          var okCount = report.filter(function (r) { return r.ok; }).length;
          if (okCount === report.length && okCount) toast('已自动填充 ' + okCount + ' 项', 'ok');
          else if (okCount) toast('已填充 ' + okCount + ' 项，部分字段未匹配', 'err');
          else toast('自动填充未匹配到元素，可重新记录该字段', 'err');
        });
    });
  }

  function doFill(profileId, schemeId, btn) {
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '填充中…';
    send({ type: 'PW_FILL_SCHEME', profileId: profileId, schemeId: schemeId, url: state.url }).then(function (res) {
      btn.disabled = false;
      btn.textContent = original;
      if (!res || !res.ok) {
        toast((res && res.error) || '填充失败，请刷新页面重试', 'err');
        return;
      }
      var report = res.report || [];
      var okCount = report.filter(function (r) { return r.ok; }).length;
      if (!okCount) {
        toast('未找到匹配元素，可重新记录该字段', 'err');
      } else if (okCount === report.length) {
        toast('已填充 ' + okCount + ' 项', 'ok');
      } else {
        var miss = report.filter(function (r) { return !r.ok; }).map(function (r) { return r.label; }).join('、');
        toast('已填充 ' + okCount + ' 项，失败：' + miss, 'err');
      }
    });
  }

  /* --------------------- HTTP 认证凭据（浏览器原生登录弹窗） --------------------- */

  function renderHttpAuth() {
    var info = state.httpAuth;
    var card = $('httpAuthCard');
    if (!info) { card.hidden = true; return; }

    // 只在「已保存」或「刚检测到原生登录弹窗」时出现，普通站点不打扰
    card.hidden = !(info.enabled || info.pending);
    if (card.hidden) return;

    $('httpAuthState').textContent = info.enabled ? '已保存' : '检测到登录弹窗';
    $('httpAuthSaved').hidden = !info.enabled;
    $('httpAuthForm').hidden = info.enabled;
    $('httpAuthUser').textContent = info.enabled ? info.username : '';

    if (info.enabled) {
      $('httpAuthHint').textContent = '已为该站点保存 HTTP 认证凭据，之后打开页面会自动通过，不会再弹登录框。';
    } else {
      $('httpAuthHint').textContent = '该站点弹出的是浏览器原生登录框（HTTP Basic 认证，常见于 Knox 网关、内网集群后台、路由器页面）。'
        + '它不属于网页内容，无法用拾取记录；在此录一次账号密码，之后访问即自动通过。';
    }
  }

  function reloadCurrentTab() {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs && tabs[0] && tabs[0].id != null) chrome.tabs.reload(tabs[0].id);
      });
    } catch (e) { /* 忽略 */ }
  }

  function saveHttpAuth() {
    var username = $('httpAuthUsername').value.trim();
    var password = $('httpAuthPassword').value;
    if (!username) { toast('请填写账号', 'err'); return; }

    var btn = $('btnHttpAuthSave');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '保存中…';

    send({
      type: 'PW_HTTPAUTH_SET',
      url: state.url,
      site: state.httpAuth ? state.httpAuth.key : '',
      username: username,
      password: password
    }).then(function (res) {
      btn.disabled = false;
      btn.textContent = label;
      if (!res || !res.ok) { toast((res && res.error) || '保存失败', 'err'); return; }
      toast('已保存，正在重新加载页面', 'ok');
      $('httpAuthPassword').value = '';
      reloadCurrentTab();
      return refresh();
    });
  }

  function clearHttpAuth() {
    if (!state.httpAuth || !state.httpAuth.profileId) return;
    if (!window.confirm('清除该站点的 HTTP 认证凭据？之后访问会重新弹出浏览器原生登录框。')) return;
    send({ type: 'PW_HTTPAUTH_CLEAR', profileId: state.httpAuth.profileId }).then(function (res) {
      if (!res || !res.ok) { toast('清除失败', 'err'); return; }
      toast('已清除', 'ok');
      return refresh();
    });
  }

  function bindHttpAuth() {
    $('btnHttpAuthSave').addEventListener('click', saveHttpAuth);
    $('btnHttpAuthEdit').addEventListener('click', function () {
      if (!state.httpAuth) return;
      $('httpAuthUsername').value = state.httpAuth.username || '';
      $('httpAuthPassword').value = '';
      $('httpAuthSaved').hidden = true;
      $('httpAuthForm').hidden = false;
      $('httpAuthUsername').focus();
    });
    $('btnHttpAuthClear').addEventListener('click', clearHttpAuth);
    $('httpAuthPassword').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') saveHttpAuth();
    });
  }

  /* ------------------------------- 记录页渲染 ------------------------------- */

  function renderRecord() {
    var session = state.pick;
    var sessionBox = $('recordSession');
    var startBtn = $('btnStartPick');
    var tip = $('pickingTip');
    var list = $('pickedList');

    sessionBox.hidden = !session;
    tip.hidden = !session;
    startBtn.hidden = !!session;

    if (!session) {
      list.textContent = '';
      return;
    }

    $('schemeNameInput').value = session.schemeName || '';
    $('autoFillInput').checked = !!session.autoFill;

    list.textContent = '';
    (session.items || []).forEach(function (item, index) {
      var row = h('div', 'picked-item');

      var head = h('div', 'picked-head');
      head.appendChild(h('span', 'picked-index', String(index + 1)));
      head.appendChild(h('span', 'picked-target',
        (item.meta && item.meta.summary) || util.truncate(item.label, 20)));
      head.appendChild(iconBtn('✕', 'is-danger', function () {
        send({ type: 'PW_PICK_REMOVE', index: index }).then(refresh);
      }));
      row.appendChild(head);

      var fields = h('div', 'picked-fields');
      var labelInput = input('input input-sm', item.label, '标签');
      var valueInput = input('input input-sm', item.value, '内容');
      if (item.sensitive) valueInput.type = 'password';

      labelInput.addEventListener('change', function () {
        send({ type: 'PW_PICK_UPDATE', index: index, patch: { label: labelInput.value.trim() || '字段' } }).then(refresh);
      });
      valueInput.addEventListener('change', function () {
        send({ type: 'PW_PICK_UPDATE', index: index, patch: { value: valueInput.value } }).then(refresh);
      });

      fields.appendChild(labelInput);
      fields.appendChild(valueInput);
      row.appendChild(fields);
      list.appendChild(row);
    });

    if (!session.items.length) {
      list.appendChild(h('p', 'hint', '尚未捕获任何输入框，回到页面点击需要记录的输入框。'));
    }
  }

  /* ------------------------------- 管理页渲染 ------------------------------- */

  /** 模糊匹配：空格分词，全部命中即算命中（覆盖名称 / 站点 / 匹配方式 / 方案 / 字段） */
  function matchesQuery(profile, query) {
    var tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    var hay = [profile.name, profile.site, util.describeMatch(profile)];
    (profile.schemes || []).forEach(function (s) {
      hay.push(s.name);
      (s.items || []).forEach(function (it) { hay.push(it.label); });
    });
    var text = hay.join('\n').toLowerCase();
    return tokens.every(function (t) { return text.indexOf(t) !== -1; });
  }

  function renderManage() {
    var wrap = $('manageList');
    wrap.textContent = '';

    var all = state.allProfiles || [];
    var query = state.manageQuery || '';
    var profiles = all.filter(function (p) { return matchesQuery(p, query); });

    $('manageEmpty').hidden = all.length > 0;
    $('manageNoMatch').hidden = !(all.length > 0 && query && !profiles.length);
    $('btnManageSearchClear').hidden = !query;

    profiles.forEach(function (profile) {
      var group = h('div', 'profile-group');

      /* 站点头：配置名称 / 匹配模式 + 站点标识 */
      var head = h('div', 'profile-head');

      var nameRow = h('div', 'field-row');
      nameRow.appendChild(h('span', 'field-label', '配置名称'));
      var nameInput = input('input input-sm', profile.name, profile.site);
      nameInput.title = '用于识别的配置名称，默认为站点标识';
      nameInput.addEventListener('change', function () {
        var val = nameInput.value.trim() || profile.site;
        send({
          type: 'PW_PROFILE_UPDATE',
          profileId: profile.id,
          name: val,
          matchMode: profile.matchMode,
          site: profile.site
        }).then(function (res) {
          if (!res || !res.ok) {
            nameInput.value = profile.name;
            toast((res && res.error) || '重命名失败', 'err');
            return;
          }
          profile.name = val;
          nameInput.value = val;
          toast('已重命名', 'ok');
        });
      });
      nameRow.appendChild(nameInput);
      head.appendChild(nameRow);

      var modeRow = h('div', 'field-row');
      modeRow.appendChild(h('span', 'field-label', '匹配模式'));
      modeRow.appendChild(matchModeSelect(profile));

      var siteInput = input('input input-sm input-site', profile.site, 'example.com:8080');
      siteInput.title = '站点标识，可写主机名（example.com）或主机名:端口（example.com:8080）';
      siteInput.addEventListener('change', function () {
        var next = schema.normalizeSite(siteInput.value) || profile.site;
        if (next === profile.site) { siteInput.value = profile.site; return; }
        var dup = (state.allProfiles || []).some(function (p) {
          return p.id !== profile.id
            && String(p.site).toLowerCase() === next.toLowerCase()
            && (p.matchMode || 'host') === (profile.matchMode || 'host');
        });
        if (dup) {
          siteInput.value = profile.site;
          toast('已存在相同站点与匹配模式的配置', 'err');
          return;
        }
        send({
          type: 'PW_PROFILE_UPDATE',
          profileId: profile.id,
          name: profile.name,
          matchMode: profile.matchMode,
          site: next
        }).then(function (res) {
          if (!res || !res.ok) {
            siteInput.value = profile.site;
            toast((res && res.error) || '修改站点失败', 'err');
            return;
          }
          profile.site = next;
          siteInput.value = next;
          toast('已更新站点标识', 'ok');
          refresh();
        });
      });
      modeRow.appendChild(siteInput);

      modeRow.appendChild(iconBtn('✕', 'is-danger', function () {
        if (!window.confirm('删除站点「' + profile.name + '」及其全部方案？')) return;
        send({ type: 'PW_PROFILE_DELETE', profileId: profile.id }).then(function () {
          toast('已删除站点', 'ok');
          refresh();
        });
      }));
      head.appendChild(modeRow);
      group.appendChild(head);

      /* HTTP 认证：只有已经存过凭据的站点才显示这几行 */
      var httpAuth = schema.normalizeHttpAuth(profile.httpAuth);
      if (httpAuth.enabled && httpAuth.username) {
        var authRow = h('div', 'item-row auth-edit');
        authRow.appendChild(h('span', 'item-label', 'HTTP 认证'));

        var authRevealed = !!state.revealed['httpauth:' + profile.id];
        var auInput = input('input input-sm', httpAuth.username, '账号');
        var apInput = input('input input-sm', httpAuth.password, '密码');
        if (!authRevealed) apInput.type = 'password';
        auInput.title = '浏览器原生登录弹窗的账号';
        apInput.title = '浏览器原生登录弹窗的密码';
        authRow.appendChild(auInput);
        authRow.appendChild(apInput);

        var eyeBtn = iconBtn(authRevealed ? '🙈' : '👁', '', function () {
          state.revealed['httpauth:' + profile.id] = !authRevealed;
          renderManage();
        });
        eyeBtn.title = authRevealed ? '隐藏' : '显示';
        authRow.appendChild(eyeBtn);

        var saveBtn = iconBtn('✓', '', function () {
          var user = auInput.value.trim();
          var pass = apInput.value;
          if (!user && pass) { toast('请填写账号', 'err'); return; }
          var req = !user
            ? send({ type: 'PW_HTTPAUTH_CLEAR', profileId: profile.id })
            : send({ type: 'PW_HTTPAUTH_SET', site: profile.site, username: user, password: pass });
          req.then(function (res) {
            if (!res || !res.ok) { toast((res && res.error) || '保存失败', 'err'); return; }
            toast(user ? '已保存 HTTP 认证凭据' : '已清除 HTTP 认证凭据', 'ok');
            refresh();
          });
        });
        saveBtn.title = '保存 HTTP 认证凭据';
        authRow.appendChild(saveBtn);

        group.appendChild(authRow);
      }

      /* 方案 */
      (profile.schemes || []).forEach(function (scheme) {
        var block = h('div', 'scheme-block');

        var row = h('div', 'scheme-row');
        row.appendChild(h('span', 'field-label', '方案名'));
        var nameInput2 = input('input input-sm scheme-name-input', scheme.name, '方案名');
        nameInput2.addEventListener('change', function () {
          send({
            type: 'PW_SCHEME_UPDATE',
            profileId: profile.id,
            schemeId: scheme.id,
            patch: { name: nameInput2.value.trim() || scheme.name }
          }).then(function (res) {
            if (res && res.ok) { scheme.name = nameInput2.value.trim(); toast('已重命名方案', 'ok'); }
          });
        });
        row.appendChild(nameInput2);

        row.appendChild(switchEl(scheme.autoFill, '点开即填', function (checked) {
          send({
            type: 'PW_SCHEME_UPDATE',
            profileId: profile.id,
            schemeId: scheme.id,
            patch: { autoFill: checked }
          }).then(function (res) {
            if (res && res.ok) { scheme.autoFill = checked; toast('已保存', 'ok'); }
          });
        }));

        row.appendChild(iconBtn('✕', 'is-danger', function () {
          if (!window.confirm('删除方案「' + scheme.name + '」？')) return;
          send({ type: 'PW_SCHEME_DELETE', profileId: profile.id, schemeId: scheme.id }).then(function () {
            toast('已删除方案', 'ok');
            refresh();
          });
        }));
        block.appendChild(row);

        /* 字段项 */
        (scheme.items || []).forEach(function (item) {
          var itemRow = h('div', 'item-row');
          itemRow.appendChild(h('span', 'item-label', item.label));

          var revealed = !!state.revealed[item.id];
          var valueInput = input('input input-sm', item.value, '填充内容');
          if (item.sensitive && !revealed) valueInput.type = 'password';
          valueInput.addEventListener('change', function () {
            send({
              type: 'PW_ITEM_UPDATE',
              profileId: profile.id,
              schemeId: scheme.id,
              itemId: item.id,
              patch: { value: valueInput.value }
            }).then(function (res) {
              if (res && res.ok) { item.value = valueInput.value; toast('已保存内容', 'ok'); }
            });
          });
          itemRow.appendChild(valueInput);

          if (item.sensitive) {
            var eye = iconBtn(revealed ? '🙈' : '👁', '', function () {
              state.revealed[item.id] = !state.revealed[item.id];
              renderManage();
            });
            eye.title = revealed ? '隐藏' : '显示';
            itemRow.appendChild(eye);
          }

          itemRow.appendChild(iconBtn('✕', 'is-danger', function () {
            if (!window.confirm('删除字段「' + item.label + '」？')) return;
            send({
              type: 'PW_ITEM_DELETE',
              profileId: profile.id,
              schemeId: scheme.id,
              itemId: item.id
            }).then(function () {
              toast('已删除字段', 'ok');
              refresh();
            });
          }));

          block.appendChild(itemRow);
        });

        if (!scheme.items || !scheme.items.length) {
          block.appendChild(h('p', 'hint', '该方案暂无字段。'));
        }

        group.appendChild(block);
      });

      if (!profile.schemes || !profile.schemes.length) {
        group.appendChild(h('p', 'hint', '该站点暂无方案。'));
      }

      wrap.appendChild(group);
    });
  }

  function matchModeSelect(profile) {
    var sel = document.createElement('select');
    sel.className = 'input input-sm';
    sel.title = '站点匹配方式';
    util.MATCH_MODES.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      sel.appendChild(opt);
    });
    sel.value = profile.matchMode || 'host';
    sel.addEventListener('change', function () {
      send({
        type: 'PW_PROFILE_UPDATE',
        profileId: profile.id,
        name: profile.name,
        matchMode: sel.value
      }).then(function (res) {
        if (res && res.ok) { profile.matchMode = sel.value; toast('已更新匹配方式', 'ok'); }
      });
    });
    return sel;
  }

  /* -------------------------------- 数据刷新 -------------------------------- */

  function refresh() {
    var matchReq = state.url
      ? send({ type: 'PW_MATCH', url: state.url })
      : Promise.resolve(null);

    return Promise.all([
      matchReq,
      send({ type: 'PW_CONFIG_GET' }),
      send({ type: 'PW_PICK_GET' }),
      state.url ? send({ type: 'PW_HTTPAUTH_STATE', url: state.url }) : Promise.resolve(null)
    ]).then(function (results) {
      var match = results[0];
      var cfg = results[1];
      var pick = results[2];
      var auth = results[3];

      if (match && match.ok) {
        state.host = match.host || state.host;
        state.profiles = match.profiles || [];
      }
      if (cfg && cfg.ok) state.allProfiles = (cfg.config && cfg.config.profiles) || [];
      state.pick = pick && pick.ok ? pick.session : null;
      if (auth && auth.ok) {
        state.httpAuth = {
          key: auth.key,
          pending: !!auth.pending,
          profileId: auth.profileId,
          username: auth.username || '',
          enabled: !!auth.enabled
        };
      }

      var chip = $('siteChip');
      chip.textContent = state.host || '未知站点';
      chip.title = state.url || '';

      renderFill();
      renderHttpAuth();
      renderRecord();
      renderManage();
    });
  }

  /* -------------------------------- 导入导出 -------------------------------- */

  function downloadJson(obj, filename) {
    var text = JSON.stringify(obj, null, 2);
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);

    function revoke() { setTimeout(function () { URL.revokeObjectURL(url); }, 30000); }

    if (chrome.downloads && chrome.downloads.download) {
      try {
        chrome.downloads.download({ url: url, filename: filename, saveAs: true }, revoke);
        return;
      } catch (e) { /* 回退到 a 标签 */ }
    }
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    revoke();
  }

  /* ------------------------------- 导出（可加密） ------------------------------- */

  function openExportModal() {
    var modal = $('exportModal');
    $('exportEncrypt').checked = false;
    $('exportPwdWrap').hidden = true;
    $('exportPassword').value = '';
    $('exportPassword2').value = '';
    $('exportErrors').hidden = true;
    $('exportPreview').textContent = '正在读取配置…';
    state.exportConfig = null;
    modal.hidden = false;

    send({ type: 'PW_CONFIG_GET' }).then(function (res) {
      if (!res || !res.ok) {
        $('exportErrors').hidden = false;
        $('exportErrors').textContent = '读取配置失败';
        return;
      }
      state.exportConfig = res.config || schema.emptyConfig();
      var st = schema.stats(state.exportConfig);
      if (!st.profiles) {
        $('exportErrors').hidden = false;
        $('exportErrors').textContent = '还没有任何配置可导出';
        return;
      }
      $('exportPreview').textContent = '将导出 ' + st.profiles + ' 个站点 / '
        + st.schemes + ' 套方案 / ' + st.items + ' 个字段';
    });
  }

  function doExportConfirm() {
    if (!state.exportConfig) { toast('配置尚未就绪', 'err'); return; }

    var errors = $('exportErrors');
    errors.hidden = true;
    var payload = schema.serialize(state.exportConfig);
    var stamp = util.fileStamp();

    if (!$('exportEncrypt').checked) {
      downloadJson(payload, 'pwhelper-config-' + stamp + '.json');
      $('exportModal').hidden = true;
      toast('已导出明文配置', 'ok');
      return;
    }

    var pwd = $('exportPassword').value;
    var pwd2 = $('exportPassword2').value;
    if (pwd.length < pwcrypto.MIN_PASSWORD) {
      errors.hidden = false;
      errors.textContent = '密码至少 ' + pwcrypto.MIN_PASSWORD + ' 位';
      return;
    }
    if (pwd !== pwd2) {
      errors.hidden = false;
      errors.textContent = '两次输入的密码不一致';
      return;
    }

    var btn = $('btnExportConfirm');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '加密中…';

    pwcrypto.encryptJson(payload, pwd).then(function (envelope) {
      downloadJson(envelope, 'pwhelper-config-' + stamp + '.enc.json');
      $('exportModal').hidden = true;
      toast('已导出加密配置，请牢记密码', 'ok');
    }).catch(function (err) {
      errors.hidden = false;
      errors.textContent = (err && err.message) || '加密失败';
    }).then(function () {
      btn.disabled = false;
      btn.textContent = label;
    });
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.readAsText(file, 'utf-8');
    });
  }

  function showImportError(message) {
    var errors = $('importErrors');
    errors.hidden = false;
    errors.textContent = message;
  }

  function hideImportSections() {
    $('importPwdWrap').hidden = true;
    $('importPreview').hidden = true;
    $('importErrors').hidden = true;
    $('importConflicts').hidden = true;
    $('conflictList').textContent = '';
  }

  function resetImportState() {
    state.importConfig = null;
    state.importRaw = null;
    state.importEncrypted = false;
    state.importConflicts = [];
    state.importDecisions = {};
    state.conflictReveal = false;
    $('btnConflictReveal').textContent = '显示明文';
  }

  function parseAndPreview(text) {
    hideImportSections();
    resetImportState();
    if (!text || !text.trim()) return;

    var raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      showImportError('JSON 解析失败：' + e.message);
      return;
    }

    // 加密配置：先要密码
    if (pwcrypto.isEncrypted(raw)) {
      state.importRaw = raw;
      state.importEncrypted = true;
      $('importPassword').value = '';
      $('importPwdWrap').hidden = false;
      $('importPassword').focus();
      return;
    }

    applyImportConfig(raw);
  }

  function applyImportConfig(raw) {
    var result = schema.validateImport(raw);
    if (!result.ok) {
      showImportError(result.errors.join('\n'));
      return;
    }

    state.importConfig = result.config;
    var st = schema.stats(result.config);
    var preview = $('importPreview');
    preview.hidden = false;
    preview.textContent = '校验通过：' + st.profiles + ' 个站点 / ' + st.schemes + ' 套方案 / ' + st.items + ' 个字段';

    updateConflicts();
  }

  /** 计算并渲染冲突列表（仅「合并」策略需要） */
  function updateConflicts() {
    var box = $('importConflicts');
    $('conflictList').textContent = '';
    state.importConflicts = [];
    state.importDecisions = {};

    if (!state.importConfig || state.strategy !== 'merge') {
      box.hidden = true;
      return;
    }

    send({ type: 'PW_CONFIG_GET' }).then(function (res) {
      var current = (res && res.ok && res.config) || schema.emptyConfig();
      var plan = schema.planMerge(current, state.importConfig);
      state.importConflicts = plan.conflicts;
      renderConflicts(plan.conflicts, plan.adds);
    });
  }

  function conflictValue(v, cf) {
    if (v === '') return '（空）';
    if (cf.sensitive && !state.conflictReveal) return util.mask(v);
    return util.truncate(v, 44);
  }

  function conflictOption(cf, choice, tagText, valueText, onPick) {
    var picked = (state.importDecisions[cf.key] || 'current') === choice;
    var label = h('label', 'conflict-opt' + (picked ? ' is-active' : ''));

    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = cf.key;
    radio.value = choice;
    radio.checked = picked;

    label.appendChild(radio);
    label.appendChild(h('span', 'conflict-dot'));
    label.appendChild(h('span', 'conflict-tag', tagText));
    label.appendChild(h('span', 'conflict-val', valueText));

    radio.addEventListener('change', function () {
      state.importDecisions[cf.key] = choice;
      Array.prototype.forEach.call(label.parentNode.querySelectorAll('.conflict-opt'), function (n) {
        n.classList.remove('is-active');
      });
      label.classList.add('is-active');
      if (onPick) onPick();
    });

    return label;
  }

  function renderConflicts(conflicts, adds) {
    var list = $('conflictList');
    var box = $('importConflicts');
    list.textContent = '';

    if (!conflicts || !conflicts.length) {
      box.hidden = true;
      return;
    }

    box.hidden = false;
    var extra = adds ? ('，另新增 ' + adds.profiles + ' 站点 / ' + adds.schemes + ' 方案 / ' + adds.items + ' 字段') : '';
    $('conflictTitle').textContent = '检测到 ' + conflicts.length + ' 处冲突' + extra;

    conflicts.forEach(function (cf) {
      var row = h('div', 'conflict-item');
      row.appendChild(h('div', 'conflict-path', cf.path));
      row.appendChild(h('div', 'conflict-field',
        cf.field + (cf.metaChanged ? '（值相同，敏感标记或定位信息不同）' : '')));
      row.appendChild(conflictOption(cf, 'current', '现有', conflictValue(cf.current, cf)));
      row.appendChild(conflictOption(cf, 'incoming', '导入', conflictValue(cf.incoming, cf)));
      list.appendChild(row);
    });
  }

  function setAllConflicts(choice) {
    (state.importConflicts || []).forEach(function (cf) { state.importDecisions[cf.key] = choice; });
    renderConflicts(state.importConflicts);
  }

  function doDecrypt() {
    var pwd = $('importPassword').value;
    if (!pwd) { showImportError('请输入解密密码'); return; }
    if (!state.importRaw) { showImportError('请先选择或粘贴加密配置'); return; }

    var btn = $('btnDecrypt');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '解密中…';
    $('importErrors').hidden = true;

    pwcrypto.decryptJson(state.importRaw, pwd).then(function (raw) {
      $('importPwdWrap').hidden = true;
      applyImportConfig(raw);
    }).catch(function (err) {
      showImportError((err && err.message) || '解密失败');
    }).then(function () {
      btn.disabled = false;
      btn.textContent = label;
    });
  }

  function doImportConfirm() {
    if (state.importEncrypted && !state.importConfig) { toast('请先输入密码解密配置', 'err'); return; }
    if (!state.importConfig) { toast('请先选择文件或粘贴配置', 'err'); return; }

    send({ type: 'PW_CONFIG_GET' }).then(function (res) {
      var current = (res && res.ok && res.config) || schema.emptyConfig();
      var merged = state.strategy === 'replace'
        ? schema.merge(current, state.importConfig, 'replace')
        : schema.applyMerge(current, state.importConfig, state.importDecisions);

      return send({ type: 'PW_REPLACE_ALL', config: merged }).then(function (r) {
        if (!r || !r.ok) { toast('导入失败', 'err'); return; }
        var st = schema.stats(merged);
        toast('导入成功：' + st.profiles + ' 站点 / ' + st.schemes + ' 方案 / ' + st.items + ' 字段', 'ok');
        $('importModal').hidden = true;
        hideImportSections();
        resetImportState();
        refresh();
      });
    });
  }

  function bindImportModal() {
    var modal = $('importModal');

    $('btnImport').addEventListener('click', function () {
      modal.hidden = false;
      $('importText').value = '';
      $('importFile').value = '';
      hideImportSections();
      resetImportState();
    });

    Array.prototype.forEach.call(modal.querySelectorAll('[data-close]'), function (node) {
      node.addEventListener('click', function () { modal.hidden = true; });
    });

    var srcSeg = $('importSource');
    Array.prototype.forEach.call(srcSeg.querySelectorAll('.seg-btn'), function (btn) {
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(srcSeg.querySelectorAll('.seg-btn'), function (b) { b.classList.remove('is-active'); });
        btn.classList.add('is-active');
        var isFile = btn.getAttribute('data-src') === 'file';
        $('importFileWrap').hidden = !isFile;
        $('importTextWrap').hidden = isFile;
      });
    });

    var strategySeg = $('importStrategy');
    Array.prototype.forEach.call(strategySeg.querySelectorAll('.seg-btn'), function (btn) {
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(strategySeg.querySelectorAll('.seg-btn'), function (b) { b.classList.remove('is-active'); });
        btn.classList.add('is-active');
        state.strategy = btn.getAttribute('data-strategy');
        updateConflicts();
      });
    });

    $('btnDecrypt').addEventListener('click', doDecrypt);
    $('importPassword').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doDecrypt();
    });
    $('btnConflictAllCurrent').addEventListener('click', function () { setAllConflicts('current'); });
    $('btnConflictAllIncoming').addEventListener('click', function () { setAllConflicts('incoming'); });
    $('btnConflictReveal').addEventListener('click', function () {
      state.conflictReveal = !state.conflictReveal;
      $('btnConflictReveal').textContent = state.conflictReveal ? '隐藏明文' : '显示明文';
      renderConflicts(state.importConflicts);
    });

    $('importFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      readFile(file).then(parseAndPreview).catch(function (err) {
        var errors = $('importErrors');
        errors.hidden = false;
        errors.textContent = err.message || '读取失败';
      });
    });

    $('importText').addEventListener('input', function (e) { parseAndPreview(e.target.value); });
    $('btnImportConfirm').addEventListener('click', doImportConfirm);
  }

  /* --------------------------------- 事件绑定 -------------------------------- */

  function bindExportModal() {
    var modal = $('exportModal');

    $('btnExport').addEventListener('click', openExportModal);

    $('exportEncrypt').addEventListener('change', function (e) {
      $('exportPwdWrap').hidden = !e.target.checked;
      if (e.target.checked) $('exportPassword').focus();
    });

    $('btnExportConfirm').addEventListener('click', doExportConfirm);
    $('exportPassword2').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doExportConfirm();
    });

    Array.prototype.forEach.call(modal.querySelectorAll('[data-close]'), function (node) {
      node.addEventListener('click', function () { modal.hidden = true; });
    });
  }

  /* ------------------------- 云同步（浏览器账号云端） ------------------------- */

  function showSyncError(msg) {
    var box = $('syncErrors');
    box.hidden = false;
    box.textContent = msg;
  }

  function fmtCloudTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso || '') : d.toLocaleString();
  }

  function renderSyncModal(info) {
    var cloud = (info && info.cloud) || {};
    var el = $('syncCloudInfo');

    if (cloud.exists) {
      var kb = Math.round((cloud.bytes || 0) / 102.4) / 10;
      el.textContent = '云端已有备份：' + fmtCloudTime(cloud.updatedAt)
        + ' · 来自 ' + (cloud.device || '未知设备')
        + ' · ' + kb + ' KB（密文）';
      $('btnSyncRestore').disabled = false;
      $('btnSyncClear').hidden = false;
    } else {
      el.textContent = '云端暂无备份。上传后，其他已登录同一浏览器账号的设备即可恢复。';
      $('btnSyncRestore').disabled = true;
      $('btnSyncClear').hidden = true;
    }

    $('syncRemember').checked = !!(info && info.remembered);
    $('btnSyncForget').hidden = !(info && info.remembered);
    $('syncMaster').placeholder = (info && info.remembered) ? '已记住主密码，不填则直接使用' : '至少 6 位';

    var hint = $('syncRememberHint');
    hint.hidden = !(info && info.remembered);
    if (info && info.remembered) {
      hint.textContent = '已在本机记住主密码；更换密码后请重新上传覆盖云端，或点「忘记主密码」清除。';
    }
  }

  function openSyncModal() {
    var modal = $('syncModal');
    modal.hidden = false;
    $('syncPreview').hidden = true;
    $('syncErrors').hidden = true;
    $('syncMaster').value = '';
    $('syncCloudInfo').textContent = '正在读取云端状态…';

    send({ type: 'PW_SYNC_STATE' }).then(function (res) {
      if (!res || !res.ok) {
        $('syncCloudInfo').textContent = '读取云端状态失败';
        showSyncError((res && res.error) || '');
        return;
      }
      state.syncInfo = res;
      renderSyncModal(res);
    });
  }

  function withBusy(btn, label, run) {
    var origin = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    return Promise.resolve().then(run).then(function () {
      btn.disabled = false;
      btn.textContent = origin;
    });
  }

  function refreshSyncState() {
    return send({ type: 'PW_SYNC_STATE' }).then(function (s) {
      if (s && s.ok) {
        state.syncInfo = s;
        renderSyncModal(s);
      }
    });
  }

  function doSyncUpload() {
    var pwd = $('syncMaster').value;
    var remembered = !!(state.syncInfo && state.syncInfo.remembered);
    if (!pwd && !remembered) { showSyncError('请先输入主密码（至少 6 位）'); return; }
    $('syncErrors').hidden = true;

    withBusy($('btnSyncUpload'), '上传中…', function () {
      return send({
        type: 'PW_SYNC_UPLOAD',
        masterPassword: pwd,
        remember: $('syncRemember').checked
      }).then(function (res) {
        if (!res || !res.ok) { showSyncError((res && res.error) || '上传失败'); return; }
        var st = res.stats || {};
        toast('已上传到云端：' + st.sites + ' 个站点 / ' + st.schemes + ' 套方案 / ' + st.items + ' 个字段', 'ok');
        $('syncPreview').hidden = false;
        $('syncPreview').textContent = '已上传 ' + res.chunkCount + ' 片密文，共 '
          + (Math.round((res.bytes || 0) / 102.4) / 10) + ' KB（' + fmtCloudTime(res.updatedAt) + '）';
        return refreshSyncState();
      });
    });
  }

  function doSyncRestore() {
    var pwd = $('syncMaster').value;
    var remembered = !!(state.syncInfo && state.syncInfo.remembered);
    if (!pwd && !remembered) { showSyncError('请先输入主密码'); return; }
    $('syncErrors').hidden = true;

    withBusy($('btnSyncRestore'), '读取中…', function () {
      return send({ type: 'PW_SYNC_DOWNLOAD', masterPassword: pwd }).then(function (res) {
        if (!res || !res.ok) { showSyncError((res && res.error) || '恢复失败'); return; }

        // 进入与文件导入一致的预览 / 冲突裁决流程，确认后才落库
        $('syncModal').hidden = true;
        $('importModal').hidden = false;
        $('importText').value = '';
        $('importFile').value = '';
        hideImportSections();
        resetImportState();
        applyImportConfig(res.config);
      });
    });
  }

  function doSyncClear() {
    if (!window.confirm('删除云端备份？本机配置不受影响，但其他设备将无法再恢复。')) return;
    send({ type: 'PW_SYNC_CLEAR' }).then(function (res) {
      if (!res || !res.ok) { showSyncError((res && res.error) || '清除失败'); return; }
      toast('已清除云端备份', 'ok');
      $('syncPreview').hidden = true;
      return refreshSyncState();
    });
  }

  function doSyncForget() {
    if (!window.confirm('清除本机记住的主密码？之后上传/恢复需要手动输入。')) return;
    send({ type: 'PW_SYNC_FORGET' }).then(function (res) {
      if (!res || !res.ok) { showSyncError((res && res.error) || '操作失败'); return; }
      toast('已清除本机记住的主密码', 'ok');
      return refreshSyncState();
    });
  }

  function bindSyncModal() {
    var modal = $('syncModal');

    $('btnSync').addEventListener('click', openSyncModal);
    $('btnSyncUpload').addEventListener('click', doSyncUpload);
    $('btnSyncRestore').addEventListener('click', doSyncRestore);
    $('btnSyncClear').addEventListener('click', doSyncClear);
    $('btnSyncForget').addEventListener('click', doSyncForget);
    $('syncMaster').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSyncUpload();
    });

    Array.prototype.forEach.call(modal.querySelectorAll('[data-close]'), function (node) {
      node.addEventListener('click', function () { modal.hidden = true; });
    });
  }

  function bindManageSearch() {
    var box = $('manageSearch');
    var clear = $('btnManageSearchClear');

    function apply() {
      state.manageQuery = box.value.trim();
      renderManage();
    }

    box.addEventListener('input', apply);
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { box.value = ''; apply(); }
    });

    clear.addEventListener('click', function () {
      box.value = '';
      apply();
      box.focus();
    });
  }

  function bindEvents() {
    bindExportModal();
    bindImportModal();
    bindHttpAuth();
    bindManageSearch();
    bindSyncModal();

    $('btnStartPick').addEventListener('click', function () {
      send({ type: 'PW_PICK_START', url: state.url }).then(function (res) {
        if (!res || !res.ok) {
          toast((res && res.error) || '启动拾取失败', 'err');
          return;
        }
        // 关闭弹窗，让用户回到页面点选输入框
        window.close();
      });
    });

    $('btnResumePick').addEventListener('click', function () {
      send({ type: 'PW_PICK_START', url: state.url }).then(function (res) {
        if (!res || !res.ok) {
          toast((res && res.error) || '启动拾取失败', 'err');
          return;
        }
        window.close();
      });
    });

    $('btnSaveScheme').addEventListener('click', function () {
      if (!state.pick || !state.pick.items.length) {
        toast('请先捕获至少一个输入框', 'err');
        return;
      }
      var name = $('schemeNameInput').value.trim();
      if (!name) { toast('请填写方案名称', 'err'); return; }

      send({
        type: 'PW_PICK_FINISH',
        schemeName: name,
        autoFill: $('autoFillInput').checked
      }).then(function (res) {
        if (!res || !res.ok) { toast((res && res.error) || '保存失败', 'err'); return; }
        toast('已保存方案「' + (res.schemeName || name) + '」，共 ' + res.count + ' 项', 'ok');
        refresh();
      });
    });

    $('btnCancelPick').addEventListener('click', function () {
      if (!window.confirm('放弃当前捕获的全部字段？')) return;
      send({ type: 'PW_PICK_CANCEL' }).then(function () {
        toast('已放弃');
        refresh();
      });
    });

    $('autoFillInput').addEventListener('change', function (e) {
      if (state.pick) state.pick.autoFill = e.target.checked;
    });

    $('schemeNameInput').addEventListener('change', function (e) {
      if (state.pick) state.pick.schemeName = e.target.value.trim();
    });
  }

  /* ---------------------------------- 启动 ---------------------------------- */

  function init() {
    bindTabs();
    bindEvents();

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      state.url = (tab && tab.url) || '';
      state.host = util.prettyHost(state.url) || util.hostOf(state.url);
      refresh().then(function () {
        if (state.pick && state.pick.items && state.pick.items.length) activateTab('record');
        runStartupAutoFill();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
