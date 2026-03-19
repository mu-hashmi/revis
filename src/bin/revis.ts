#!/usr/bin/env node

/** CLI bin entrypoint for Revis. */

import { Command } from "@effect/cli";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeContext from "@effect/platform-node/NodeContext";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import { buildCli } from "../cli/app";

const app = buildCli();
const run = Command.run(app, {
  name: "revis",
  version: "0.1.1"
});

run(process.argv).pipe(
  Effect.provide(Layer.mergeAll(NodeContext.layer, NodeHttpClient.layerUndici)),
  NodeRuntime.runMain
);
