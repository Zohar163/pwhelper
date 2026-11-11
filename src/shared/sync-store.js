/**
 * 云同步核心：把整套配置加密后分片写入 chrome.storage.sync（浏览器账号云端）。
 *
 * 为什么分片：storage.sync 单条上限 8192 字节，加密信封是 base64 文本，
 * 整套配置通常远超单条配额，按片写入 pwhelper.sync.chunk.0..n。
 * 完整性：meta 里带 djb2 校验和与分片数，拼接后验证，缺片/损坏时明确报错。
 *
 * 手动同步：只提供上传 / 恢复 / 清除，不监听 storage.onChanged 自动互相覆盖，
 * 多设备间以用户手动操作为准。
 */
(function (global) {
  'use strict';

  var PW = (global.PW = global.PW || {});
  var util = PW.util;
  var pwcrypto = PW.crypto;

  var syncStore = (PW.syncStore = {});

  syncStore.META_KEY = 'pwhelper.sync.meta';
  syncStore.CHUNK_PREFIX = 'pwhelper.sync.chunk.';
  syncStore.MASTER_KEY = 'pwhelper.sync.master';

  // 每片字符数。分片内容是 base64/JSON（纯 ASCII），1 字符 = 1 字节，
  // 6000 留出充足余量（单条上限 8192 字节）
  var CHUNK_SIZE = 6000;

  /* ------------------------------ storage.sync 封装 ------------------------------ */

  function syncError(raw) {
    var msg = String(raw || '');
    if (/QUOTA_BYTES_PER_ITEM/i.test(msg)) {
      return new Error('云端单条数据超出限制，请改用「导出」生成文件迁移');
    }
    if (/QUOTA/i.test(msg)) {
      return new Error('浏览器账号云同步空间不足（总配额约 100KB）。可先在「管理」页删除不用的站点，或改用「导出」文件迁移');
    }
    if (/MAX_(ITEMS|WRITE_OPERATIONS|SYNC_KEYS)/i.test(msg)) {
      return new Error('云端写入次数或条目数超限，请稍后再试');
    }
    return new Error('云同步失败：' + msg + '。请确认浏览器已登录账号并开启了同步');
  }

  function syncGet(keys) {
    return new Promise(function (resolve, reject) {
      chrome.storage.sync.get(keys, function (obj) {
        if (chrome.runtime.lastError) return reject(syncError(chrome.runtime.lastError.message));
        resolve(obj || {});
      });
    });
  }

  function syncSet(obj) {
    return new Promise(function (resolve, reject) {
      chrome.storage.sync.set(obj, function () {
        if (chrome.runtime.lastError) return reject(syncError(chrome.runtime.lastError.message));
        resolve(true);
      });
    });
  }

  function syncRemove(keys) {
    return new Promise(function (resolve) {
      chrome.storage.sync.remove(keys, function () {
        // 清理失败不致命：旧分片会随着下次上传被覆盖或残留
        resolve(!chrome.runtime.lastError);
      });
    });
  }

  /* ------------------------------ 校验与设备标签 ------------------------------ */

  function checksum(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i += 1) h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }

  function deviceLabel() {
    var ua = (global.navigator && global.navigator.userAgent) || '';
    var os = /Windows/.test(ua) ? 'Windows'
      : /Mac OS/.test(ua) ? 'macOS'
      : /CrOS/.test(ua) ? 'ChromeOS'
      : /Android/.test(ua) ? 'Android'
      : /Linux/.test(ua) ? 'Linux' : '未知系统';
    var m = /Chrome\/(\d+)/.exec(ua);
    return os + (m ? ' · Chrome ' + m[1] : '');
  }

  /** 现存的分片键（不含 meta） */
  function listChunkKeys() {
    return syncGet(null).then(function (obj) {
      return Object.keys(obj).filter(function (k) {
        return k.indexOf(syncStore.CHUNK_PREFIX) === 0;
      });
    });
  }

  /* --------------------------------- 上传 --------------------------------- */

  /**
   * 加密整套配置并分片写入云端。
   * @param {Object} config 已规范化的完整配置
   * @param {string} masterPassword 主密码（至少 pwcrypto.MIN_PASSWORD 位）
   * @param {boolean} remember 是否把主密码记在本机（storage.local，明文）
   * @returns {Promise<{chunkCount:number, bytes:number, updatedAt:string, device:string}>}
   */
  syncStore.upload = function (config, masterPassword, remember) {
    if (!pwcrypto.isAvailable()) return Promise.reject(new Error('当前环境不支持 Web Crypto，无法加密上传'));
    var pwd = String(masterPassword || '');
    if (pwd.length < pwcrypto.MIN_PASSWORD) {
      return Promise.reject(new Error('主密码至少 ' + pwcrypto.MIN_PASSWORD + ' 位'));
    }

    return pwcrypto.encryptJson(config, pwd, { exportedAt: util.nowIso() }).then(function (envelope) {
      var text = JSON.stringify(envelope);
      var chunks = [];
      for (var i = 0; i < text.length; i += CHUNK_SIZE) chunks.push(text.slice(i, i + CHUNK_SIZE));

      var meta = {
        app: util.APP,
        type: 'sync',
        schemaVersion: (PW.schema && PW.schema.VERSION) || 1,
        updatedAt: util.nowIso(),
        device: deviceLabel(),
        bytes: text.length,
        chunkCount: chunks.length,
        checksum: checksum(text),
        encrypted: true
      };

      return listChunkKeys().then(function (oldKeys) {
        var payload = {};
        payload[syncStore.META_KEY] = meta;
        chunks.forEach(function (c, idx) { payload[syncStore.CHUNK_PREFIX + idx] = c; });

        // 一次批量写入 meta 与全部分片，避免中途失败留下半套数据；
        // 旧备份比新备份多出的分片单独清理
        return syncSet(payload).then(function () {
          var stale = oldKeys.filter(function (k) {
            var idx = Number(k.slice(syncStore.CHUNK_PREFIX.length));
            return !(idx >= 0 && idx < chunks.length);
          });
          var cleanup = stale.length ? syncRemove(stale) : Promise.resolve(true);

          return cleanup.then(function () {
            var tail = remember
              ? syncStore.rememberMaster(pwd)
              : syncStore.forgetMaster();
            return tail.catch(function () { /* 记忆失败不影响上传结果 */ }).then(function () {
              return { chunkCount: chunks.length, bytes: text.length, updatedAt: meta.updatedAt, device: meta.device };
            });
          });
        });
      });
    });
  };

  /* --------------------------------- 云端状态 --------------------------------- */

  syncStore.cloudState = function () {
    return syncGet([syncStore.META_KEY]).then(function (obj) {
      var meta = obj[syncStore.META_KEY];
      if (!meta || !meta.chunkCount) return { exists: false };
      return {
        exists: true,
        updatedAt: meta.updatedAt,
        device: meta.device || '',
        bytes: meta.bytes || 0,
        chunkCount: meta.chunkCount,
        encrypted: meta.encrypted !== false
      };
    });
  };

  /** 拼接分片并校验完整性，返回加密信封（不解密） */
  syncStore.readEnvelope = function () {
    return syncGet([syncStore.META_KEY]).then(function (obj) {
      var meta = obj[syncStore.META_KEY];
      if (!meta || !meta.chunkCount) throw new Error('云端还没有备份数据，请先在任意一台设备上上传');

      var keys = [];
      for (var i = 0; i < meta.chunkCount; i += 1) keys.push(syncStore.CHUNK_PREFIX + i);

      return syncGet(keys).then(function (chunkObj) {
        var parts = [];
        for (var i = 0; i < meta.chunkCount; i += 1) {
          var piece = chunkObj[syncStore.CHUNK_PREFIX + i];
          if (typeof piece !== 'string') {
            throw new Error('云端数据不完整（缺少第 ' + (i + 1) + ' 片），请在原设备重新上传');
          }
          parts.push(piece);
        }

        var text = parts.join('');
        if (meta.checksum && checksum(text) !== String(meta.checksum)) {
          throw new Error('云端数据校验失败，可能已被破坏，请在原设备重新上传');
        }

        var envelope;
        try {
          envelope = JSON.parse(text);
        } catch (e) {
          throw new Error('云端数据解析失败，请在原设备重新上传');
        }
        if (!pwcrypto.isEncrypted(envelope)) throw new Error('云端数据不是有效的加密备份');
        return envelope;
      });
    });
  };

  /* --------------------------------- 清除 --------------------------------- */

  /** 删除云端备份（meta + 全部分片），不影响本机配置 */
  syncStore.clear = function () {
    return listChunkKeys().then(function (keys) {
      var all = keys.concat([syncStore.META_KEY]);
      return syncRemove(all).then(function () { return true; });
    });
  };

  /* ------------------------------ 主密码记忆（本机） ------------------------------ */

  function localGet(key) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(key, function (obj) {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(obj ? obj[key] : null);
      });
    });
  }

  function localSet(obj) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set(obj, function () {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(true);
      });
    });
  }

  function localRemove(key) {
    return new Promise(function (resolve) {
      chrome.storage.local.remove(key, function () { resolve(true); });
    });
  }

  /** 主密码明文保存在本机 storage.local（与本机配置本身同一信任域，云端始终是密文） */
  syncStore.rememberMaster = function (pwd) {
    return localSet({ [syncStore.MASTER_KEY]: { v: String(pwd), updatedAt: util.nowIso() } });
  };

  syncStore.getMaster = function () {
    return localGet(syncStore.MASTER_KEY).then(function (rec) {
      return rec && rec.v ? String(rec.v) : '';
    });
  };

  syncStore.forgetMaster = function () {
    return localRemove(syncStore.MASTER_KEY);
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
