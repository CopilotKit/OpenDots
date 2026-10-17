import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretBox } from './encrypted-file';

// A real cipher (AES-256-GCM) standing in for Electron's safeStorage, so tests
// can check that nothing readable reaches the disk and that the wrong key fails.
export function createTestBox(key: Buffer = randomBytes(32)): SecretBox {
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([
        cipher.update(plain, 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decrypt(data) {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        data.subarray(0, 12),
      );
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
