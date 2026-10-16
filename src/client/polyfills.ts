// crypto.randomUUID requires a secure context. Plain-HTTP LAN access is not
// secure, so browsers do not expose it there and client code that relies on it
// throws. getRandomValues is available without a secure context, so derive a v4
// UUID from it when the native method is missing.
const target = globalThis.crypto as unknown as { randomUUID?: () => string };
if (typeof target.randomUUID !== 'function') {
  target.randomUUID = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
      '',
    );
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
