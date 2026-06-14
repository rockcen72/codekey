import { describe, it, expect } from 'vitest';
import {
  generateEcdhKeyPair,
  computeSharedSecret,
  deriveKeyMaterial,
} from '../bridge/e2e-key-exchange';

describe('ECDH key exchange', () => {
  it('desktop and phone derive the same shared secret', () => {
    const desktop = generateEcdhKeyPair();
    const phone = generateEcdhKeyPair();

    const desktopSecret = computeSharedSecret(desktop.privateKey, phone.publicKeyHex);
    const phoneSecret = computeSharedSecret(phone.privateKey, desktop.publicKeyHex);

    expect(desktopSecret).toEqual(phoneSecret);
  });

  it('deriveKeyMaterial produces stable output for same shared secret', () => {
    const desktop = generateEcdhKeyPair();
    const phone = generateEcdhKeyPair();

    const secret = computeSharedSecret(desktop.privateKey, phone.publicKeyHex);
    const m1 = deriveKeyMaterial(secret);
    const m2 = deriveKeyMaterial(secret);

    expect(m1.contentKeyHex).toEqual(m2.contentKeyHex);
    expect(m1.keyId).toEqual(m2.keyId);
  });

  it('different keypairs produce different shared secrets', () => {
    const d1 = generateEcdhKeyPair();
    const d2 = generateEcdhKeyPair();
    const phone = generateEcdhKeyPair();

    const s1 = computeSharedSecret(d1.privateKey, phone.publicKeyHex);
    const s2 = computeSharedSecret(d2.privateKey, phone.publicKeyHex);

    expect(s1).not.toEqual(s2);
  });

  it('keyId is 16 hex chars, contentKeyHex is 64 hex chars', () => {
    const pair = generateEcdhKeyPair();
    const other = generateEcdhKeyPair();
    const secret = computeSharedSecret(pair.privateKey, other.publicKeyHex);
    const m = deriveKeyMaterial(secret);

    expect(m.contentKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(m.keyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('cross-platform golden vector — deterministic key material', () => {
    const DESKTOP_PRIV_HEX = '17beed5436d62a56cd1cb20a78ee70d305e62d77dd4338023a94eb68f4e220a2';
    const DESKTOP_PUB_HEX = '048d0afeb5d7e939b7e25a549a4faf76fa2273627a8685b17bce7dcdb439ae8c4f6b9ac168240f2a98335e7135f32f6c21283fef64f6afa43fc589947a4ca969ba';
    const PHONE_PRIV_HEX = 'b7932a406435e1a5ae85c50262eac1b4090f1f911e7ee0dbeebde7e3b142e246';
    const PHONE_PUB_HEX = '04ec7679d376ccc75b411d0addeec168f8c12139434d23338199687b8e9284d30895a9c5f8c39f2a9afbe2b8315ceb3fd281135e86a877af6007eaf2304993cc51';

    const desktopSecret = computeSharedSecret(Buffer.from(DESKTOP_PRIV_HEX, 'hex'), PHONE_PUB_HEX);
    const phoneSecret = computeSharedSecret(Buffer.from(PHONE_PRIV_HEX, 'hex'), DESKTOP_PUB_HEX);

    expect(desktopSecret).toEqual(phoneSecret);

    const material = deriveKeyMaterial(desktopSecret);

    expect(material.contentKeyHex).toBe('98c4c76b3fb6ac024d866fc2a488047e03dc9fcaafa5b76c9ccb7b2650bfc09b');
    expect(material.keyId).toBe('30db1154fb750881');
  });
});
