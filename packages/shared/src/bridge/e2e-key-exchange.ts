import crypto from 'node:crypto';

const CURVE = 'prime256v1';
const INFO_STRING = 'codekey-e2e-key-v1';
const KEY_LENGTH = 32;
const KEY_ID_LENGTH = 8;
const DERIVED_LENGTH = KEY_LENGTH + KEY_ID_LENGTH;

export interface EcdhKeyPair {
  publicKeyHex: string;
  privateKey: Buffer;
}

export function generateEcdhKeyPair(): EcdhKeyPair {
  const ecdh = crypto.createECDH(CURVE);
  ecdh.generateKeys();
  return {
    publicKeyHex: ecdh.getPublicKey('hex', 'uncompressed'),
    privateKey: ecdh.getPrivateKey(),
  };
}

export function computeSharedSecret(privateKey: Buffer, publicKeyHex: string): Buffer {
  const ecdh = crypto.createECDH(CURVE);
  ecdh.setPrivateKey(privateKey);
  return ecdh.computeSecret(Buffer.from(publicKeyHex, 'hex'));
}

export interface DerivedKeyMaterial {
  contentKeyHex: string;
  keyId: string;
}

export function deriveKeyMaterial(sharedSecret: Buffer): DerivedKeyMaterial {
  const derived = Buffer.from(crypto.hkdfSync(
    'sha256',
    sharedSecret,
    Buffer.alloc(0),
    Buffer.from(INFO_STRING, 'utf8'),
    DERIVED_LENGTH,
  ));
  return {
    contentKeyHex: derived.subarray(0, KEY_LENGTH).toString('hex'),
    keyId: derived.subarray(KEY_LENGTH, DERIVED_LENGTH).toString('hex'),
  };
}
