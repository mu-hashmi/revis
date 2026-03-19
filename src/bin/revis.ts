#!/usr/bin/env node

/** CLI bin entrypoint for the SDK-native Revis runtime. */

import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { runCli } from "../revis/cli";

NodeRuntime.runMain(
  Effect.provide(
    runCli(process.argv.slice(2)) as Effect.Effect<void, never, NodeContext.NodeContext>,
    NodeContext.layer
  )
);
