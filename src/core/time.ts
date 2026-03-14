/** Time helpers shared across runtime and event persistence. */

/** Return the current UTC timestamp as second-precision ISO. */
export function isoNow(): string {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
}
