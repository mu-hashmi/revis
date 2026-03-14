#!/usr/bin/env node
const fs = require("node:fs");

const statePath = process.env.REVIS_GH_STATE;
const args = process.argv.slice(2);
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { next: 1, prs: [] };

const findValue = (flag) => {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) {
    throw new Error("missing required flag " + flag);
  }

  return args[index + 1];
};

if (args[0] === "--version") {
  console.log("gh version fake");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "list") {
  const base = findValue("--base");
  const head = findValue("--head");
  const matches = state.prs.filter((pr) => pr.base === base && pr.head === head);
  console.log(JSON.stringify(matches.map(({ number, url, title }) => ({ number, url, title }))));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "create") {
  const base = findValue("--base");
  const head = findValue("--head");
  const title = findValue("--title");
  const existing = state.prs.find((pr) => pr.base === base && pr.head === head);
  let created = existing;
  if (!existing) {
    const number = state.next++;
    created = {
      number,
      url: "https://example.test/pr/" + number,
      title,
      base,
      head
    };
    state.prs.push(created);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }
  console.log(created.url);
  process.exit(0);
}

console.error("unexpected gh invocation", args.join(" "));
process.exit(1);
