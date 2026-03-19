/** Tiny assertion helpers for internal invariants. */

import assert from "node:assert/strict";

/** Assert one invariant and narrow the type when it holds. */
export function invariant(condition: unknown, message: string): asserts condition {
  assert(condition, message);
}

/** Exhaustiveness helper for discriminated unions. */
export function unreachable(value: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
}
