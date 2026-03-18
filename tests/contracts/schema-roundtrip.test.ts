/** Property tests that lock down JSON round-trip contracts for core persisted schemas. */

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RuntimeEventSchema, WorkspaceSnapshot } from "../../src/domain/models";

describe("schema round-trips", () => {
  it.effect.prop(
    "round-trips workspace snapshots through their JSON schema",
    { snapshot: WorkspaceSnapshot },
    ({ snapshot }) =>
      Effect.sync(() => {
        // Build the JSON codec once inside the assertion so the property is explicitly about the
        // persisted representation, not just object equality.
        const codec = Schema.parseJson(WorkspaceSnapshot);
        const json = Schema.encodeSync(codec)(snapshot);
        const decoded = Schema.decodeUnknownSync(codec)(json);

        // Re-encoding the decoded value should be stable for every generated sample.
        expect(Schema.encodeSync(codec)(decoded)).toBe(json);
        return true;
      }),
    {
      fastCheck: {
        numRuns: 25
      }
    }
  );

  it.effect.prop(
    "round-trips runtime events through their JSON schema",
    { event: RuntimeEventSchema },
    ({ event }) =>
      Effect.sync(() => {
        // Runtime events back the live journal and the archive, so the JSON form is the behavioral
        // contract worth fuzzing here.
        const codec = Schema.parseJson(RuntimeEventSchema);
        const json = Schema.encodeSync(codec)(event);
        const decoded = Schema.decodeUnknownSync(codec)(json);

        expect(Schema.encodeSync(codec)(decoded)).toBe(json);
        return true;
      }),
    {
      fastCheck: {
        numRuns: 25
      }
    }
  );
});
