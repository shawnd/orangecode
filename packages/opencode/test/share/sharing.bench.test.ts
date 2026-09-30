import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ShareNext } from "../../src/share/share-next"
import { Session } from "../../src/session/session"
import { disposeInstance } from "../../src/effect/instance-registry"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { publishSharingBatch, seedShare, sharingConfig, sharingFixture, sharingPayloads } from "./sharing-fixture"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))
const output = process.env.SHARING_BENCH
const bench = output ? it.live : it.live.skip

bench(
  "real ShareNext listener and payload workload",
  () =>
    provideTmpdirInstance(
      (directory) => {
        const fixture = sharingFixture()
        return Effect.gen(function* () {
          if (!output) return
          const sessions = yield* Session.Service
          const share = yield* ShareNext.Service
          const unshared = yield* sessions.create({ title: "unshared probe" })
          const shared = yield* sessions.create({ title: "shared probe" })
          yield* seedShare(shared.id)
          const payloads = {
            unshared: sharingPayloads(unshared.id, fixture),
            shared: sharingPayloads(shared.id, fixture),
          }
          const samples: object[] = []
          yield* share.init()
          // Warm provider/config/database and both share cache outcomes before timing.
          yield* publishSharingBatch(payloads.unshared)
          yield* publishSharingBatch(payloads.shared)
          for (let cycle = 0; cycle <= 20; cycle++) {
            if (cycle > 0) {
              yield* Effect.promise(() => disposeInstance(directory))
              yield* share.init()
            }
            if (![0, 5, 20].includes(cycle)) continue
            for (const mode of ["unshared", "shared"] as const) {
              yield* publishSharingBatch(payloads[mode])
              for (let trial = 0; trial < 5; trial++) {
                const before = { ...fixture.work }
                const start = performance.now()
                for (let batch = 0; batch < 12; batch++) yield* publishSharingBatch(payloads[mode])
                samples.push({
                  cycle,
                  mode,
                  trial,
                  publications: 36,
                  ms: performance.now() - start,
                  retained: fixture.work.retained,
                  callbacks: fixture.work.callbacks - before.callbacks,
                  clones: fixture.work.clones - before.clones,
                  clonePayloadBytes: fixture.work.clonePayloadBytes - before.clonePayloadBytes,
                  models: fixture.work.models - before.models,
                })
              }
            }
          }
          yield* Effect.promise(() => disposeInstance(directory))
          const result = {
            baselineTree: "e6f0f15a59125fb1775dd081da144ec16c4622aa",
            bun: Bun.version,
            retainedAfterDispose: fixture.work.retained,
            registered: fixture.work.registered,
            payloadBytes: 262144,
            samples,
          }
          console.log(JSON.stringify(result))
          yield* Effect.promise(() => Bun.write(output, JSON.stringify(result, null, 2) + "\n"))
        }).pipe(Effect.provide(fixture.layer))
      },
      { config: sharingConfig },
    ),
  120_000,
)
