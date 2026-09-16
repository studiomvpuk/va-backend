/**
 * The Buffer/Bytes boundary.
 *
 * Node's crypto APIs deal in `Buffer`, which TypeScript now types as
 * `Buffer<ArrayBufferLike>` — the backing store might be a `SharedArrayBuffer`
 * as far as the type system knows. Prisma types a `Bytes` column as
 * `Uint8Array<ArrayBuffer>` and will not accept the looser type.
 *
 * The conversion is a copy rather than a cast, and that is deliberate for a
 * reason beyond typing. `Buffer.concat` and `Buffer.allocUnsafe` hand back a
 * *view into Node's shared 8 KB allocation pool* for small payloads — which is
 * exactly the size range every envelope in this application falls into. The
 * view carries a `byteOffset` into a buffer that also holds unrelated bytes,
 * including, potentially, other secrets. Copying detaches the value from that
 * pool before it is handed to a driver, so nothing downstream can read past its
 * length by accident.
 *
 * These payloads are hundreds of bytes. The copy is not worth optimising away.
 */

/** Domain `Buffer` → the `Uint8Array<ArrayBuffer>` Prisma stores in a Bytes column. */
export function toBytes(value: Buffer): Uint8Array<ArrayBuffer> {
  // `new Uint8Array(typedArray)` copies the contents into a fresh ArrayBuffer,
  // which is both what the type demands and what detaches it from the pool.
  return new Uint8Array(value);
}

/** A Bytes column read back from Prisma → the `Buffer` the cipher expects. */
export function fromBytes(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
