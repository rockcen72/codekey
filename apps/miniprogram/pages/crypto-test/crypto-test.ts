/**
 * Crypto POC — validates the formal utils/crypto.ts module in WeChat runtime.
 * No self-contained code; everything comes from the production crypto module.
 */

// ── Load formal crypto module (polyfill + vendor require baked in) ─
let cryptoModule: any = null;
try { cryptoModule = require('../../utils/crypto'); } catch (_: any) {}

function b64(bytes: Uint8Array): string {
  return wx.arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

interface TR { name: string; passed: boolean; detail: string; }
Page({
  data: { results: [] as TR[], passed: 0, failed: 0, ready: false, debugInfo: '' },

  async onLoad() {
    const r: TR[] = []; let p = 0, f = 0; const dbg: string[] = [];
    const rec = (n: string, ok: boolean, d: string) => { r.push({name:n,passed:ok,detail:d}); ok?p++:f++; };

    rec('utils/crypto loaded', !!cryptoModule, cryptoModule ? Object.keys(cryptoModule).slice(0,5).join(',') : 'null');
    if (!cryptoModule) { this.setData({results:r,passed:p,failed:f,ready:true,debugInfo:''}); return; }
    const { generateContentKey, keyFromHex, encrypt, decrypt, buildAad } = cryptoModule;
    const hexToBytes = keyFromHex; // alias

    if (typeof cryptoModule.encrypt === 'function') {
      // Test 1: Roundtrip with fixed key + IV
      try {
        const key = hexToBytes('abababababababababababababababababababababababababababababababab');
        const iv = new Uint8Array(12).fill(0x01);
        const aad = buildAad({v:1,keyId:'canonical',deviceId:'d',sessionId:'s',eventId:'e',eventType:'user_prompt'});
        const pt = 'Hello from WeChat E2E';
        const sealed = await encrypt(pt, key, aad);
        const decrypted = await decrypt(sealed, key, aad);
        rec('Fixed key roundtrip', decrypted === pt, 'sealed=' + b64(key).slice(0,16) + '..., "' + decrypted + '"');
        dbg.push('fixed-sealed=' + (typeof sealed === 'string' ? sealed.slice(0,24) : ''));
      } catch (e: any) { rec('Fixed key roundtrip', false, (e.message||'').slice(0,80)); }

      // Test 2: generateContentKey (async, full production flow)
      try {
        const kp = await generateContentKey();
        rec('generateContentKey', kp.keyHex.length === 64 && kp.keyId.length > 0, 'key=' + kp.keyHex.slice(0,12) + '... id=' + kp.keyId.slice(0,8) + '...');
        const aad = buildAad({v:1,keyId:kp.keyId,deviceId:'d',sessionId:'s',eventId:'e',eventType:'user_prompt'});
        const pt = 'Generated key works! 🌍';
        const sealed = await encrypt(pt, kp.keyBytes, aad);
        const decrypted = await decrypt(sealed, kp.keyBytes, aad);
        rec('GenerateContentKey → roundtrip', decrypted === pt, 'sealed len=' + sealed.length + ', ok');
        dbg.push('gen-key=' + kp.keyHex.slice(0,8));
      } catch (e: any) { rec('GenerateContentKey → roundtrip', false, (e.message||'').slice(0,80)); }
    }

    // Test 3: wx.getRandomValues structure
    try {
      const raw: any = await wx.getRandomValues({ length: 32 });
      const keys = Object.keys(raw).join(',');
      const hasRV = typeof raw.randomValues;
      const hasData = typeof raw.data;
      const val = raw.randomValues || raw.data;
      const isValid = val && (val.byteLength === 32 || val.length === 32);
      rec('wx.getRandomValues', !!isValid, 'keys=' + keys + ' randomValues=' + hasRV + ' data=' + hasData + ' valid=' + !!isValid);
      dbg.push('rng-keys=' + keys);
    } catch (e: any) { rec('wx.getRandomValues', false, (e.message||'').slice(0,80)); }

    this.setData({ results: r, passed: p, failed: f, ready: true, debugInfo: dbg.join(' | ') });
  },
});
