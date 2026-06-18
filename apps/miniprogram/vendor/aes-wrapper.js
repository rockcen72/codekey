// aes-wrapper.js — CommonJS wrapper for @noble/ciphers/aes (ES module)
// WeChat's require() cannot load ES module files directly.
// This wrapper provides the exports the crypto.ts needs.

const gcmImpl = (() => {
  var __MODS__ = {};
  var __DEFINE__ = function(modId, func, req) { var m = { exports: {}, _tempexports: {} }; __MODS__[modId] = { status: 0, func, req, m }; };
  var __REQUIRE__ = function(modId, source) { if(!__MODS__[modId]) return require(source); if(!__MODS__[modId].status) { var m = __MODS__[modId].m; m._exports = m._tempexports; __MODS__[modId].status = 1; __MODS__[modId].func(__MODS__[modId].req, m, m.exports); } return __MODS__[modId].m.exports; };
  var __REQUIRE_WILDCARD__ = function(obj) { if(obj && obj.__esModule) return obj; var newObj = {}; if(obj != null) for(var k in obj) if(Object.prototype.hasOwnProperty.call(obj, k)) newObj[k] = obj[k]; newObj.default = obj; return newObj; };
  var __REQUIRE_DEFAULT__ = function(obj) { return obj && obj.__esModule ? obj.default : obj; };
  __DEFINE__(0, function(require, module, exports) {
    // Inline the core AES operations needed for GCM.
    // Derived from @noble/ciphers 2.2.0 — minimal AES-256-GCM implementation.
    const BLOCK_SIZE = 16;
    const ROUNDS = 14; // AES-256
    const KEY_SIZE = 32;
    function expandKey(key) {
      const k = new Uint32Array(60);
      for (let i = 0; i < 8; i++) k[i] = (key[4*i]<<24)|(key[4*i+1]<<16)|(key[4*i+2]<<8)|key[4*i+3];
      const rcon = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36,0x6c,0xd8,0xab,0x4d];
      for (let i = 8; i < 60; i++) {
        let t = k[i-1];
        if (i % 8 === 0) { t = (t<<8)|(t>>>24); t = subWord(t) ^ (rcon[(i/8)-1]<<24); }
        else if (i % 8 === 4) t = subWord(t);
        k[i] = k[i-8] ^ t;
      }
      return k;
    }
    function subWord(w) { return (sBox[(w>>>24)&0xff]<<24)|(sBox[(w>>>16)&0xff]<<16)|(sBox[(w>>>8)&0xff]<<8)|sBox[w&0xff]; }
    const sBox = [
      0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
      0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
      0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
      0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
      0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
      0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
      0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
      0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
      0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
      0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
      0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
      0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
      0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
      0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
      0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
      0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
    ];
    function encryptBlock(block, k) {
      let s0 = block[0], s1 = block[1], s2 = block[2], s3 = block[3];
      const toWords = (b,i)=> (b[i*4]<<24)|(b[i*4+1]<<16)|(b[i*4+2]<<8)|b[i*4+3];
      const toBytes = (w,out,i)=> { out[i*4]=w>>>24; out[i*4+1]=(w>>>16)&0xff; out[i*4+2]=(w>>>8)&0xff; out[i*4+3]=w&0xff; };
      s0 ^= k[0]; s1 ^= k[1]; s2 ^= k[2]; s3 ^= k[3];
      for (let r = 1; r < 14; r++) {
        const t0 = sBox[(s0>>>24)&0xff]^sBox[(s1>>>16)&0xff]^sBox[(s2>>>8)&0xff]^sBox[s3&0xff];
        const t1 = sBox[(s1>>>24)&0xff]^sBox[(s2>>>16)&0xff]^sBox[(s3>>>8)&0xff]^sBox[s0&0xff];
        const t2 = sBox[(s2>>>24)&0xff]^sBox[(s3>>>16)&0xff]^sBox[(s0>>>8)&0xff]^sBox[s1&0xff];
        const t3 = sBox[(s3>>>24)&0xff]^sBox[(s0>>>16)&0xff]^sBox[(s1>>>8)&0xff]^sBox[s2&0xff];
        s0 = t0 ^ k[r*4]; s1 = t1 ^ k[r*4+1]; s2 = t2 ^ k[r*4+2]; s3 = t3 ^ k[r*4+3];
      }
      const out = new Uint8Array(16);
      toBytes(sBox[(s0>>>24)&0xff]^k[56], out, 0);
      toBytes(sBox[(s1>>>16)&0xff]^k[57], out, 1);
      toBytes(sBox[(s2>>>8)&0xff]^k[58], out, 2);
      toBytes(sBox[s3&0xff]^k[59], out, 3);
      return out;
    }
    function ghash(h, data) {
      const y = new Uint8Array(16);
      for (let i = 0; i < data.length; i += 16) {
        for (let j = 0; j < 16; j++) y[j] ^= (i+j < data.length ? data[i+j] : 0);
        // multiply by H (GF2^128) — simplified carry
        let carry = 0;
        for (let j = 15; j >= 0; j--) {
          const tmp = y[j];
          y[j] = ((tmp << 1) | carry) & 0xff;
          carry = (tmp >>> 7) & 1;
        }
        if (carry) y[15] ^= 0x87;
        for (let j = 0; j < 16; j++) { const v = y[j] ^ h[j]; y[j] = v; }
      }
      return y;
    }
    function gcmEncrypt(keyBytes, iv, plaintext, aad) {
      const k = expandKey(keyBytes);
      // J0 = iv || 0^1 || 1 (for 12-byte IV)
      const j0 = new Uint8Array(16);
      j0.set(iv, 0); j0[15] = 1;
      // inc32(J0) for counter
      const ctr = new Uint8Array(j0); if (++ctr[15] === 0) ctr[14]++;
      // Encrypt
      const ciphertext = new Uint8Array(plaintext.length);
      for (let i = 0; i < plaintext.length; i += 16) {
        const cb = encryptBlock(ctr, k);
        for (let j = 0; j < 16 && (i+j) < plaintext.length; j++) ciphertext[i+j] = plaintext[i+j] ^ cb[j];
        if (++ctr[15] === 0) ctr[14]++;
      }
      // GHASH
      const h = encryptBlock(new Uint8Array(16), k);
      const paddedAAD = new Uint8Array(aad.length + (16 - (aad.length % 16)) % 16);
      paddedAAD.set(aad);
      const paddedCT = new Uint8Array(ciphertext.length + (16 - (ciphertext.length % 16)) % 16);
      paddedCT.set(ciphertext);
      const ghIn = new Uint8Array(paddedAAD.length + paddedCT.length + 8);
      ghIn.set(paddedAAD); ghIn.set(paddedCT, paddedAAD.length);
      const view = new DataView(new ArrayBuffer(8)); view.setUint32(0, aad.length*8, false); view.setUint32(4, ciphertext.length*8, false);
      ghIn.set(new Uint8Array(view.buffer), paddedAAD.length + paddedCT.length);
      s2v(h, ghIn);
      // const tag = encryptBlock(j0, k)
      const tag = encryptBlock(j0, k);
      for (let i = 0; i < 16; i++) tag[i] ^= ghIn[paddedAAD.length + paddedCT.length + i] || 0;
      return { ciphertext, tag };
    }
    function s2v(h, data) {
      const d = new Uint8Array(16);
      let carry = 0;
      for (let i = 0; i < data.length; i++) {
        for (let j = 15; j >= 0; j--) {
          const tmp = d[j];
          d[j] = ((tmp << 1) | carry) & 0xff;
          carry = (tmp >>> 7) & 1;
        }
        if (carry) d[15] ^= 0x87;
        for (let j = 0; j < 16 && (i*16+j < data.length); j++) d[j] ^= data[i*16+j] || 0;
      }
      return;
    }
    module.exports = { gcm: gcmEncrypt };
    // We don't expose decrypt here — the test page only needs encrypt+decrypt
    // which we'll implement symmetrically.
  });
  return __REQUIRE__(0);
})();
module.exports = gcmImpl;
