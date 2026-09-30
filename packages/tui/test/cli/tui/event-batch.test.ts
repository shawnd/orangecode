import { describe, expect, test } from "bun:test"
import { createEventBatch } from "../../../src/context/event-batch"

describe("event batch", () => {
  test("flushes by UTF-8 bytes and count without losing, duplicating or reordering events", () => {
    const received: string[] = []
    const batches: string[][] = []
    const queue = createEventBatch({
      bytes: 9,
      events: 2,
      size: (event: string) => Buffer.byteLength(event),
      emit(events) {
        batches.push(events)
        received.push(...events)
      },
    })
    const events = ["🙂", "🙂", "third", "a", "b", "c"]
    events.forEach((event) => {
      expect(queue.offer(event)).toBe(true)
      expect(queue.bytes).toBeLessThanOrEqual(9)
      expect(queue.length).toBeLessThanOrEqual(2)
    })
    queue.flush()
    expect(received).toEqual(events)
    expect(batches.flat()).toEqual(events)
    expect(
      batches.every(
        (batch) => batch.length <= 2 && batch.reduce((size, event) => size + Buffer.byteLength(event), 0) <= 9,
      ),
    ).toBe(true)
    expect(queue.bytes).toBe(0)
    expect(queue.length).toBe(0)
  })

  test("large singleton delivers after its prefix and is not retained behind a timer", () => {
    const received: string[] = []
    const large = "x".repeat(1024 * 1024 + 1)
    const queue = createEventBatch({
      size: (event: string) => Buffer.byteLength(event),
      emit(events) {
        received.push(...events)
      },
    })
    queue.offer("prefix")
    queue.offer(large)
    expect(received).toEqual(["prefix", large])
    expect(queue.length).toBe(0)
    expect(queue.bytes).toBe(0)
    queue.offer("suffix")
    queue.flush()
    expect(received).toEqual(["prefix", large, "suffix"])
  })

  test("a burst preserves text and critical approval/status/history event order", () => {
    const received: { type: string; i: number; text: string }[] = []
    const queue = createEventBatch({
      bytes: 1024,
      events: 7,
      size: (event: { type: string; i: number; text: string }) => Buffer.byteLength(JSON.stringify(event)),
      emit(events) {
        received.push(...events)
      },
    })
    const events = Array.from({ length: 1000 }, (_, i) => ({
      type: [
        "message.part.delta",
        "permission.asked",
        "permission.replied",
        "question.asked",
        "question.replied",
        "session.status",
        "message.updated",
      ][i % 7],
      i,
      text: "x".repeat(i % 100),
    }))
    events.forEach((event) => queue.offer(event))
    queue.flush()
    expect(received).toEqual(events)
  })

  test("reentrant bursts remain lossless and ordered even when the consumer prevents early flushing", () => {
    const received: number[] = []
    const queue = createEventBatch({
      bytes: 2,
      events: 2,
      size: () => 1,
      emit(events: number[]) {
        events.forEach((event) => {
          received.push(event)
          if (event === 1) Array.from({ length: 10 }, (_, i) => i + 3).forEach(queue.offer)
        })
      },
    })
    queue.offer(1)
    queue.offer(2)
    queue.flush()
    expect(received).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })

  test("closed batch releases state and refuses new offers", () => {
    const received: number[] = []
    const queue = createEventBatch({ size: () => 1, emit: (events: number[]) => received.push(...events) })
    queue.offer(1)
    queue.close()
    expect(queue.length).toBe(0)
    expect(queue.bytes).toBe(0)
    expect(queue.offer(2)).toBe(false)
    queue.flush()
    expect(received).toEqual([])
  })

  test("the offer triggering an early flush precedes reentrant offers from its prefix", () => {
    const received: number[] = []
    const queue = createEventBatch({
      bytes: 2,
      events: 2,
      size: () => 1,
      emit(events: number[]) {
        events.forEach((event) => {
          received.push(event)
          if (event === 1) queue.offer(4)
        })
      },
    })
    ;[1, 2, 3].forEach(queue.offer)
    queue.flush()
    expect(received).toEqual([1, 2, 3, 4])
  })
})
