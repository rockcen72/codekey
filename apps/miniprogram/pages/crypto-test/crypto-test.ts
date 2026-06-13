/**
 * Crypto POC — @noble/ciphers AES-256-GCM in WeChat runtime.
 * Uses vendor require (proven PASS) + async wx.getRandomValues.
 */

// ── Polyfill TextEncoder ────────────────────────────────
if (typeof TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = class {
    encode(s: string): Uint8Array {
      const enc = unescape(encodeURIComponent(s));
      const b = new Uint8Array(enc.length);
      for (let i = 0; i < enc.length; i++) b[i] = enc.charCodeAt(i);
      return b;
    }
  };
}

// ── Load @noble/ciphers (same pattern that PASSED earlier) ─
let nobleGcm: any = null;
try { nobleGcm = require('../../vendor/aes.js'); if (nobleGcm && nobleGcm.gcm) nobleGcm = nobleGcm.gcm; } catch (_: any) {}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('Invalid key hex');
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = parseInt(hex.substring(i*2,i*2+2), 16);
  return b;
}
function bytesToHex(b: Uint8Array): string { let h=''; for(let i=0;i<b.length;i++) h+=b[i].toString(16).padStart(2,'0'); return h; }
function b64(bytes: Uint8Array): string {
  return wx.arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
function buildAad(f: {v:number;keyId:string;deviceId:string;sessionId:string;eventId:string;eventType:string}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(f));
}

interface TR { name: string; passed: boolean; detail: string; }
Page({
  data: { results: [] as TR[], passed: 0, failed: 0, ready: false, debugInfo: '' },

  async onLoad() {
    const r: TR[] = []; let p = 0, f = 0; const dbg: string[] = [];
    const rec = (n: string, ok: boolean, d: string) => { r.push({name:n,passed:ok,detail:d}); ok?p++:f++; };

    rec('@noble gcm loaded', typeof nobleGcm === 'function', typeof nobleGcm);

    if (typeof nobleGcm === 'function') {
      // Test 1: Roundtrip with fixed key + IV (same as Node canonical)
      try {
        const key = hexToBytes('abababababababababababababababababababababababababababababababab');
        const iv = new Uint8Array(12).fill(0x01);
        const aad = buildAad({v:1,keyId:'00000000-0000-0000-0000-000000000001',deviceId:'canonical-device',sessionId:'00000000-0000-0000-0000-000000000002',eventId:'00000000-0000-0000-0000-000000000003',eventType:'user_prompt'});
        const cipher = nobleGcm(key, iv, aad);
        const pt = 'Hello from WeChat E2E';
        const sealed = cipher.encrypt(new TextEncoder().encode(pt));
        const decipher = nobleGcm(key, iv, aad);
        const dec = decipher.decrypt(sealed);
        const txt = decodeURIComponent(escape(String.fromCharCode(...dec)));
        rec('Fixed key roundtrip', txt === pt, 'sealed=' + b64(sealed).slice(0,20) + '..., "' + txt + '"');
        dbg.push('fixed-sealed=' + b64(sealed));
      } catch (e: any) { rec('Fixed key roundtrip', false, (e.message||'').slice(0,80)); }

      // Test 2: Random key + IV via wx.getRandomValues
      try {
        const rawKey: any = await wx.getRandomValues({ length: 32 });
        const keyAB: ArrayBuffer = rawKey.randomValues || rawKey.data || rawKey;
        const key = new Uint8Array(keyAB.slice(0,32));
        const rawIv: any = await wx.getRandomValues({ length: 12 });
        const ivAB: ArrayBuffer = rawIv.randomValues || rawIv.data || rawIv;
        const iv = new Uint8Array(ivAB.slice(0,12));
        const aad = buildAad({v:1,keyId:'rng-test',deviceId:'d',sessionId:'s',eventId:'e',eventType:'user_prompt'});
        const cipher = nobleGcm(key, iv, aad);
        const pt = 'Random key works! 🌍';
        const sealed = cipher.encrypt(new TextEncoder().encode(pt));
        const decipher = nobleGcm(key, iv, aad);
        const dec = decipher.decrypt(sealed);
        const txt = decodeURIComponent(escape(String.fromCharCode(...dec)));
        rec('Random key roundtrip', txt === pt, 'sealed=' + b64(sealed).slice(0,16) + '..., ok');
        dbg.push('rng-key=' + bytesToHex(key).slice(0,8));
        dbg.push('rng-iv=' + bytesToHex(iv).slice(0,8));
      } catch (e: any) { rec('Random key roundtrip', false, (e.message||'').slice(0,80)); }
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
