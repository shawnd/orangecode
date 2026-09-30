import { batch, createEffect, createSignal, onCleanup } from "solid-js"
import { useTuiStartup } from "../context/runtime"
import { useDialog } from "../ui/dialog"
import { DialogModel } from "./dialog-model"

// Use the real picker as soon as renderer/context services exist. The backend
// may still be resolving; cached options are replaced by live data reactively.
export function useStartupModelDialog() {
  const early = useTuiStartup().earlyInput
  const dialog = useDialog()
  if (!early?.openModal || !early.closeModal || !early.selectModel) return
  const [draft, setDraft] = createSignal(early.read())
  onCleanup(early.subscribe(() => setDraft(early.read())))
  createEffect(() => {
    const command = draft().command
    if (!early.active || early.modal || command?.name !== "model.list") return
    batch(() => {
      early.openModal?.()
      if (!early.modal) return
      dialog.replace(() => (
        <DialogModel
          startup={{
            snapshot: early.presentation?.controls,
            selection: () => early.presentation?.selection,
            active: () => early.active,
            changed: () => Boolean(draft().changes?.length),
            select: (providerID, modelID) => early.selectModel?.(providerID, modelID),
          }}
        />
      ))
    })
  })
  createEffect(() => {
    draft()
    if (early.modal && dialog.stack.length === 0) early.closeModal?.()
  })
}
