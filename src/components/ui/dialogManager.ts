import { isWithinDialogScope } from "./dialogFocus";

interface DialogRegistration {
  element: HTMLDivElement;
  depth: number;
  modal: boolean;
  previousFocus: HTMLElement | null;
  parentElement: () => HTMLDivElement | null;
  parentLastFocused: { current: HTMLElement | null };
}

interface DialogEntry extends DialogRegistration {
  order: number;
}

const dialogs: DialogEntry[] = [];
const inertBeforeDialog = new Map<HTMLElement, boolean>();
let nextOrder = 0;

function orderedDialogs(): DialogEntry[] {
  return dialogs
    .filter((entry) => entry.element.isConnected)
    .sort(
      (left, right) => left.depth - right.depth || left.order - right.order,
    );
}

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

export function isTopDialog(element: HTMLDivElement): boolean {
  const ordered = orderedDialogs();
  return last(ordered)?.element === element;
}

export function isModalDialogOpen(): boolean {
  return dialogs.some((entry) => entry.modal && entry.element.isConnected);
}

function updateBackgroundIsolation() {
  const topModal = last(orderedDialogs().filter((entry) => entry.modal));
  const toastRoot =
    typeof document !== "undefined"
      ? document.getElementById("toast-root")
      : null;
  if (topModal) {
    toastRoot?.setAttribute("data-dialog-owner", topModal.element.id);
  } else {
    toastRoot?.removeAttribute("data-dialog-owner");
  }
  const inertElements = new Set<HTMLElement>();
  if (topModal && typeof document !== "undefined") {
    let branch: HTMLElement | null = topModal.element;
    while (branch && branch !== document.body) {
      const parentElement: HTMLElement | null = branch.parentElement;
      if (!parentElement) break;
      for (const sibling of Array.from(parentElement.children)) {
        if (
          sibling !== branch &&
          sibling instanceof HTMLElement &&
          sibling.dataset.dialogOwner !== topModal.element.id
        ) {
          inertElements.add(sibling);
        }
      }
      branch = parentElement;
    }
  }

  for (const [element, wasInert] of inertBeforeDialog) {
    if (inertElements.has(element)) continue;
    element.inert = wasInert;
    inertBeforeDialog.delete(element);
  }
  for (const element of inertElements) {
    if (!inertBeforeDialog.has(element)) {
      inertBeforeDialog.set(element, element.inert);
      element.inert = true;
    }
  }
}

export function registerDialog(registration: DialogRegistration): () => void {
  const entry: DialogEntry = { ...registration, order: nextOrder++ };
  dialogs.push(entry);
  updateBackgroundIsolation();

  return () => {
    const wasTop = last(orderedDialogs()) === entry;
    const index = dialogs.indexOf(entry);
    if (index >= 0) dialogs.splice(index, 1);
    updateBackgroundIsolation();

    if (!wasTop) return;
    const nextTop = last(orderedDialogs());
    const previousFocus = entry.previousFocus;
    const target =
      previousFocus?.isConnected && !entry.element.contains(previousFocus)
        ? previousFocus
        : null;

    if (nextTop) {
      if (target && isWithinDialogScope(nextTop.element, target)) {
        target.focus({ preventScroll: true });
        return;
      }
      const parent = entry.parentElement();
      if (parent && nextTop.element === parent) {
        const parentFocus = entry.parentLastFocused.current;
        if (
          parentFocus?.isConnected &&
          isWithinDialogScope(parent, parentFocus)
        ) {
          parentFocus.focus({ preventScroll: true });
        } else {
          parent.focus({ preventScroll: true });
        }
      }
      return;
    }
    if (target) target.focus({ preventScroll: true });
  };
}
