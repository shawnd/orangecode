import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { MouseButton, RGBA, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { createStore } from "solid-js/store"
import type { EarlyInput } from "../context/runtime"
import { promptOffsetWidth } from "../prompt/display"
import {
  homeGeometry,
  homePromptWidth,
  homeInputHeight,
  startupPresentation,
  startupSelectionSegments,
} from "../startup/presentation"
import { HomeFrame } from "./home-frame"
import { LogoView } from "./logo"
import { SplitBorder, EmptyBorder } from "../ui/border"
import { AutocompleteList } from "./prompt/autocomplete-list"

// No config, model, plugin or backend contexts: those may still be loading.
// The same editor that captured startup input owns keys until Prompt claims it.
export function EarlyPrompt(props: { input: EarlyInput }) {
  const dimensions = useTerminalDimensions()
  const [theme, setTheme] = createStore({ ...(props.input.presentation ?? startupPresentation()) })
  const [draft, setDraft] = createSignal(props.input.read())
  const [active, setActive] = createSignal(props.input.active && !props.input.modal)
  const [input, setInput] = createSignal<TextareaRenderable>()
  let scroll: ScrollBoxRenderable | undefined
  let mouse = false
  let unsubscribe = () => {}
  unsubscribe = props.input.subscribe(() => {
    const visible = props.input.active && !props.input.modal
    setActive(visible)
    if (!visible) {
      setInput(undefined)
      scroll = undefined
      if (!props.input.active) {
        const stop = unsubscribe
        unsubscribe = () => {}
        stop()
      }
      return
    }
    setDraft(props.input.read())
    setTheme({ ...(props.input.presentation ?? startupPresentation()) })
    mouse = false
  })
  onCleanup(() => unsubscribe())
  createEffect(() => {
    const textarea = input()
    const value = draft()
    if (!textarea || textarea.isDestroyed || !props.input.active) return
    textarea.setText(value.text)
    textarea.cursorOffset = promptOffsetWidth(value.text.slice(0, value.cursor))
    textarea.focus()
  })
  const layout = createMemo(() => {
    draft()
    const textarea = input()
    return homeGeometry(
      dimensions().width,
      dimensions().height,
      homePromptWidth(dimensions().width, theme.maxWidth),
      Math.min(
        active() && props.input.active && textarea && !textarea.isDestroyed ? textarea.virtualLineCount : 1,
        homeInputHeight(dimensions().height, theme.maxHeight),
      ),
      theme.bottomHeight,
      theme.footerHeight,
    )
  })
  const menu = createMemo(() => {
    draft()
    if (!active() || !props.input.active) return
    return props.input.completion?.(layout().promptTop)
  })
  createEffect(() => {
    const top = menu()?.top ?? 0
    if (active() && scroll && !scroll.isDestroyed) scroll.scrollBy(top - scroll.scrollTop)
  })
  return (
    <Show when={active()}>
      <box
        position="absolute"
        top={0}
        left={0}
        width={dimensions().width}
        height={dimensions().height}
        zIndex={10000}
        backgroundColor={theme.background}
        flexDirection="column"
      >
        <HomeFrame
          maxWidth={theme.maxWidth}
          logo={
            <LogoView
              background={RGBA.fromHex(theme.background === "transparent" ? "#000000" : theme.background)}
              text={RGBA.fromHex(theme.text)}
            />
          }
          prompt={
            <box width="100%">
              <box
                width="100%"
                border={["left"]}
                borderColor={theme.border}
                customBorderChars={SplitBorder.customBorderChars}
              >
                <box
                  width="100%"
                  paddingLeft={2}
                  paddingRight={2}
                  paddingTop={1}
                  flexShrink={0}
                  flexGrow={1}
                  backgroundColor={theme.backgroundElement}
                >
                  <textarea
                    ref={setInput}
                    width="100%"
                    minHeight={1}
                    maxHeight={homeInputHeight(dimensions().height, theme.maxHeight)}
                    backgroundColor={theme.backgroundElement}
                    focusedBackgroundColor={theme.backgroundElement}
                    textColor={theme.text}
                    focusedTextColor={theme.text}
                    cursorColor={theme.text}
                    cursorStyle={{ style: theme.cursorStyle, blinking: theme.cursorBlinking }}
                  />
                  <box height={2} paddingTop={1} flexShrink={0}>
                    <box flexDirection="row">
                      <For each={startupSelectionSegments(theme, props.input.location?.auto)}>
                        {(segment) => (
                          <text
                            fg={segment.color}
                            wrapMode="none"
                            flexShrink={segment.target === "model" || segment.target === "variant" ? 0 : 1}
                            onMouseDown={(event) => {
                              if (
                                (segment.target !== "model" && segment.target !== "variant") ||
                                (event.button !== MouseButton.LEFT && event.button !== MouseButton.RIGHT)
                              )
                                return
                              event.preventDefault()
                              event.stopPropagation()
                            }}
                            onMouseUp={(event) => {
                              if (!segment.target) return
                              if (
                                (segment.target === "model" || segment.target === "variant") &&
                                event.button !== MouseButton.LEFT &&
                                event.button !== MouseButton.RIGHT
                              )
                                return
                              event.preventDefault()
                              event.stopPropagation()
                              props.input.clickSelection?.(segment.target, event.button === MouseButton.RIGHT ? -1 : 1)
                            }}
                          >
                            <span style={{ bold: segment.bold }}>{segment.text}</span>
                          </text>
                        )}
                      </For>
                    </box>
                  </box>
                </box>
              </box>
              <box
                height={1}
                border={["left"]}
                borderColor={theme.border}
                customBorderChars={{ ...EmptyBorder, vertical: theme.backgroundElement === "transparent" ? " " : "╹" }}
              >
                <box
                  height={1}
                  border={["bottom"]}
                  borderColor={theme.backgroundElement}
                  customBorderChars={{
                    ...EmptyBorder,
                    horizontal: theme.backgroundElement === "transparent" ? " " : "▀",
                  }}
                />
              </box>
              <text height={1} fg={theme.textMuted} wrapMode="none">
                {draft().command
                  ? `Opening ${draft().command!.display} when ready · Ctrl-C exits`
                  : menu()
                    ? "↑↓ select · Tab/Enter choose · Esc dismiss · starting"
                    : draft().submit
                      ? "Submitting when ready · Shift+Enter adds a line · Ctrl-C exits"
                      : draft().changes?.length
                        ? "Selection changes apply when ready · Enter submits"
                        : theme.selection
                          ? "Starting · cached selection · Enter submits · Shift+Enter adds a line"
                          : "Enter submits · Shift+Enter adds a line · Ctrl-C exits"}
              </text>
            </box>
          }
          bottom={<box height={theme.bottomHeight} minHeight={0} flexShrink={1} />}
          footer={
            <box
              height={theme.footerHeight}
              paddingTop={theme.footerHeight >= 2 ? 1 : 0}
              paddingLeft={2}
              paddingRight={2}
              flexDirection="row"
              gap={2}
            >
              <Show when={theme.footerHeight >= 2}>
                <text fg={theme.textMuted} wrapMode="none" flexShrink={1}>
                  {props.input.location?.displayDirectory}
                </text>
                <box flexGrow={1} />
                <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                  {props.input.location?.version}
                </text>
              </Show>
            </box>
          }
        />
        <Show when={menu()}>
          {(menu) => (
            <AutocompleteList
              visible={true}
              x={layout().left}
              y={layout().promptTop}
              width={homePromptWidth(dimensions().width, theme.maxWidth)}
              height={menu().height}
              options={menu().options}
              selected={menu().selected}
              theme={{ ...theme, border: theme.menuBorder }}
              selectedText={theme.selectedText}
              scrollRef={(r) => {
                scroll = r
                r.scrollBy(menu().top - r.scrollTop)
              }}
              onMove={() => {
                mouse = true
              }}
              onOver={(index) => {
                if (mouse) props.input.highlightCompletion?.(index)
              }}
              onDown={(index) => props.input.highlightCompletion?.(index)}
              onSelect={(index) => props.input.selectCompletion?.(index)}
            />
          )}
        </Show>
      </box>
    </Show>
  )
}
