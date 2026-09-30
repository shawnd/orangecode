import { createContext, useContext, type ParentProps } from "solid-js"

const ShutdownContext = createContext<(done: Promise<void>) => void>()

export function ShutdownProvider(props: ParentProps<{ track: (done: Promise<void>) => void }>) {
  return <ShutdownContext.Provider value={props.track}>{props.children}</ShutdownContext.Provider>
}

export function useShutdown() {
  const track = useContext(ShutdownContext)
  return (done: Promise<void>) => {
    const handled = done.catch((error) => console.error("Failed to finish TUI cleanup", { error }))
    track?.(handled)
  }
}
