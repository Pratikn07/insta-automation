import { useCallback } from "react";
import { useBeforeUnload, useBlocker } from "react-router-dom";

export function useUnsavedChangesGuard(shouldBlock: boolean) {
  const blocker = useBlocker(shouldBlock);

  useBeforeUnload(
    useCallback(
      (event) => {
        if (!shouldBlock) return;
        event.preventDefault();
        event.returnValue = "";
      },
      [shouldBlock],
    ),
  );

  return blocker;
}
