/** Shell fixture builders used by acceptance tests to simulate bounded agent work. */

/** Build one bounded agent command that records work, creates a commit, and exits cleanly. */
export function commitAndExitFixture(subject = "work"): string {
  return [
    "mkdir -p .revis-test",
    // Record the daemon-visible iteration number so restart tests can prove the fixture ran again.
    "printf '%s\\n' \"$REVIS_ITERATION\" >> .revis-test/iterations.log",
    "git add .revis-test/iterations.log",
    `git commit --allow-empty -m ${shellSingleQuote(subject)}`,
    "exit 0"
  ].join(" && ");
}

/** Build one bounded agent command that only writes one marker and exits successfully. */
export function writeAndExitFixture(path = ".revis-test/output.log"): string {
  return [
    `mkdir -p ${shellSingleQuote(path.split("/").slice(0, -1).join("/") || ".")}`,
    `printf '%s\\n' \"$REVIS_ITERATION\" >> ${shellSingleQuote(path)}`,
    "exit 0"
  ].join(" && ");
}

/** Build one bounded agent command that stays running long enough for status polling. */
export function writeAndSleepFixture(
  path = ".revis-test/output.log",
  seconds = 2
): string {
  return [
    `mkdir -p ${shellSingleQuote(path.split("/").slice(0, -1).join("/") || ".")}`,
    `printf '%s\\n' \"$REVIS_ITERATION\" >> ${shellSingleQuote(path)}`,
    `sleep ${seconds}`,
    "exit 0"
  ].join(" && ");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
