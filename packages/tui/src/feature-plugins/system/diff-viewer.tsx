/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import {
  TextAttributes,
  MouseButton,
  type MouseEvent,
  type BorderSides,
  type BoxRenderable,
  type DiffRenderable,
  type KeyEvent,
  type Renderable,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { LANGUAGE_EXTENSIONS } from "../../util/filetype"
import { OPENCODE_BASE_MODE, useBindings, useCommandShortcut, useOpencodeModeStack } from "../../keymap"
import type { CommandContext } from "@opentui/keymap"
import { tint, useTheme } from "../../context/theme"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import path from "path"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { DiffViewerFileTree } from "./diff-viewer-file-tree"
import { Panel, PanelGroup, Separator } from "./diff-viewer-ui"
import { DialogSelect } from "../../ui/dialog-select"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { createStore, reconcile } from "solid-js/store"
import { getPromptDraft } from "../../component/prompt"
import type { PromptInfo } from "../../prompt/history"
import {
  annotationLabel,
  annotationPreview,
  annotationPrompt,
  diffHunks,
  diffLineAt,
  diffLines,
  highlightDiffSelection,
  type DiffAnnotation,
} from "./diff-viewer-review"
import { getScrollAcceleration } from "../../util/scroll"
import {
  allExpandedFileTreeDirectories,
  buildFileTree,
  fileTreeFileSelection,
  type FileTreeRow,
  flattenFileTree,
  moveFileTreeSelection,
  moveFileTreeSelectionToFirstChild,
  moveFileTreeSelectionToParent,
  movePatchFileIndex,
  orderedPatchFileIndexes,
  setFileTreeDirectoryExpanded,
  showDiffViewerFileTree,
  singlePatchFileIndex,
  toggleFileTreeDirectory,
} from "./diff-viewer-file-tree-utils"

const ROUTE = "diff"
const MIN_SPLIT_WIDTH = 100
const FILE_TREE_WIDTH = 32
const PLAIN_TEXT_FILETYPE = "opencode-plain-text"
const VCS_DIFF_CONTEXT_LINES = 12
const KV_SHOW_FILE_TREE = "diff_viewer_show_file_tree"
const KV_SINGLE_PATCH = "diff_viewer_single_patch"
const KV_VIEW = "diff_viewer_view"
const KV_NAVIGATION = "diff_viewer_navigation"
type DiffMode = "git" | "branch" | "last-turn"
type DiffViewerFocus = "patches" | "files"
type DiffView = "split" | "unified"
type SelectedHunk = { readonly fileIndex: number; readonly hunkIndex: number; readonly scrollTop: number }

type DiffFile = {
  readonly file: string
  readonly patch?: string
  readonly additions: number
  readonly deletions: number
  readonly status: "added" | "deleted" | "modified"
}

const normalizeDiffs = (diffs: readonly (VcsFileDiff | SnapshotFileDiff)[]): DiffFile[] =>
  diffs.flatMap((item) =>
    item.file
      ? [
          {
            file: item.file,
            patch: item.patch,
            additions: item.additions,
            deletions: item.deletions,
            status: item.status ?? "modified",
          } satisfies DiffFile,
        ]
      : [],
  )

function filetype(input?: string) {
  if (!input) return "none"
  const language = LANGUAGE_EXTENSIONS[path.extname(input)]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function storedView(value: unknown): DiffView | undefined {
  if (value === "split" || value === "unified") return value
}

function diffSourceLabel(mode: DiffMode) {
  if (mode === "last-turn") return "last turn"
  if (mode === "branch") return "main branch"
  return "working tree"
}

function DiffViewer(props: { api: TuiPluginApi }) {
  const renderer = useRenderer()
  const modes = useOpencodeModeStack()
  const dimensions = useTerminalDimensions()
  const themeState = useTheme()
  const theme = () => props.api.theme.current
  const params = () =>
    ("params" in props.api.route.current ? props.api.route.current.params : undefined) as
      | {
          mode?: DiffMode
          directory?: string
          sessionID?: string
          messageID?: string
          returnRoute?: TuiRouteCurrent
          annotations?: DiffAnnotation[]
          draft?: PromptInfo
        }
      | undefined
  const mode = () => params()?.mode ?? "git"
  const draft = params()?.draft ?? getPromptDraft()
  const [review, setReview] = createStore({
    notes: params()?.annotations ?? ([] as DiffAnnotation[]),
    collapsed: {} as Record<string, boolean>,
    selection: undefined as
      | { fileIndex: number; hunkIndex: number; side: "old" | "new"; anchor: number; line: number }
      | undefined,
    dragging: false,
  })
  const diffInput = createMemo(() => {
    const sessionID = params()?.sessionID
    return {
      mode: mode(),
      sessionID,
      messageID: params()?.messageID,
      directory: params()?.directory ?? (sessionID ? props.api.state.session.get(sessionID)?.directory : undefined),
    }
  })
  const [diff] = createResource(diffInput, async (input) => {
    if (input.mode === "last-turn") {
      const sessionID = input.sessionID
      if (!sessionID) return []
      const result = await props.api.client.session.diff(
        { sessionID, messageID: input.messageID },
        { throwOnError: true },
      )
      return normalizeDiffs(result.data ?? [])
    }

    const result = await props.api.client.vcs.diff(
      { directory: input.directory, mode: input.mode, context: VCS_DIFF_CONTEXT_LINES, view: "summary" },
      { throwOnError: true },
    )
    return normalizeDiffs(result.data ?? [])
  })
  const files = createMemo(() => (diff.error ? [] : (diff() ?? [])))
  const [patches, setPatches] = createStore<
    Record<
      number,
      {
        data?: DiffFile
        hunks: ReturnType<typeof diffHunks>
        error?: boolean
      }
    >
  >({})
  const [focus, setFocus] = createSignal<DiffViewerFocus>("patches")
  const [fileTreeEnabled, setFileTreeEnabled] = createSignal(
    props.api.kv.get<boolean>(KV_SHOW_FILE_TREE, true) !== false,
  )
  const showFileTree = createMemo(() => showDiffViewerFileTree(fileTreeEnabled(), files().length))
  const [singlePatch, setSinglePatch] = createSignal(props.api.kv.get<boolean>(KV_SINGLE_PATCH, false) === true)
  const [navigation, setNavigation] = createSignal(props.api.kv.get(KV_NAVIGATION) === "all" ? "all" : "changes")
  const patchPaneWidth = createMemo(() => dimensions().width - (showFileTree() ? 33 : 0) - 4)
  const patchLeftBorder = createMemo<BorderSides[]>(() => (showFileTree() ? ["left"] : []))
  const splitAvailable = createMemo(() => patchPaneWidth() >= MIN_SPLIT_WIDTH)
  const defaultView = createMemo(() => {
    if (props.api.tuiConfig.diff_style === "stacked") return "unified"
    return splitAvailable() ? "split" : "unified"
  })
  const [viewOverride, setViewOverride] = createSignal<DiffView | undefined>(storedView(props.api.kv.get(KV_VIEW)))
  const view = createMemo(() => (splitAvailable() ? (viewOverride() ?? defaultView()) : "unified"))
  const fileTree = createMemo(() => buildFileTree(files()))
  const [expandedFileNodes, setExpandedFileNodes] = createSignal<ReadonlySet<number>>(new Set())
  const [highlightedFileNode, setHighlightedFileNode] = createSignal<number | undefined>()
  const [lastHighlightedFileNode, setLastHighlightedFileNode] = createSignal<number | undefined>()
  const [activePatchFileIndex, setActivePatchFileIndex] = createSignal<number | undefined>()
  const [selectedFileIndex, setSelectedFileIndex] = createSignal<number | undefined>()
  const [reviewedFileNames, setReviewedFileNames] = createSignal<ReadonlySet<string>>(new Set())
  const patchScrollAcceleration = createMemo(() => getScrollAcceleration(props.api.tuiConfig))
  const fileRows = createMemo(() => flattenFileTree(fileTree(), expandedFileNodes()))
  const patchFileIndexes = createMemo(() => orderedPatchFileIndexes(flattenFileTree(fileTree())))
  const focusRunner = (input: Record<DiffViewerFocus, () => void>) => () => input[focus()]()
  const switchFocusShortcut = useCommandShortcut("diff.switch_focus")
  const nextHunkShortcut = useCommandShortcut("diff.next_hunk")
  const nextFileShortcut = useCommandShortcut("diff.next_file")
  const toggleFileTreeShortcut = useCommandShortcut("diff.toggle_file_tree")
  const singlePatchShortcut = useCommandShortcut("diff.single_patch")
  const toggleViewShortcut = useCommandShortcut("diff.toggle_view")
  const markReviewedShortcut = useCommandShortcut("diff.mark_reviewed")
  const helpShortcut = useCommandShortcut("diff.help")
  let scroll: ScrollBoxRenderable | undefined
  const patchNodeByFileIndex = new Map<number, BoxRenderable>()
  const hunkNodes = new Map<string, BoxRenderable>()
  const diffNodes = new Map<string, DiffRenderable>()
  const initialHunks = createMemo(() => files().map((file) => diffHunks(file.patch ?? "")))
  const patchHunks = (index: number) => patches[index]?.hunks ?? initialHunks()[index] ?? []
  const [selectedHunk, setSelectedHunk] = createSignal<SelectedHunk | undefined>()
  const [pendingPatchScrollFileIndex, setPendingPatchScrollFileIndex] = createSignal<number | undefined>()
  const [patchFillerHeight, setPatchFillerHeight] = createSignal(0)

  createEffect(() => {
    const input = diffInput()
    const list = files()
    const loading = diff.loading
    setPatches(reconcile({}))
    if (loading || input.mode === "last-turn" || !list.length) return
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    const pending = untrack(patchFileIndexes).filter((index) => list[index].patch === undefined)
    const load = async () => {
      while (pending.length && !controller.signal.aborted) {
        const selected = untrack(selectedFileIndex)
        const position = selected === undefined ? -1 : pending.indexOf(selected)
        const index = pending.splice(position === -1 ? 0 : position, 1)[0]
        const file = list[index].file
        await props.api.client.vcs
          .diff(
            {
              directory: input.directory,
              mode: input.mode === "branch" ? "branch" : "git",
              context: VCS_DIFF_CONTEXT_LINES,
              file,
            },
            { throwOnError: true, signal: controller.signal },
          )
          .then(
            (result) => {
              if (controller.signal.aborted) return
              const data = normalizeDiffs(result.data ?? []).find((item) => item.file === file)
              let top = scroll?.scrollTop
              const anchor = top ? patchNodeByFileIndex.get(currentPatchFileIndex() ?? -1) : undefined
              const y = anchor?.y
              setPatches(index, { data, hunks: diffHunks(data?.patch ?? "") })
              // Loading an earlier file changes layout above the viewport. Keep the
              // current file anchored unless the user has scrolled in the meantime.
              // RAF runs before layout, so repeat after the new patch is measured.
              if (anchor && y !== undefined) {
                const restore = () => {
                  if (controller.signal.aborted || anchor.isDestroyed || scroll?.scrollTop !== top) return
                  scroll?.scrollBy(anchor.y - y)
                  top = scroll?.scrollTop
                }
                requestAnimationFrame(() => {
                  restore()
                  requestAnimationFrame(restore)
                })
              }
            },
            () => {
              if (!controller.signal.aborted) setPatches(index, { hunks: [], error: true })
            },
          )
        // Let layout, input, and painting run between chunks, even on a local server.
        await new Promise((resolve) => setTimeout(resolve, 16))
      }
    }
    void load()
    void load()
  })

  onCleanup(() => props.api.ui.dialog.clear())

  createEffect(() => {
    setExpandedFileNodes(allExpandedFileTreeDirectories(fileTree()))
    setHighlightedFileNode(undefined)
    setLastHighlightedFileNode(undefined)
    setActivePatchFileIndex(undefined)
    setSelectedFileIndex(undefined)
    setSelectedHunk(undefined)
    setReviewedFileNames(new Set<string>())
    setReview("selection", undefined)
    setReview("collapsed", reconcile({}))
  })

  const ensureHighlightedFileNode = () => {
    const highlighted = highlightedFileNode()
    if (highlighted !== undefined && fileRows().some((row) => row.id === highlighted)) return
    const lastHighlighted = lastHighlightedFileNode()
    const next =
      lastHighlighted !== undefined && fileRows().some((row) => row.id === lastHighlighted)
        ? lastHighlighted
        : fileRows().find((row) => row.fileIndex !== undefined)?.id
    setHighlightedFileNode(next)
  }

  const setHighlighted = (node: number | undefined) => {
    setHighlightedFileNode(node)
    if (node !== undefined) setLastHighlightedFileNode(node)
  }

  const moveFileSelection = (offset: number) =>
    setHighlighted(moveFileTreeSelection(fileRows(), highlightedFileNode(), offset))

  const scrollPatchNodeToTop = (patchNode: BoxRenderable) => {
    requestAnimationFrame(() => {
      if (!scroll) return
      const scrollDelta = patchNode.y - scroll.viewport.y
      const contentY = scroll.scrollTop + scrollDelta
      const offset = contentY === 0 ? 0 : 1
      scroll.scrollBy(scrollDelta + offset)
    })
  }

  const revealFileTreeFile = (fileIndex: number) => {
    const selection = fileTreeFileSelection(fileTree(), fileIndex)
    if (!selection) return
    setExpandedFileNodes((expanded) => {
      const next = new Set(expanded)
      selection.expandedNodes.forEach((node) => next.add(node))
      return next
    })
    setHighlighted(selection.highlightedNode)
  }

  const selectPatchFile = (fileIndex: number) => {
    revealFileTreeFile(fileIndex)
    setActivePatchFileIndex(fileIndex)
    setSelectedFileIndex(fileIndex)
  }

  const scrollToFileIndex = (fileIndex: number | undefined) => {
    if (fileIndex === undefined) return
    selectPatchFile(fileIndex)
    const patchNode = patchNodeByFileIndex.get(fileIndex)
    if (patchNode) scrollPatchNodeToTop(patchNode)
  }

  const jumpToFileIndex = (fileIndex: number | undefined) => {
    if (fileIndex === undefined) return
    setSelectedHunk(undefined)
    setReview("selection", undefined)
    scrollToFileIndex(fileIndex)
  }

  const currentPatchFileIndex = () => {
    if (!scroll) return undefined
    const viewportContentY = scroll.scrollTop + 1
    const entries = patchFileIndexes()
      .map((fileIndex) => ({
        fileIndex,
        node: patchNodeByFileIndex.get(fileIndex),
      }))
      .filter((entry): entry is { fileIndex: number; node: BoxRenderable } => Boolean(entry.node))
      .map((entry) => ({
        ...entry,
        contentY: scroll!.scrollTop + entry.node.y - scroll!.viewport.y,
      }))
      .sort((left, right) => left.contentY - right.contentY)
    return entries.findLast((entry) => entry.contentY <= viewportContentY)?.fileIndex ?? entries[0]?.fileIndex
  }

  const jumpRelativePatchFile = (offset: number) => {
    setSelectedHunk(undefined)
    setReview("selection", undefined)
    const next = movePatchFileIndex(patchFileIndexes(), selectedFileIndex() ?? activePatchFileIndex(), offset)
    if (singlePatch()) {
      if (next === undefined) return
      selectPatchFile(next)
      scrollSinglePatchToTop()
      return
    }
    scrollToFileIndex(next)
  }

  const jumpRelativeHunk = (offset: -1 | 1) => {
    const patchScroll = scroll
    if (!patchScroll) return
    const hunks = visiblePatchFiles()
      .flatMap((entry) => {
        return patchHunks(entry.fileIndex).flatMap((_, hunkIndex) => {
          const node = hunkNodes.get(`${entry.fileIndex}:${hunkIndex}`)
          if (!node || node.isDestroyed) return []
          return [
            {
              fileIndex: entry.fileIndex,
              hunkIndex,
              contentY: patchScroll.scrollTop + node.y - patchScroll.viewport.y,
            },
          ]
        })
      })
      .sort((left, right) => left.contentY - right.contentY)
    const selected = selectedHunk()
    const selectedIndex =
      selected?.scrollTop === patchScroll.scrollTop
        ? hunks.findIndex((hunk) => hunk.fileIndex === selected.fileIndex && hunk.hunkIndex === selected.hunkIndex)
        : -1
    const next =
      selectedIndex !== -1
        ? hunks[selectedIndex + offset]
        : offset === 1
          ? hunks.find((hunk) => hunk.contentY > patchScroll.scrollTop)
          : hunks.findLast((hunk) => hunk.contentY < patchScroll.scrollTop)
    if (!next) return
    selectPatchFile(next.fileIndex)
    patchScroll.scrollTo(next.contentY)
    setSelectedHunk({ fileIndex: next.fileIndex, hunkIndex: next.hunkIndex, scrollTop: patchScroll.scrollTop })
    setReview("selection", undefined)
    // Clearing the selection removes its footer in the previous hunk.
    // Re-anchor the destination after that layout change, rather than leaving
    // its header scrolled offscreen at the old content position.
    const reveal = () => {
      const selected = selectedHunk()
      const node = hunkNodes.get(`${next.fileIndex}:${next.hunkIndex}`)
      if (
        review.selection ||
        selected?.fileIndex !== next.fileIndex ||
        selected.hunkIndex !== next.hunkIndex ||
        !node ||
        node.isDestroyed
      )
        return
      patchScroll.scrollBy(node.y - patchScroll.viewport.y)
      setSelectedHunk({ fileIndex: next.fileIndex, hunkIndex: next.hunkIndex, scrollTop: patchScroll.scrollTop })
    }
    requestAnimationFrame(() => {
      reveal()
      requestAnimationFrame(reveal)
    })
  }

  const highlightedPatchFileIndex = () => fileRows().find((row) => row.id === highlightedFileNode())?.fileIndex
  const firstPatchFileIndex = () => fileRows().find((row) => row.fileIndex !== undefined)?.fileIndex
  const visiblePatchFiles = createMemo(() => {
    if (!singlePatch()) {
      return patchFileIndexes().flatMap((fileIndex) => {
        const file = files()[fileIndex]
        return file ? [{ file, fileIndex }] : []
      })
    }
    const fileIndex = singlePatchFileIndex(
      selectedFileIndex(),
      activePatchFileIndex(),
      currentPatchFileIndex(),
      firstPatchFileIndex(),
    )
    const file = fileIndex === undefined ? undefined : files()[fileIndex]
    return file && fileIndex !== undefined ? [{ file, fileIndex }] : []
  })

  const ensureHighlightedPatchFile = () => {
    const fileIndex = currentPatchFileIndex() ?? activePatchFileIndex() ?? firstPatchFileIndex()
    if (fileIndex === undefined) return
    selectPatchFile(fileIndex)
  }

  const scrollToPatchFileIndexAfterRender = (fileIndex: number) => {
    setPendingPatchScrollFileIndex(fileIndex)
    requestAnimationFrame(() => {
      const patchNode = patchNodeByFileIndex.get(fileIndex)
      if (patchNode) scrollPatchNodeToTop(patchNode)
      requestAnimationFrame(() => {
        const patchNode = patchNodeByFileIndex.get(fileIndex)
        if (patchNode) scrollPatchNodeToTop(patchNode)
        setPendingPatchScrollFileIndex(undefined)
      })
    })
  }

  const scrollSinglePatchToTop = () => {
    requestAnimationFrame(() => {
      scroll?.scrollTo(0)
      requestAnimationFrame(() => scroll?.scrollTo(0))
    })
  }

  let measuringPatchFiller = false
  const measurePatchFiller = () => {
    if (measuringPatchFiller) return
    measuringPatchFiller = true
    requestAnimationFrame(() => {
      measuringPatchFiller = false
      if (!scroll) return
      const entries = visiblePatchFiles()
        .map((entry) => patchNodeByFileIndex.get(entry.fileIndex))
        .filter((node): node is BoxRenderable => Boolean(node))
      if (entries.length === 0) {
        setPatchFillerHeight(0)
        return
      }
      const contentHeight = Math.max(
        ...entries.map((node) => scroll!.scrollTop + node.y - scroll!.viewport.y + node.height),
      )
      setPatchFillerHeight(Math.max(0, scroll.viewport.height - contentHeight))
    })
  }

  const registerPatchNode = (fileIndex: number, element: BoxRenderable) => {
    patchNodeByFileIndex.set(fileIndex, element)
    measurePatchFiller()
    if (pendingPatchScrollFileIndex() !== fileIndex) return
    requestAnimationFrame(() => {
      scrollPatchNodeToTop(element)
      requestAnimationFrame(() => {
        scrollPatchNodeToTop(element)
        setPendingPatchScrollFileIndex(undefined)
      })
    })
  }

  createEffect(() => {
    visiblePatchFiles()
    dimensions()
    view()
    Object.values(review.collapsed)
    review.selection?.line
    review.notes.map((note) => note.comment)
    measurePatchFiller()
  })

  const toggleBlock = (key: string, expanded?: boolean) => {
    setReview("collapsed", key, expanded === undefined ? !review.collapsed[key] : !expanded)
    measurePatchFiller()
  }

  const selectedBlock = () => {
    const fileIndex = selectedFileIndex() ?? activePatchFileIndex() ?? currentPatchFileIndex() ?? firstPatchFileIndex()
    if (fileIndex === undefined) return
    const hunk =
      review.selection?.fileIndex === fileIndex
        ? review.selection.hunkIndex
        : selectedHunk()?.fileIndex === fileIndex
          ? selectedHunk()?.hunkIndex
          : undefined
    return hunk === undefined ? `${fileIndex}` : `${fileIndex}:${hunk}`
  }

  const editAnnotation = (note: DiffAnnotation) => {
    const fileIndex = files().findIndex((file) => file.file === note.file)
    const hunkIndex = patchHunks(fileIndex).findIndex((hunk) => hunk.header === note.hunk)
    if (fileIndex !== -1 && hunkIndex !== -1 && note.source === diffSourceLabel(mode())) {
      selectPatchFile(fileIndex)
      setReview("collapsed", `${fileIndex}`, false)
      setReview("collapsed", `${fileIndex}:${hunkIndex}`, false)
      const selection = review.selection
      if (
        selection?.fileIndex !== fileIndex ||
        selection.hunkIndex !== hunkIndex ||
        selection.side !== note.side ||
        Math.min(selection.anchor, selection.line) !== note.start ||
        Math.max(selection.anchor, selection.line) !== note.end
      )
        setReview("selection", { fileIndex, hunkIndex, side: note.side, anchor: note.start, line: note.end })
    }
    props.api.ui.dialog.replace(() => (
      <DialogPrompt
        title="Diff annotation"
        value={note.comment}
        description={() => (
          <box gap={1}>
            <text fg={theme().primary}>{annotationLabel(note)}</text>
            <text fg={theme().text}>{note.preview.split("\n").slice(0, 4).join("\n")}</text>
            <text fg={theme().textMuted}>Save an empty comment to delete</text>
          </box>
        )}
        onConfirm={(value) => {
          const next = { ...note, comment: value.trim() }
          setReview("notes", (notes) => [
            ...notes.filter((item) => item.id !== note.id),
            ...(next.comment ? [next] : []),
          ])
          props.api.ui.dialog.clear()
        }}
      />
    ))
  }

  const annotateSelection = () => {
    const selected = review.selection
    const fileIndex = selected?.fileIndex ?? selectedFileIndex() ?? currentPatchFileIndex() ?? firstPatchFileIndex()
    if (fileIndex === undefined) return
    const hunkIndex =
      selected?.hunkIndex ?? (selectedHunk()?.fileIndex === fileIndex ? selectedHunk()?.hunkIndex : undefined) ?? 0
    const hunk = patchHunks(fileIndex)[hunkIndex]
    if (!hunk) return
    const header = hunk.header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/)
    if (!header) return
    const side = selected?.side ?? (Number(header[4] ?? 1) === 0 ? "old" : "new")
    const start = selected ? Math.min(selected.anchor, selected.line) : Number(header[side === "old" ? 1 : 3])
    const end = selected
      ? Math.max(selected.anchor, selected.line)
      : start + Math.max(0, Number(header[side === "old" ? 2 : 4] ?? 1) - 1)
    editAnnotation({
      id: crypto.randomUUID(),
      file: files()[fileIndex].file,
      source: diffSourceLabel(mode()),
      hunk: hunk.header,
      side,
      start,
      end,
      preview: annotationPreview(hunk.patch, side, start, end),
      comment: "",
    })
  }

  const selectLine = (
    fileIndex: number,
    hunkIndex: number,
    event: MouseEvent,
    input: { extend?: boolean; gutterOnly?: boolean } = {},
  ) => {
    const node = diffNodes.get(`${fileIndex}:${hunkIndex}`)
    if (!node || event.button !== MouseButton.LEFT) return
    const line = diffLineAt(node, event.x, event.y, input.gutterOnly ?? !input.extend)
    if (!line) return
    if (input.extend && review.selection && review.selection.side !== line.side) return
    event.preventDefault()
    event.stopPropagation()
    setFocus("patches")
    selectPatchFile(fileIndex)
    const previous = review.selection
    const anchor =
      (input.extend || event.modifiers.shift) &&
      previous?.fileIndex === fileIndex &&
      previous.hunkIndex === hunkIndex &&
      previous.side === line.side
        ? previous.anchor
        : line.line
    setReview("selection", { fileIndex, hunkIndex, side: line.side, anchor, line: line.line })
    setReview("dragging", input.gutterOnly !== false)
    return true
  }

  const patchNodes = () =>
    visiblePatchFiles().flatMap((entry) =>
      patchHunks(entry.fileIndex).flatMap((_, hunkIndex) => {
        if (review.collapsed[`${entry.fileIndex}`] || review.collapsed[`${entry.fileIndex}:${hunkIndex}`]) return []
        const node = diffNodes.get(`${entry.fileIndex}:${hunkIndex}`)
        if (!node || node.isDestroyed) return []
        return [{ node, fileIndex: entry.fileIndex, hunkIndex }]
      }),
    )

  const patchLines = (patch: ReturnType<typeof patchNodes>[number]) =>
    diffLines(patch.node, review.selection?.side).map((line) => ({
      ...line,
      fileIndex: patch.fileIndex,
      hunkIndex: patch.hunkIndex,
    }))

  const revealActiveLine = () => {
    if (!scroll || !review.selection) return
    const selection = review.selection
    const patches = patchNodes()
    const patch = patches.find(
      (patch) => patch.fileIndex === selection.fileIndex && patch.hunkIndex === selection.hunkIndex,
    )
    if (!patch) return
    const lines = diffLines(patch.node, selection.side)
    const line = lines.find((line) => line.side === selection.side && line.line === selection.line)
    if (!line) return
    if (patch === patches[0] && line === lines[0]) {
      scroll.scrollTo(0)
      return
    }
    const margin = Math.min(2, Math.floor(scroll.viewport.height / 4))
    const top = scroll.viewport.y + margin
    const bottom = scroll.viewport.y + scroll.viewport.height - margin
    if (line.y < top) {
      scroll.scrollBy(line.y - top)
      return
    }
    if (line.y >= bottom) scroll.scrollBy(line.y - bottom + 1)
  }

  let pendingLineScroll = 0
  const revealPendingLine = () => {
    revealActiveLine()
    if (--pendingLineScroll > 0) requestAnimationFrame(revealPendingLine)
  }
  const movePatchLine = (offset: number) => {
    if (!scroll) return
    const patches = patchNodes()
    const selection = review.selection
    const patchIndex = selection
      ? patches.findIndex((patch) => patch.fileIndex === selection.fileIndex && patch.hunkIndex === selection.hunkIndex)
      : -1
    const rows = patchIndex === -1 ? [] : patchLines(patches[patchIndex])
    const eligible = (lines: typeof rows) => (navigation() === "changes" ? lines.filter((line) => line.changed) : lines)
    const lines = eligible(rows)
    const current = selection
      ? lines.findIndex((line) => line.side === selection.side && line.line === selection.line)
      : -1
    const next = (() => {
      if (current !== -1) {
        // Held arrows usually stay in one hunk. Read neighboring hunks only when
        // crossing a boundary; native lineInfo getters allocate fresh row arrays.
        // Geometry remains live, so wrapping, folds, and view changes need no cache.
        const direction = Math.sign(offset)
        let remaining = Math.abs(offset)
        let target = lines[current]
        for (let index = patchIndex; index >= 0 && index < patches.length; index += direction) {
          const candidates = index === patchIndex ? lines : eligible(patchLines(patches[index]))
          const origin = index === patchIndex ? current : direction > 0 ? -1 : candidates.length
          const available = direction > 0 ? candidates.length - origin - 1 : origin
          if (remaining <= available) return candidates[origin + direction * remaining]
          if (available) target = candidates[direction > 0 ? candidates.length - 1 : 0]
          remaining -= available
        }
        return target
      }
      // Initial selection, a folded selection, or a mouse-selected context line
      // needs the nearest eligible screen row rather than a relative source row.
      const all = patches.flatMap((patch, index) => (index === patchIndex ? rows : patchLines(patch)))
      const candidates = eligible(all)
      if (!candidates.length) {
        scroll!.scrollBy(offset)
        return
      }
      const hunk = selection ? hunkNodes.get(`${selection.fileIndex}:${selection.hunkIndex}`) : undefined
      const active = selection
        ? rows.find((line) => line.side === selection.side && line.line === selection.line)
        : undefined
      const y = active?.y ?? (hunk && !hunk.isDestroyed ? hunk.y : scroll!.viewport.y)
      const nearest =
        offset > 0 ? candidates.findIndex((line) => line.y >= y) : candidates.findLastIndex((line) => line.y <= y)
      if (active && nearest === -1) return
      const origin = nearest === -1 ? (offset > 0 ? candidates.length - 1 : 0) : nearest
      return candidates[Math.max(0, Math.min(candidates.length - 1, origin + offset - Math.sign(offset)))]
    })()
    if (!next) return
    if (selectedFileIndex() !== next.fileIndex) selectPatchFile(next.fileIndex)
    setSelectedHunk({ fileIndex: next.fileIndex, hunkIndex: next.hunkIndex, scrollTop: scroll.scrollTop })
    setReview("selection", {
      fileIndex: next.fileIndex,
      hunkIndex: next.hunkIndex,
      side: next.side,
      anchor: next.line,
      line: next.line,
    })
    // Key repeats can arrive faster than a frame. Advance the cursor immediately
    // and reveal the latest target once layout (including selection footers) settles.
    // Reset both passes for new input even between callbacks: the first reveal
    // can bring an offscreen file into layout and change its source row's y.
    const scheduled = pendingLineScroll > 0
    pendingLineScroll = 2
    if (!scheduled) requestAnimationFrame(revealPendingLine)
  }

  let held: { name: string; stop: () => void } | undefined
  const stopHeld = () => {
    held?.stop()
    held = undefined
  }
  const releaseHeld = (event: KeyEvent) => {
    if (event.name === held?.name) stopHeld()
  }
  const changeHeld = (event: KeyEvent) => {
    if (held && event.name !== held.name) stopHeld()
  }
  renderer.keyInput.prependListener("keyrelease", releaseHeld)
  renderer.keyInput.prependListener("keypress", changeHeld)
  onCleanup(() => {
    stopHeld()
    renderer.keyInput.off("keyrelease", releaseHeld)
    renderer.keyInput.off("keypress", changeHeld)
  })
  createEffect(() => {
    if (props.api.ui.dialog.open) stopHeld()
  })
  const moveArrow = (offset: -1 | 1, event?: KeyEvent) => {
    if (event?.repeated) held?.stop()
    const move = () => {
      if (focus() === "files") return moveFileSelection(offset)
      movePatchLine(offset)
    }
    move()
    // Event reporting gives Kitty terminals a release to stop the local repeat.
    // A plain first press is valid too: Kitty may omit the default event type.
    // Legacy terminals keep their native autorepeat.
    if (
      !event ||
      !renderer.useKittyKeyboard ||
      (!renderer.capabilities?.kitty_keyboard && event.source !== "kitty") ||
      event.repeated ||
      held
    )
      return
    const delay = setTimeout(() => {
      if (!held) return
      const timer = setInterval(() => {
        if (renderer.isDestroyed || props.api.ui.dialog.open || modes.current() !== OPENCODE_BASE_MODE) {
          stopHeld()
          return
        }
        move()
      }, 30)
      held.stop = () => clearInterval(timer)
    }, 350)
    held = { name: event.name, stop: () => clearTimeout(delay) }
  }

  const toggleSelectedFileTreeRow = () => {
    const highlighted = fileRows().find((row) => row.id === highlightedFileNode())
    if (highlighted?.fileIndex !== undefined) {
      jumpToFileIndex(highlighted.fileIndex)
      return
    }
    setExpandedFileNodes((expanded) => toggleFileTreeDirectory(fileTree(), expanded, highlightedFileNode()))
  }

  const clickFileTreeRow = (row: FileTreeRow) => {
    setFocus("files")
    setHighlighted(row.id)
    if (row.fileIndex !== undefined) {
      jumpToFileIndex(row.fileIndex)
      return
    }
    setExpandedFileNodes((expanded) => toggleFileTreeDirectory(fileTree(), expanded, row.id))
  }

  const toggleSelectedFileReviewed = () => {
    const fileIndex =
      focus() === "files"
        ? fileRows().find((row) => row.id === highlightedFileNode())?.fileIndex
        : (selectedFileIndex() ?? activePatchFileIndex() ?? currentPatchFileIndex())
    const file = fileIndex === undefined ? undefined : files()[fileIndex]?.file
    if (!file) return
    setReviewedFileNames((reviewed) => {
      const next = new Set(reviewed)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  const commands = [
    {
      name: "diff.close",
      title: "Close diff viewer",
      category: "VCS",
      run() {
        const returnRoute = params()?.returnRoute
        const returnParams = returnRoute && "params" in returnRoute ? returnRoute.params : undefined
        const prompt = review.notes.length ? annotationPrompt(review.notes, draft) : draft
        props.api.ui.dialog.clear()

        props.api.route.navigate(
          returnRoute?.name ?? "home",
          (prompt || returnParams?.prompt) &&
            (!returnRoute || returnRoute.name === "session" || returnRoute.name === "home")
            ? { ...returnParams, prompt }
            : returnParams,
        )
      },
    },
    {
      name: "diff.down",
      title: "Move diff viewer down",
      category: "VCS",
      run: (context?: CommandContext<Renderable, KeyEvent>) => moveArrow(1, context?.event),
    },
    {
      name: "diff.up",
      title: "Move diff viewer up",
      category: "VCS",
      run: (context?: CommandContext<Renderable, KeyEvent>) => moveArrow(-1, context?.event),
    },
    {
      name: "diff.page.down",
      title: "Page diff viewer down",
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(8)
        },
        patches() {
          if (scroll) movePatchLine(Math.max(1, scroll.viewport.height - 2))
        },
      }),
    },
    {
      name: "diff.page.up",
      title: "Page diff viewer up",
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(-8)
        },
        patches() {
          if (scroll) movePatchLine(-Math.max(1, scroll.viewport.height - 2))
        },
      }),
    },
    {
      name: "diff.toggle",
      title: "Toggle diff viewer item",
      category: "VCS",
      run: focusRunner({
        files() {
          toggleSelectedFileTreeRow()
        },
        patches() {
          const key = selectedBlock()
          if (key) toggleBlock(key)
        },
      }),
    },
    {
      name: "diff.expand",
      title: "Expand diff viewer item",
      category: "VCS",
      run: focusRunner({
        files() {
          const highlighted = highlightedFileNode()
          if (highlighted !== undefined && expandedFileNodes().has(highlighted)) {
            setHighlighted(moveFileTreeSelectionToFirstChild(fileRows(), highlighted))
            return
          }
          setExpandedFileNodes((expanded) =>
            setFileTreeDirectoryExpanded(fileTree(), expanded, highlightedFileNode(), true),
          )
        },
        patches() {
          const key = selectedBlock()
          if (key) toggleBlock(key, true)
        },
      }),
    },
    {
      name: "diff.expand_all",
      title: "Expand all diff viewer folders",
      category: "VCS",
      run: focusRunner({
        files() {
          setExpandedFileNodes(allExpandedFileTreeDirectories(fileTree()))
        },
        patches() {
          setReview("collapsed", reconcile({}))
          measurePatchFiller()
        },
      }),
    },
    {
      name: "diff.collapse",
      title: "Collapse diff viewer item",
      category: "VCS",
      run: focusRunner({
        files() {
          const highlighted = highlightedFileNode()
          const node = highlighted === undefined ? undefined : fileTree().nodes[highlighted]
          if (node?.kind !== "directory" || !expandedFileNodes().has(node.id)) {
            setHighlighted(moveFileTreeSelectionToParent(fileRows(), highlighted))
            return
          }
          setExpandedFileNodes((expanded) =>
            setFileTreeDirectoryExpanded(fileTree(), expanded, highlightedFileNode(), false),
          )
        },
        patches() {
          const key = selectedBlock()
          if (key) toggleBlock(key, false)
        },
      }),
    },
    {
      name: "diff.next_hunk",
      title: "Jump to next diff hunk",
      category: "VCS",
      run() {
        jumpRelativeHunk(1)
      },
    },
    {
      name: "diff.previous_hunk",
      title: "Jump to previous diff hunk",
      category: "VCS",
      run() {
        jumpRelativeHunk(-1)
      },
    },
    {
      name: "diff.next_file",
      title: "Jump to next diff file",
      category: "VCS",
      run() {
        jumpRelativePatchFile(1)
      },
    },
    {
      name: "diff.previous_file",
      title: "Jump to previous diff file",
      category: "VCS",
      run() {
        jumpRelativePatchFile(-1)
      },
    },
    {
      name: "diff.mark_reviewed",
      title: "Toggle selected diff file reviewed",
      category: "VCS",
      run() {
        toggleSelectedFileReviewed()
      },
    },
    {
      name: "diff.switch_focus",
      title: "Switch diff viewer focus",
      category: "VCS",
      run() {
        if (!showFileTree()) return
        setFocus((current) => {
          if (current === "files") return "patches"
          ensureHighlightedFileNode()
          return "files"
        })
      },
    },
    {
      name: "diff.toggle_file_tree",
      title: "Toggle diff viewer file tree",
      category: "VCS",
      run() {
        const next = !fileTreeEnabled()
        if (!next) setFocus("patches")
        setFileTreeEnabled(next)
        props.api.kv.set(KV_SHOW_FILE_TREE, next)
      },
    },
    {
      name: "diff.single_patch",
      title: "Toggle single patch view",
      category: "VCS",
      run() {
        setSelectedHunk(undefined)
        if (!singlePatch()) {
          ensureHighlightedPatchFile()
          setSinglePatch(true)
          props.api.kv.set(KV_SINGLE_PATCH, true)
          scrollSinglePatchToTop()
          return
        }
        const fileIndex =
          visiblePatchFiles()[0]?.fileIndex ??
          singlePatchFileIndex(
            selectedFileIndex(),
            activePatchFileIndex(),
            currentPatchFileIndex(),
            firstPatchFileIndex(),
          )
        if (fileIndex !== undefined) selectPatchFile(fileIndex)
        setSinglePatch(false)
        props.api.kv.set(KV_SINGLE_PATCH, false)
        if (fileIndex !== undefined) scrollToPatchFileIndexAfterRender(fileIndex)
      },
    },
    {
      name: "diff.switch_source",
      title: "Switch diff viewer source",
      category: "VCS",
      run() {
        openSwitchDiffDialog()
      },
    },
    {
      name: "diff.toggle_view",
      title: "Toggle diff viewer split or unified view",
      category: "VCS",
      run() {
        if (!splitAvailable()) return
        setSelectedHunk(undefined)
        const next = view() === "split" ? "unified" : "split"
        setViewOverride(next)
        props.api.kv.set(KV_VIEW, next)
      },
    },
    {
      name: "diff.toggle_navigation",
      title: "Toggle changed lines or all lines navigation",
      category: "VCS",
      run() {
        stopHeld()
        const next = navigation() === "changes" ? "all" : "changes"
        setNavigation(next)
        props.api.kv.set(KV_NAVIGATION, next)
      },
    },
    {
      name: "diff.annotate",
      title: "Annotate selected diff lines or hunk",
      category: "VCS",
      run: annotateSelection,
    },
    {
      name: "diff.help",
      title: "Show more diff viewer shortcuts",
      category: "VCS",
      run() {
        openHelpDialog()
      },
    },
  ]

  const switchDiffOptions = createMemo(() => {
    const vcs = props.api.state.vcs
    return [
      {
        title: "Working tree",
        value: "git" as const,
        description: "Show current git changes",
      },
      ...(vcs?.branch && vcs.default_branch && vcs.branch !== vcs.default_branch
        ? [
            {
              title: "Main branch",
              value: "branch" as const,
              description: "Show changes compared to main branch",
            },
          ]
        : []),
      {
        title: "Last turn",
        value: "last-turn" as const,
        description: "Show changes from the last assistant turn",
      },
    ]
  })

  const openSwitchDiffDialog = () => {
    props.api.ui.dialog.replace(() => (
      <DialogSelect
        title="Switch source"
        skipFilter={true}
        renderFilter={false}
        current={mode()}
        options={switchDiffOptions().map((option) => ({
          ...option,
          onSelect(dialog) {
            dialog.clear()
            props.api.route.navigate(ROUTE, {
              mode: option.value,
              directory: params()?.directory,
              sessionID: params()?.sessionID,
              messageID: params()?.messageID,
              returnRoute: params()?.returnRoute,
              annotations: [...review.notes],
              draft,
            })
          },
        }))}
      />
    ))
  }

  const openHelpDialog = () => {
    props.api.ui.dialog.replace(() => <DiffViewerHelpDialog />)
    props.api.ui.dialog.setSize("large")
  }

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    commands,
    bindings: [
      { key: "j,down", cmd: "diff.down", desc: "Move diff viewer down" },
      { key: "k,up", cmd: "diff.up", desc: "Move diff viewer up" },
      { key: "pagedown,ctrl+f", cmd: "diff.page.down", desc: "Page diff viewer down" },
      { key: "pageup,ctrl+b", cmd: "diff.page.up", desc: "Page diff viewer up" },
      { key: "m", cmd: "diff.mark_reviewed", desc: "Mark selected file reviewed" },
      { key: "a", cmd: "diff.annotate", desc: "Annotate selected lines or hunk" },
      { key: "t", cmd: "diff.toggle_navigation", desc: "Toggle changed lines / all lines navigation" },
      ...props.api.tuiConfig.keybinds.gather(
        "diff",
        commands.map((command) => command.name),
      ),
    ],
  }))

  return (
    <box position="absolute" zIndex={2500} left={0} top={0} width={dimensions().width} height={dimensions().height}>
      <PanelGroup axis="y" width="100%" height="100%">
        <Panel border="none" flexShrink={0} padding={0} paddingLeft={1}>
          <text fg={theme().text}>Diff </text>
          <text fg={theme().textMuted} onMouseUp={openSwitchDiffDialog}>
            {diffSourceLabel(mode())}
          </text>
          <box flexGrow={1} />
          <text
            fg={theme().primary}
            onMouseUp={() => commands.find((command) => command.name === "diff.toggle_navigation")?.run()}
          >
            {" "}
            t: {navigation() === "changes" ? "changes only" : "all lines"}{" "}
          </text>
          <text fg={theme().primary} onMouseUp={annotateSelection}>
            {" "}
            {review.selection ? "annotate lines" : "annotate hunk"}{" "}
          </text>
          <text
            fg={theme().textMuted}
            onMouseUp={() => commands.find((command) => command.name === "diff.toggle_view")?.run()}
          >
            {" "}
            {view()}{" "}
          </text>
          <text fg={theme().textMuted} onMouseUp={() => commands[0].run()}>
            {" "}
            close{" "}
          </text>
          <text fg={theme().textMuted}>
            {files().length} {files().length === 1 ? "file" : "files"}
          </text>
        </Panel>

        <box flexGrow={1} minHeight={0}>
          <Switch>
            <Match when={diff.loading}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().textMuted}>Loading diff…</text>
              </box>
            </Match>
            <Match when={!diff.loading && diff.error}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().error}>Failed to load diff</text>
              </box>
            </Match>
            <Match when={!diff.loading && files().length === 0}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().textMuted}>No diff!</text>
              </box>
            </Match>
            <Match when={!diff.loading}>
              <PanelGroup axis="x">
                <Show when={showFileTree()}>
                  <DiffViewerFileTree
                    files={files()}
                    loading={diff.loading}
                    error={diff.error}
                    theme={theme()}
                    focused={focus() === "files"}
                    width={FILE_TREE_WIDTH}
                    highlightedNode={highlightedFileNode()}
                    selectedFileIndex={selectedFileIndex()}
                    reviewedFileNames={reviewedFileNames()}
                    expandedNodes={expandedFileNodes()}
                    onRowClick={clickFileTreeRow}
                  />
                </Show>

                <Panel flexGrow={1} minHeight={0} border="none">
                  <Separator axis="x" start={showFileTree() ? "edge-out" : undefined} />
                  <scrollbox
                    ref={(element: ScrollBoxRenderable) => (scroll = element)}
                    flexGrow={1}
                    minHeight={0}
                    scrollAcceleration={patchScrollAcceleration()}
                    verticalScrollbarOptions={{ visible: false }}
                    horizontalScrollbarOptions={{ visible: false }}
                    onMouseDown={() => setFocus("patches")}
                  >
                    <For each={visiblePatchFiles()}>
                      {(entry, index) => {
                        const reviewed = () => reviewedFileNames().has(entry.file.file)
                        return (
                          <box ref={(element: BoxRenderable) => registerPatchNode(entry.fileIndex, element)}>
                            {index() !== 0 ? <Separator axis="x" start={showFileTree() ? "edge" : undefined} /> : null}
                            <box
                              flexDirection="row"
                              gap={1}
                              flexShrink={0}
                              paddingLeft={1}
                              paddingRight={1}
                              border={patchLeftBorder()}
                              borderColor={theme().border}
                              onMouseUp={(event) => {
                                if (event.button !== MouseButton.LEFT) return
                                selectPatchFile(entry.fileIndex)
                                setFocus("patches")
                                setReview("selection", undefined)
                                setSelectedHunk(undefined)
                                toggleBlock(`${entry.fileIndex}`)
                              }}
                            >
                              <text fg={theme().primary}>{review.collapsed[`${entry.fileIndex}`] ? "▸" : "▾"}</text>
                              <text fg={reviewed() ? theme().textMuted : theme().text}>{entry.file.file}</text>
                              <box flexGrow={1} />
                              <Show when={review.notes.filter((note) => note.file === entry.file.file).length}>
                                {(count) => <text fg={theme().primary}>{count()} notes</text>}
                              </Show>
                              <text
                                fg={theme().textMuted}
                                onMouseUp={(event) => {
                                  if (event.button !== MouseButton.LEFT) return
                                  event.stopPropagation()
                                  selectPatchFile(entry.fileIndex)
                                  setFocus("patches")
                                  toggleSelectedFileReviewed()
                                }}
                              >
                                {reviewed() ? "✓ reviewed" : "mark reviewed"}
                              </text>
                              <Show
                                when={
                                  mode() === "last-turn" ||
                                  entry.file.patch !== undefined ||
                                  patches[entry.fileIndex]?.data
                                }
                              >
                                <text fg={reviewed() ? theme().textMuted : theme().diffAdded}>
                                  +{patches[entry.fileIndex]?.data?.additions ?? entry.file.additions}
                                </text>
                                <text fg={reviewed() ? theme().textMuted : theme().diffRemoved}>
                                  -{patches[entry.fileIndex]?.data?.deletions ?? entry.file.deletions}
                                </text>
                              </Show>
                            </box>
                            <Show when={!review.collapsed[`${entry.fileIndex}`]}>
                              <Separator axis="x" start={showFileTree() ? "edge" : undefined} />
                              <Show
                                when={patches[entry.fileIndex]?.data?.patch ?? entry.file.patch}
                                fallback={
                                  <text fg={theme().textMuted}>
                                    {patches[entry.fileIndex]?.error
                                      ? "Failed to load patch."
                                      : mode() !== "last-turn" && !patches[entry.fileIndex]
                                        ? "Loading patch…"
                                        : "No patch available for this file."}
                                  </text>
                                }
                              >
                                {(patch) => (
                                  <box border={patchLeftBorder()} borderColor={theme().border}>
                                    <Show
                                      when={patchHunks(entry.fileIndex).length}
                                      fallback={<text fg={theme().textMuted}>{patch()}</text>}
                                    >
                                      <For each={patchHunks(entry.fileIndex)}>
                                        {(hunk, hunkIndex) => {
                                          const key = () => `${entry.fileIndex}:${hunkIndex()}`
                                          const notes = () =>
                                            review.notes.filter(
                                              (note) =>
                                                note.file === entry.file.file &&
                                                note.source === diffSourceLabel(mode()) &&
                                                note.hunk === hunk.header,
                                            )
                                          const selected = () =>
                                            review.selection?.fileIndex === entry.fileIndex &&
                                            review.selection.hunkIndex === hunkIndex()
                                              ? review.selection
                                              : undefined
                                          const [node, setNode] = createSignal<DiffRenderable>()
                                          let codeClick = false
                                          const toggleHunk = () => {
                                            setFocus("patches")
                                            selectPatchFile(entry.fileIndex)
                                            if (
                                              review.selection?.fileIndex !== entry.fileIndex ||
                                              review.selection?.hunkIndex !== hunkIndex()
                                            )
                                              setReview("selection", undefined)
                                            toggleBlock(key())
                                            setSelectedHunk({
                                              fileIndex: entry.fileIndex,
                                              hunkIndex: hunkIndex(),
                                              scrollTop: scroll?.scrollTop ?? 0,
                                            })
                                          }
                                          createEffect(() => {
                                            const current = node()
                                            const selection = selected()
                                            if (!current) return
                                            const range = selection && {
                                              side: selection.side,
                                              anchor: selection.anchor,
                                              line: selection.line,
                                            }
                                            const highlight = highlightDiffSelection(current, range, {
                                              range: tint(themeState.theme.background, themeState.theme.primary, 0.18),
                                              current: tint(themeState.theme.background, themeState.theme.primary, 0.4),
                                              accent: themeState.theme.primary,
                                            })
                                            // Reserve/refresh signs before Yoga measures the code width.
                                            // renderBefore alone runs after layout and reflows the next frame.
                                            highlight.apply()
                                            current.onLifecyclePass = highlight.apply
                                            renderer.registerLifecyclePass(current)
                                            current.renderBefore = highlight.apply
                                            current.requestRender()
                                            onCleanup(() => {
                                              current.renderBefore = undefined
                                              renderer.unregisterLifecyclePass(current)
                                              current.onLifecyclePass = null
                                              highlight.clear()
                                            })
                                          })
                                          return (
                                            <box ref={(node: BoxRenderable) => hunkNodes.set(key(), node)}>
                                              <box
                                                flexDirection="row"
                                                backgroundColor={selected() ? theme().backgroundElement : undefined}
                                              >
                                                <text
                                                  fg={theme().primary}
                                                  flexShrink={0}
                                                  onMouseUp={(event) => {
                                                    if (event.button === MouseButton.LEFT) toggleHunk()
                                                  }}
                                                >
                                                  {review.collapsed[key()] ? "▸ expand " : "▾ collapse "}
                                                </text>
                                                <text
                                                  fg={theme().primary}
                                                  flexGrow={1}
                                                  onMouseUp={(event) => {
                                                    if (event.button !== MouseButton.LEFT) return
                                                    toggleHunk()
                                                  }}
                                                >
                                                  {hunk.header}
                                                  {notes().length ? ` · ${notes().length} notes` : ""}
                                                </text>
                                                <text
                                                  fg={theme().textMuted}
                                                  onMouseUp={() => {
                                                    selectPatchFile(entry.fileIndex)
                                                    if (!selected()) setReview("selection", undefined)
                                                    setSelectedHunk({
                                                      fileIndex: entry.fileIndex,
                                                      hunkIndex: hunkIndex(),
                                                      scrollTop: scroll?.scrollTop ?? 0,
                                                    })
                                                    annotateSelection()
                                                  }}
                                                >
                                                  {" "}
                                                  {selected() ? "annotate lines" : "annotate hunk"}{" "}
                                                </text>
                                              </box>
                                              <Show when={!review.collapsed[key()]}>
                                                <diff
                                                  ref={(element: DiffRenderable) => {
                                                    diffNodes.set(key(), element)
                                                    setNode(element)
                                                  }}
                                                  diff={hunk.patch}
                                                  onMouseDown={(event: MouseEvent) => {
                                                    if (event.button !== MouseButton.LEFT) return
                                                    setFocus("patches")
                                                    selectPatchFile(entry.fileIndex)
                                                    if (
                                                      review.selection?.fileIndex !== entry.fileIndex ||
                                                      review.selection?.hunkIndex !== hunkIndex()
                                                    )
                                                      setReview("selection", undefined)
                                                    setSelectedHunk({
                                                      fileIndex: entry.fileIndex,
                                                      hunkIndex: hunkIndex(),
                                                      scrollTop: scroll?.scrollTop ?? 0,
                                                    })
                                                    codeClick = !selectLine(entry.fileIndex, hunkIndex(), event)
                                                  }}
                                                  onMouseDrag={(event: MouseEvent) => {
                                                    codeClick = false
                                                    if (review.dragging)
                                                      selectLine(entry.fileIndex, hunkIndex(), event, { extend: true })
                                                  }}
                                                  onMouseUp={(event: MouseEvent) => {
                                                    if (codeClick && !renderer.getSelection()?.getSelectedText())
                                                      selectLine(entry.fileIndex, hunkIndex(), event, {
                                                        gutterOnly: false,
                                                      })
                                                    codeClick = false
                                                    setReview("dragging", false)
                                                  }}
                                                  onMouseDragEnd={() => {
                                                    codeClick = false
                                                    setReview("dragging", false)
                                                  }}
                                                  view={view()}
                                                  filetype={
                                                    reviewed() ? PLAIN_TEXT_FILETYPE : filetype(entry.file.file)
                                                  }
                                                  syntaxStyle={themeState.syntax()}
                                                  showLineNumbers={true}
                                                  width="100%"
                                                  wrapMode="char"
                                                  fg={reviewed() ? theme().textMuted : theme().text}
                                                  addedBg={reviewed() ? theme().backgroundElement : theme().diffAddedBg}
                                                  removedBg={
                                                    reviewed() ? theme().backgroundElement : theme().diffRemovedBg
                                                  }
                                                  addedSignColor={
                                                    reviewed() ? theme().textMuted : theme().diffHighlightAdded
                                                  }
                                                  removedSignColor={
                                                    reviewed() ? theme().textMuted : theme().diffHighlightRemoved
                                                  }
                                                  lineNumberFg={theme().diffLineNumber}
                                                  addedLineNumberBg={
                                                    reviewed()
                                                      ? theme().backgroundElement
                                                      : theme().diffAddedLineNumberBg
                                                  }
                                                  removedLineNumberBg={
                                                    reviewed()
                                                      ? theme().backgroundElement
                                                      : theme().diffRemovedLineNumberBg
                                                  }
                                                />
                                              </Show>
                                              <Show when={selected()}>
                                                {(selection) => (
                                                  <text fg={theme().primary} onMouseUp={annotateSelection}>
                                                    Selected {selection().side} lines{" "}
                                                    {Math.min(selection().anchor, selection().line)}–
                                                    {Math.max(selection().anchor, selection().line)} · current{" "}
                                                    {selection().line} · a / click to annotate
                                                  </text>
                                                )}
                                              </Show>
                                              <For each={notes()}>
                                                {(note) => (
                                                  <box flexDirection="row" backgroundColor={theme().backgroundElement}>
                                                    <text
                                                      flexGrow={1}
                                                      fg={theme().primary}
                                                      onMouseUp={() => editAnnotation(note)}
                                                    >
                                                      ✎ {note.side}:{note.start}
                                                      {note.end !== note.start ? `–${note.end}` : ""} {note.comment}
                                                    </text>
                                                    <text
                                                      fg={theme().textMuted}
                                                      onMouseUp={() =>
                                                        setReview("notes", (notes) =>
                                                          notes.filter((item) => item.id !== note.id),
                                                        )
                                                      }
                                                    >
                                                      {" "}
                                                      delete{" "}
                                                    </text>
                                                  </box>
                                                )}
                                              </For>
                                            </box>
                                          )
                                        }}
                                      </For>
                                    </Show>
                                  </box>
                                )}
                              </Show>
                            </Show>
                          </box>
                        )
                      }}
                    </For>
                    <Show when={patchFillerHeight() > 0}>
                      <box height={patchFillerHeight()} border={patchLeftBorder()} borderColor={theme().border} />
                    </Show>
                  </scrollbox>
                  <Separator axis="x" start={showFileTree() ? "edge-in" : undefined} />
                </Panel>
              </PanelGroup>
            </Match>
          </Switch>
        </box>

        <Panel flexShrink={0} gap={2} paddingLeft={1} border="none">
          <text fg={theme().text} wrapMode="none" flexShrink={0} onMouseUp={annotateSelection}>
            a <span style={{ fg: theme().textMuted }}>annotate</span>
          </text>
          <Show when={review.selection}>
            {(selection) => (
              <text fg={theme().primary} wrapMode="none" onMouseUp={annotateSelection}>
                ▶ {selection().side}:{selection().line}
              </text>
            )}
          </Show>
          <Show when={dimensions().width >= 100 && switchFocusShortcut()}>
            {(shortcut) => (
              <text
                fg={theme().text}
                wrapMode="none"
                flexShrink={0}
                onMouseUp={() => commands.find((command) => command.name === "diff.switch_focus")?.run()}
              >
                {shortcut()} <span style={{ fg: theme().textMuted }}>focus file tree</span>
              </text>
            )}
          </Show>
          <Show when={dimensions().width >= 70 && nextFileShortcut()}>
            {(shortcut) => (
              <text fg={theme().text} wrapMode="none" flexShrink={0} onMouseUp={() => jumpRelativePatchFile(1)}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>next file</span>
              </text>
            )}
          </Show>
          <Show when={dimensions().width >= 70 && nextHunkShortcut()}>
            {(shortcut) => (
              <text fg={theme().text} wrapMode="none" flexShrink={0} onMouseUp={() => jumpRelativeHunk(1)}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>next hunk</span>
              </text>
            )}
          </Show>
          <Show when={dimensions().width >= 70 && markReviewedShortcut()}>
            {(shortcut) => (
              <text fg={theme().text} wrapMode="none" flexShrink={0} onMouseUp={toggleSelectedFileReviewed}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>reviewed</span>
              </text>
            )}
          </Show>
          <Show when={helpShortcut()}>
            {(shortcut) => (
              <text fg={theme().text} wrapMode="none" flexShrink={0} onMouseUp={openHelpDialog}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>all</span>
              </text>
            )}
          </Show>
        </Panel>
      </PanelGroup>
    </box>
  )
}

function DiffViewerHelpDialog() {
  const { theme } = useTheme()
  const rows = [
    {
      shortcut: () => "q",
      action: "Close viewer",
      description: "Return to your prompt with a compact annotation draft",
    },
    {
      shortcut: () => "a",
      action: "Annotate",
      description:
        "Click a code line or drag line gutters to select; ▶ marks the current line. Shift-click extends the range",
    },
    {
      shortcut: () => "↑/↓",
      action: "Move active line",
      description: "Hold arrows or j/k to move the annotation cursor and scroll; Page Up/Down moves by a page",
    },
    {
      shortcut: () => "t",
      action: "Navigation scope",
      description: "Toggle added/deleted lines only (default) or all lines, including unchanged context",
    },
    {
      shortcut: () => "click",
      action: "Collapse blocks",
      description: "Click file or @@ hunk headers to collapse or expand; click notes to edit",
    },
    {
      shortcut: useCommandShortcut("diff.switch_focus"),
      action: "Focus file tree",
      description: "Move keyboard focus between the file tree and patch pane",
    },
    {
      shortcut: useCommandShortcut("diff.next_hunk"),
      action: "Next hunk",
      description: "Jump to the next diff hunk",
    },
    {
      shortcut: useCommandShortcut("diff.previous_hunk"),
      action: "Previous hunk",
      description: "Jump to the previous diff hunk",
    },
    {
      shortcut: useCommandShortcut("diff.next_file"),
      action: "Next file",
      description: "Select the next changed file in file-tree order",
    },
    {
      shortcut: useCommandShortcut("diff.previous_file"),
      action: "Previous file",
      description: "Select the previous changed file in file-tree order",
    },
    {
      shortcut: useCommandShortcut("diff.toggle_file_tree"),
      action: "Toggle file tree",
      description: "Show or hide the file tree sidebar",
    },
    {
      shortcut: useCommandShortcut("diff.single_patch"),
      action: "Toggle patches",
      description: "Switch between one selected patch and all patches",
    },
    {
      shortcut: useCommandShortcut("diff.switch_source"),
      action: "Switch source",
      description: "Choose working tree, main branch, or last-turn changes",
    },
    {
      shortcut: useCommandShortcut("diff.toggle_view"),
      action: "Toggle view",
      description: "Switch between split and unified diff layout",
    },
    {
      shortcut: useCommandShortcut("diff.expand_all"),
      action: "Expand all folders",
      description: "Open every folder in the file tree",
    },
    {
      shortcut: useCommandShortcut("diff.mark_reviewed"),
      action: "Mark reviewed",
      description: "Toggle reviewed state for the selected file",
    },
  ]

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Diff shortcuts
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <box flexDirection="row">
        <text fg={theme.textMuted} width={5} wrapMode="none">
          Key
        </text>
        <text fg={theme.textMuted} width={22} wrapMode="none">
          Action
        </text>
        <text fg={theme.textMuted}>Description</text>
      </box>
      <For each={rows}>
        {(row) => (
          <box flexDirection="row">
            <text fg={theme.text} width={5} wrapMode="none">
              {row.shortcut() || "-"}
            </text>
            <text fg={theme.text} width={22} wrapMode="none">
              {row.action}
            </text>
            <text fg={theme.textMuted}>{row.description}</text>
          </box>
        )}
      </For>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: () => <DiffViewer api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "diff.open",
        title: "Open diff viewer",
        slashName: "diff",
        category: "VCS",
        namespace: "palette",
        run() {
          api.route.navigate(ROUTE, {
            mode: "git",
            sessionID: "params" in api.route.current ? api.route.current.params?.sessionID : undefined,
            returnRoute: api.route.current,
          })
          api.ui.dialog.clear()
        },
      },
    ],
  })
}

export default {
  id: "diff-viewer",
  tui,
}
