/** Time helpers shared across runtime and event persistence. */

import type { Timestamp } from "../domain/models";

/** Return the current UTC timestamp as second-precision ISO. */
export function isoNow(): Timestamp {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() as Timestamp;
}
