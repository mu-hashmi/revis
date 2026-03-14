/** Helpers for operator-configured agent launch templates. */

import { basename } from "node:path";

/** Return the basename of the executable in a launch template. */
export function templateExecutable(argv: string[]): string {
  return basename(argv[0]!);
}
