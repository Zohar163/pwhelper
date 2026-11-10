/**
 * 配置文件加解密（AES-GCM + PBKDF2-SHA256）。
 * 明文导出不经过本模块；加密导出时把 profiles 整体封进 base64 信封，
 * 只有 app / version / encrypted / exportedAt / cipher.* 是明文，便于识别与提示。
 */
(function (global) {
  'use strict';

  var PW = (global.PW = global.PW || {});
  var pwcrypto = (PW.crypto = {});

  pwcrypto.ALG = 'AES-GCM';
  pwcrypto.KDF = 'PBKDF2-SHA256';
  pwcrypto.ITERATIONS = 150000;
  pwcrypto.MIN_PASSWORD = 6;

  function subtle() {
    var c = global.crypto;
    if (!c || !c.subtle) throw new Error('当前环境不支持 Web Crypto，无法加密导出');
    return c.subtle;
  }

  pwcrypto.isAvailable = function () {
    return !!(global.crypto && global.crypto.subtle);
  };

  pwcrypto.isEncrypted = function (raw) {
    return !!(raw && raw.encrypted === true && raw.cipher && raw.cipher.data);
  };

  function toBase64(bytes) {
    var arr = new Uint8Array(bytes);
    var bin = '';
    for (var i = 0; i < arr.length; i += 1) bin += String.fromCharCode(arr[i]);
    return global.btoa(bin);
  }

  function fromBase64(str) {
    var bin = global.atob(String(str == null ? '' : str));
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function randomBytes(n) {
    var arr = new Uint8Array(n);
    global.crypto.getRandomValues(arr);
    return arr;
  }

  function deriveKey(password, salt, iterations, usages) {
    var enc = new global.TextEncoder();
    return subtle()
      .importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
      .then(function (baseKey) {
        return subtle().deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
          baseKey,
          { name: 'AES-GCM', length: 256 },
          false,
          usages
        );
      });
  }

  /**
   * 加密任意可 JSON 序列化的对象。
   * @returns {Promise<Object>} 信封对象（可直接 JSON.stringify 落盘）
   */
  pwcrypto.encryptJson = function (obj, password, meta) {
    var plain = new global.TextEncoder().encode(JSON.stringify(obj));
    var salt = randomBytes(16);
    var iv = randomBytes(12);

    return deriveKey(password, salt, pwcrypto.ITERATIONS, ['encrypt'])
      .then(function (key) {
        return subtle().encrypt({ name: 'AES-GCM', iv: iv }, key, plain);
      })
      .then(function (buf) {
        return {
          app: PW.schema ? PW.schema.APP : 'pwhelper',
          version: PW.schema ? PW.schema.VERSION : 1,
          encrypted: true,
          exportedAt: (meta && meta.exportedAt) || new Date().toISOString(),
          cipher: {
            alg: pwcrypto.ALG,
            kdf: pwcrypto.KDF,
            iterations: pwcrypto.ITERATIONS,
            salt: toBase64(salt),
            iv: toBase64(iv),
            data: toBase64(buf)
          }
        };
      });
  };

  /**
   * 解密信封。密码错误或文件损坏时 reject 一个中文错误的 Error。
   * @returns {Promise<Object>}
   */
  pwcrypto.decryptJson = function (envelope, password) {
    var c = envelope && envelope.cipher;
    if (!c || !c.data) return Promise.reject(new Error('这不是一个加密的配置文件'));

    var salt = fromBase64(c.salt);
    var iv = fromBase64(c.iv);
    var data = fromBase64(c.data);

    return deriveKey(password, salt, Number(c.iterations) || pwcrypto.ITERATIONS, ['decrypt'])
      .then(function (key) {
        return subtle().decrypt({ name: 'AES-GCM', iv: iv }, key, data);
      })
      .then(function (buf) {
        return JSON.parse(new global.TextDecoder().decode(buf));
      })
      .catch(function () {
        throw new Error('密码错误，或文件已损坏');
      });
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
