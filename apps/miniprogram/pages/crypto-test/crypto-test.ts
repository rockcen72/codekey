/**
 * Crypto POC — runtime diagnostics with TextEncoder/TextDecoder polyfill
 * for @noble/ciphers compatibility in WeChat mini program.
 */

// ── Polyfill TextEncoder/TextDecoder (UTF-8 only) ─────────
// WeChat mini program (JavaScriptCore / V8 isolated) lacks these globals.
// Lightweight polyfill: ~1KB, UTF-8 only, sufficient for @noble/ciphers.

// WeChat 没有 TextEncoder。加一个到 globalThis 上让 @noble/ciphers 能找到。
if (typeof TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = class {
    encode(str: string): Uint8Array {
      const encoded = unescape(encodeURIComponent(str));
      const len = encoded.length;
      const arr = new Uint8Array(len);
      for (let i = 0; i < len; i++) arr[i] = encoded.charCodeAt(i);
      return arr;
    }
  };
}
if (typeof TextDecoder === 'undefined') {
  (globalThis as any).TextDecoder = class {
    decode(buf: ArrayBuffer | Uint8Array): string {
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      // decodeURIComponent cannot decode lone bytes; escape() + decodeURIComponent
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      try { return decodeURIComponent(escape(binary)); } catch { return binary; }
    }
  };
}

function b64Encode(bytes: Uint8Array): string {
  if (typeof wx !== 'undefined' && wx.arrayBufferToBase64) {
    return wx.arrayBufferToBase64(bytes.buffer);
  }
  // Fallback for browser/debug
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return typeof btoa !== 'undefined' ? btoa(bin) : 'btoa-not-available';
}

function b64Decode(b64: string): Uint8Array {
  if (typeof wx !== 'undefined' && wx.base64ToArrayBuffer) {
    return new Uint8Array(wx.base64ToArrayBuffer(b64));
  }
  if (typeof atob !== 'undefined') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  throw new Error('no base64 decoder available');
}

Page({
  data: { lines: [] as string[], ready: false },

  async onLoad() {
    const lines: string[] = [];
    const add = (s: string) => lines.push(s);

    try {
      add('1. Page loaded OK');
      add('2. wx type: ' + (typeof wx));
      add('3. wx.arrayBufferToBase64: ' + (typeof wx !== 'undefined' && typeof (wx as any).arrayBufferToBase64));

      // 4. Base64 roundtrip
      const raw = new Uint8Array([72, 101, 108, 108, 111]);
      const b64 = b64Encode(raw);
      add('4. b64Encode([72,101,108,108,111]) = ' + b64);
      const decoded = b64Decode(b64);
      add('5. decoded length = ' + decoded.length + ' first=' + decoded[0]);

      // 5. hex encoding
      const hex = 'ab'.repeat(32);
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
      add('6. hex decoded: length=' + bytes.length + ' bytes[0]=0x' + bytes[0].toString(16));

      // 6. XOR roundtrip
      const iv = new Uint8Array(12);
      for (let i = 0; i < 12; i++) iv[i] = 0x01;
      const msg = 'Hello E2E!';
      const ct = new Uint8Array(msg.length);
      for (let i = 0; i < msg.length; i++) ct[i] = msg.charCodeAt(i) ^ bytes[i % 32] ^ iv[i % 12];
      // sealed = iv + ct
      const sealed = new Uint8Array(12 + ct.length);
      sealed.set(iv, 0);
      sealed.set(ct, 12);
      const sealedB64 = b64Encode(sealed);
      add('7. XOR sealed b64 = ' + sealedB64.slice(0, 30) + '...');

      // decrypt
      const sealedBytes = b64Decode(sealedB64);
      const decIv = sealedBytes.slice(0, 12);
      const decCt = sealedBytes.slice(12);
      let decText = '';
      for (let i = 0; i < decCt.length; i++) {
        decText += String.fromCharCode(decCt[i] ^ bytes[i % 32] ^ decIv[i % 12]);
      }
      add('8. XOR decrypted = "' + decText + '"');
      add('9. Roundtrip: ' + (decText === msg ? 'PASS' : 'FAIL'));
      add('');
      add('ALL ' + lines.filter(l => l.includes('FAIL') || l.includes('PASS')).length + ' tests PASSED');
    } catch (e: any) {
      add('CRASH: ' + (e.message || String(e)));
    }

    // ── 7. Web Crypto API ────────────────────────────────
    try {
      const hasSubtle = typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
      add('10. crypto.subtle: ' + (hasSubtle ? 'AVAILABLE' : 'not available'));
      if (hasSubtle) {
        // Try encrypt-decrypt roundtrip with AES-GCM
        const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(0xAB),
          { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
          new TextEncoder().encode('Hello Crypto!'));
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        add('11. WebCrypto AES-GCM: ' + (new TextDecoder().decode(pt) === 'Hello Crypto!' ? 'PASS' : 'FAIL'));
      }
    } catch (e: any) {
      add('10b. WebCrypto error: ' + (e.message || String(e)).slice(0, 80));
    }

    // ── 8. @noble/ciphers (from local vendor/ copy) ──────
    // WeChat runtime: No TextEncoder/TextDecoder, no crypto.subtle.
    // Use manual UTF-8 encode/decode for the test payload.
    try {
      add('12. trying vendor/@noble/ciphers...');
      const noble = require('../../vendor/aes.js');
      const utils = require('../../vendor/utils.js');
      add('13. modules loaded: gcm=' + (typeof noble.gcm) + ' hexToBytes=' + (typeof utils.hexToBytes));
      // Test with direct Uint8Array to avoid TextEncoder entirely
      if (typeof noble.gcm === 'function') {
        const key = new Uint8Array(32).fill(0xAB);
        const iv = new Uint8Array(12).fill(0x01);
        const aad = new TextEncoder().encode(JSON.stringify({ v:1, keyId:'test' }));
        const cipher = noble.gcm(key, iv, aad);
        const pt = new TextEncoder().encode('Hello noble E2E');
        const sealed = cipher.encrypt(pt);
        const decipher = noble.gcm(key, iv, aad);
        const decrypted = decipher.decrypt(sealed);
        const decText = new TextDecoder().decode(decrypted);
        add('14. @noble roundtrip: ' + (decText === 'Hello noble E2E' ? 'PASS' : 'FAIL'));
        add('15. sealed: ' + sealed.length + ' bytes, output: "' + decText + '"');
      } else {
        add('13b. gcm is not a function: ' + typeof noble.gcm);
      }
    } catch (e: any) {
      add('12b. @noble error: ' + (e.message || String(e)).slice(0, 100));
    }

    this.setData({ lines, ready: true });
  },
});
