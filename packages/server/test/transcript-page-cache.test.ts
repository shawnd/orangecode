import { expect } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../../core/test/lib/effect"
import { Layer } from "effect"
import { makeTranscriptPageCache } from "../src/transcript-page-cache"

const it = testEffect(Layer.empty)

it.live("entry/UTF-8 byte bounds, oversized skip, LRU, sequence retirement and immutable ownership", () =>
  Effect.gen(function* () {
    const cache = yield* makeTranscriptPageCache({ entries: 2, bytes: 10, ttl: 10_000 })
    cache.set("a", "ses_a", 1, "😀")
    cache.set("b", "ses_b", 1, "four")
    expect(cache.get("a", "ses_a", 1)).toBe("😀")
    cache.set("c", "ses_c", 1, "abc")
    expect(cache.get("b", "ses_b", 1)).toBeUndefined()
    expect(cache.get("a", "ses_a", 1)).toBe("😀")
    cache.set("huge", "ses_a", 1, "oversized")
    expect(cache.get("huge", "ses_a", 1)).toBeUndefined()
    expect(cache.get("a", "ses_a", 1)).toBe("😀")
    expect(cache.get("new", "ses_a", 2)).toBeUndefined()
    expect(cache.get("a", "ses_a", 1)).toBeUndefined()
    expect(cache.get("c", "ses_c", 1)).toBe("abc")
    const limited = yield* makeTranscriptPageCache({ entries: 1, bytes: 100, ttl: 10_000 })
    limited.set("a", "ses_a", 1, "a")
    limited.set("b", "ses_b", 1, "b")
    expect(limited.get("a", "ses_a", 1)).toBeUndefined()
    expect(limited.get("b", "ses_b", 1)).toBe("b")
    limited.set("k".repeat(100), "ses_c", 1, "x")
    expect(limited.get("k".repeat(100), "ses_c", 1)).toBeUndefined()
    expect(limited.get("b", "ses_b", 1)).toBe("b")
    limited.set("old", "ses_r", 0, "old", "event_old")
    expect(limited.get("new", "ses_r", 0, "event_new")).toBeUndefined()
    expect(limited.get("old", "ses_r", 0, "event_old")).toBeUndefined()
  }),
)

it.live("TTL is not extended by hits and scope close clears retained pages", () =>
  Effect.gen(function* () {
    const cache = yield* Effect.scoped(
      Effect.gen(function* () {
        const cache = yield* makeTranscriptPageCache({ entries: 2, bytes: 100, ttl: 30 })
        cache.set("a", "ses_a", 1, "body")
        expect(cache.get("a", "ses_a", 1)).toBe("body")
        yield* Effect.sleep("40 millis")
        expect(cache.get("a", "ses_a", 1)).toBeUndefined()
        cache.set("b", "ses_b", 1, "body")
        return cache
      }),
    )
    expect(cache.get("b", "ses_b", 1)).toBeUndefined()
  }),
)
