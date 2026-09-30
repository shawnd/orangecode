// Type-only imports are erased in both runtimes. No native setup on the caller.
import type {
  InitOptions,
  SearchResult,
  DirSearchResult,
  MixedSearchResult,
  GrepOptions,
  GrepResult,
} from "@ff-labs/fff-bun"

declare global {
  const FFF_LIBC: "gnu" | "musl"
}

export type Init = InitOptions
export type Search = SearchResult
export type DirSearch = DirSearchResult
export type MixedSearch = MixedSearchResult
export type Grep = GrepResult
export type SearchOptions = { currentFile?: string; pageIndex?: number; pageSize?: number }
export type { GrepOptions }

export type GrepMatches = Array<{
  entry: { path: string; type: "file" }
  line: number
  offset: number
  text: string
  submatches: Array<{ text: string; start: number; end: number }>
}>

export function formatGrep(result: Grep): GrepMatches {
  return result.items.map((match) => {
    const bytes = Buffer.from(match.lineContent)
    return {
      entry: { path: match.relativePath.replaceAll("\\", "/"), type: "file" },
      line: match.lineNumber,
      offset: match.byteOffset,
      text: match.lineContent.length > 2_000 ? match.lineContent.slice(0, 2_000) + "..." : match.lineContent,
      submatches: match.matchRanges.map(([start, end]) => ({
        text: bytes.subarray(start, end).toString("utf8"),
        start,
        end,
      })),
    }
  })
}

export type Operations = {
  init: { args: [Init]; value: { backend: "fff-worker"; workerPath: string } }
  fileSearch: { args: [string, SearchOptions?]; value: Search }
  glob: { args: [string, SearchOptions?]; value: Search }
  directorySearch: { args: [string, SearchOptions?]; value: DirSearch }
  mixedSearch: { args: [string, SearchOptions?]; value: MixedSearch }
  grep: { args: [string, GrepOptions?, boolean?]; value: Grep | GrepMatches }
  waitForScan: { args: [number?]; value: boolean }
  dispose: { args: []; value: { destroyed: boolean } }
}

export type Request = {
  [K in keyof Operations]: { id: number; op: K; args: Operations[K]["args"] }
}[keyof Operations]

export type Response =
  | { id: number; ok: true; value: Operations[keyof Operations]["value"] }
  | { id: number; ok: false; error: { kind: FffError["kind"]; message: string } }

export class FffError extends Error {
  constructor(
    readonly kind: "unavailable" | "transport" | "query" | "defect" | "disposed",
    message: string,
  ) {
    super(message)
    this.name = "FffError"
  }
}

export interface Picker {
  destroy(): Promise<void>
  waitForScan(timeoutMs?: number, signal?: AbortSignal): Promise<boolean>
  fileSearch(query: string, opts?: SearchOptions, signal?: AbortSignal): Promise<Search>
  glob(query: string, opts?: SearchOptions, signal?: AbortSignal): Promise<Search>
  directorySearch(query: string, opts?: SearchOptions, signal?: AbortSignal): Promise<DirSearch>
  mixedSearch(query: string, opts?: SearchOptions, signal?: AbortSignal): Promise<MixedSearch>
  grep(query: string, opts?: GrepOptions, signal?: AbortSignal): Promise<Grep>
  grepMatches(query: string, opts?: GrepOptions, signal?: AbortSignal): Promise<GrepMatches>
}
