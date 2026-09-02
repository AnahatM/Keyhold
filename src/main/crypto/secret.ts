// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * `SecretBytes` — a key or other secret held in memory, with the sharp edges removed.
 *
 * A raw `Buffer` holding a 32-byte key is one careless `console.log`, one
 * `JSON.stringify` of a config object, or one thrown error away from putting that key
 * somewhere it can never be taken back from. Every one of those paths goes through
 * `toString`, `toJSON`, or `util.inspect`, so this class overrides all three to return
 * a redaction marker instead of the bytes.
 *
 * That is the primary purpose. Zeroing on `destroy()` is the secondary one: it shortens
 * the window in which a key sits in a page that might be swapped or core-dumped. It is
 * a real improvement, not a guarantee — V8 can and does copy buffers, and Node exposes
 * no `mlock`. The threat model is explicit that memory is not defended while unlocked.
 */

const REDACTED = '[SecretBytes: redacted]';

export class SecretBytes {
  #bytes: Uint8Array | null;

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  /** Takes ownership of `bytes`. The caller must not keep or reuse its reference. */
  static adopt(bytes: Uint8Array): SecretBytes {
    return new SecretBytes(bytes);
  }

  /** Copies `bytes`, leaving the caller's buffer untouched and still their problem. */
  static copyOf(bytes: Uint8Array): SecretBytes {
    return new SecretBytes(Uint8Array.from(bytes));
  }

  static ofLength(length: number): SecretBytes {
    return new SecretBytes(new Uint8Array(length));
  }

  get length(): number {
    return this.#assertLive().length;
  }

  get destroyed(): boolean {
    return this.#bytes === null;
  }

  /**
   * Runs `fn` with the raw bytes.
   *
   * Deliberately not a getter: reading `secret.bytes` looks harmless at a call site,
   * whereas `secret.use(...)` reads as "I am handling raw key material here" and shows
   * up in a review. The bytes must not escape the callback.
   */
  use<T>(fn: (bytes: Uint8Array) => T): T {
    return fn(this.#assertLive());
  }

  /** A detached copy, for an API that insists on owning its input. Also a secret. */
  clone(): SecretBytes {
    return new SecretBytes(Uint8Array.from(this.#assertLive()));
  }

  /**
   * Overwrites the bytes and releases them. Idempotent, so `destroy()` in a `finally`
   * is always safe.
   */
  destroy(): void {
    if (this.#bytes === null) return;
    this.#bytes.fill(0);
    this.#bytes = null;
  }

  /**
   * Constant-time comparison. Used for verifying derived values, where a naive `===`
   * would leak how many leading bytes matched via timing.
   */
  equals(other: SecretBytes): boolean {
    const a = this.#assertLive();
    const b = other.#assertLive();
    if (a.length !== b.length) return false;

    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    return diff === 0;
  }

  // ── Redaction: every path that could stringify this object ─────────────────
  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }

  readonly [Symbol.toStringTag]: string = 'SecretBytes';

  #assertLive(): Uint8Array {
    if (this.#bytes === null) {
      throw new Error('SecretBytes has been destroyed and can no longer be used.');
    }
    return this.#bytes;
  }
}

/**
 * Runs `fn` with a secret and destroys it afterwards, whether `fn` threw or not.
 *
 * The point is the `finally`: a key that leaks on the error path is exactly the key an
 * attacker gets to see, because the error path is where things go wrong.
 */
export async function withSecret<T>(
  secret: SecretBytes,
  fn: (secret: SecretBytes) => Promise<T> | T
): Promise<T> {
  try {
    return await fn(secret);
  } finally {
    secret.destroy();
  }
}
