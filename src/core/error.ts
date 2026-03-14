/** Shared user-visible error type for Revis domain and CLI failures. */

/** Represent a failure that should surface directly to the operator. */
export class RevisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisError";
  }
}
