/** String helpers for branch names, hashing, and template rendering. */

import { createHash } from "node:crypto";

/** Compute a SHA-256 digest for text. */
export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Convert arbitrary identity text into a stable branch-safe slug. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
