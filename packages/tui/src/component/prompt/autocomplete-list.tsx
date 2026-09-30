import { Index, Show } from "solid-js"
import type { RGBA, ScrollBoxRenderable } from "@opentui/core"
import { SplitBorder } from "../../ui/border"

// Shared by the live autocomplete and the context-free startup preview.
export function AutocompleteList(props: {
  visible: boolean
  x: number
  y: number
  width: number
  height: number
  options: readonly { display: string; description?: string }[]
  selected: number
  theme: {
    border: RGBA | string
    backgroundMenu: RGBA | string
    primary: RGBA | string
    text: RGBA | string
    textMuted: RGBA | string
  }
  selectedText: RGBA | string
  scrollRef?: (scroll: ScrollBoxRenderable) => void
  scrollAcceleration?: ScrollBoxRenderable["scrollAcceleration"]
  onMove?: () => void
  onOver?: (index: number) => void
  onDown?: (index: number) => void
  onSelect?: (index: number) => void
}) {
  return (
    <box
      visible={props.visible}
      position="absolute"
      top={props.y - props.height}
      left={props.x}
      width={props.width}
      zIndex={100}
      {...SplitBorder}
      borderColor={props.theme.border}
    >
      <scrollbox
        ref={props.scrollRef}
        backgroundColor={props.theme.backgroundMenu}
        height={props.height}
        scrollbarOptions={{ visible: false }}
        scrollAcceleration={props.scrollAcceleration}
      >
        <Index
          each={props.options}
          fallback={
            <box paddingLeft={1} paddingRight={1}>
              <text fg={props.theme.textMuted}>No matching items</text>
            </box>
          }
        >
          {(option, index) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={index === props.selected ? props.theme.primary : undefined}
              flexDirection="row"
              onMouseMove={() => props.onMove?.()}
              onMouseOver={() => props.onOver?.(index)}
              onMouseDown={() => props.onDown?.(index)}
              onMouseUp={() => props.onSelect?.(index)}
            >
              <text fg={index === props.selected ? props.selectedText : props.theme.text} flexShrink={0}>
                {option().display}
              </text>
              <Show when={option().description}>
                <text fg={index === props.selected ? props.selectedText : props.theme.textMuted} wrapMode="none">
                  {" " + option().description?.trimStart()}
                </text>
              </Show>
            </box>
          )}
        </Index>
      </scrollbox>
    </box>
  )
}
