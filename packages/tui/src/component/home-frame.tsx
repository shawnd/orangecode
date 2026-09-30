import type { JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { homePromptWidth } from "../startup/presentation"

// Shared by the editable startup shell and the actual home, including plugin
// slots. Keep the ANSI counterpart in homeGeometry covered by layout tests.
export function HomeFrame(props: {
  maxWidth: number | "auto"
  logo: JSX.Element
  prompt: JSX.Element
  bottom: JSX.Element
  footer: JSX.Element
  toast?: JSX.Element
}) {
  const dimensions = useTerminalDimensions()
  return (
    <>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0} maxWidth="100%" overflow="hidden">
          {props.logo}
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box width={homePromptWidth(dimensions().width, props.maxWidth)} zIndex={1000} paddingTop={1} flexShrink={0}>
          {props.prompt}
        </box>
        {props.bottom}
        <box flexGrow={1} minHeight={0} />
        {props.toast}
      </box>
      <box width="100%" flexShrink={0}>
        {props.footer}
      </box>
    </>
  )
}
