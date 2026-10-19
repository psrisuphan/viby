import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useToastStore } from "../../stores/toastStore";
import { X, CheckCircle, Info, AlertCircle } from "lucide-react";
import "./ToastContainer.css";

function getLastFocusTarget() {
  return (window as Window & { __vibyToastFocusTarget?: HTMLElement })
    .__vibyToastFocusTarget;
}

function rememberFocusTarget(element: HTMLElement) {
  // Keep the opener across a ToastContainer remount before the toast is dismissed.
  (
    window as Window & { __vibyToastFocusTarget?: HTMLElement }
  ).__vibyToastFocusTarget = element;
}

function canRestoreFocus(
  element: HTMLElement | undefined,
): element is HTMLElement {
  return !!(
    element?.isConnected &&
    !element.matches(":disabled") &&
    element.getAttribute("aria-disabled") !== "true" &&
    element.tabIndex >= 0
  );
}

export default function ToastContainer() {
  const toastRoot = document.getElementById("toast-root");
  const toasts = useToastStore((s) => s.toasts);
  const announcement = useToastStore((s) => s.currentAnnouncement);
  const removeToast = useToastStore((s) => s.removeToast);
  const pauseToast = useToastStore((s) => s.pauseToast);
  const resumeToast = useToastStore((s) => s.resumeToast);
  const focusOrigins = useRef(new Map<string, HTMLElement>());
  const seenToastIds = useRef(new Set<string>());
  const closeButtons = useRef(new Map<string, HTMLButtonElement>());

  useLayoutEffect(() => {
    const rememberExternalFocus = (event: FocusEvent) => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        target.closest("[data-toast-id]") ||
        !canRestoreFocus(target)
      )
        return;
      rememberFocusTarget(target);
    };
    const rememberExternalAction = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("[data-toast-id]"))
        return;
      const candidate =
        target instanceof HTMLElement &&
        target.matches("button, a[href], input, select, textarea, [tabindex]")
          ? target
          : target.closest<HTMLElement>(
              "button, a[href], input, select, textarea, [tabindex]",
            );
      if (candidate && canRestoreFocus(candidate)) {
        rememberFocusTarget(candidate);
      }
    };

    document.addEventListener("focusin", rememberExternalFocus, true);
    document.addEventListener("click", rememberExternalAction, true);
    return () => {
      document.removeEventListener("focusin", rememberExternalFocus, true);
      document.removeEventListener("click", rememberExternalAction, true);
    };
  }, []);

  useLayoutEffect(() => {
    const liveIds = new Set(toasts.map((toast) => toast.id));
    for (const toast of toasts) {
      if (seenToastIds.current.has(toast.id)) continue;

      const activeElement = document.activeElement;
      const activeToast =
        activeElement instanceof Element
          ? activeElement.closest<HTMLElement>("[data-toast-id]")
          : null;
      const activeToastId = activeToast?.dataset.toastId;
      const inheritedOrigin = activeToastId
        ? focusOrigins.current.get(activeToastId)
        : undefined;
      const lastFocusTarget = getLastFocusTarget();
      const activeOutsideToast =
        activeElement instanceof HTMLElement && !activeToast
          ? activeElement
          : undefined;
      if (canRestoreFocus(inheritedOrigin)) {
        focusOrigins.current.set(toast.id, inheritedOrigin);
      } else if (canRestoreFocus(activeOutsideToast)) {
        focusOrigins.current.set(toast.id, activeOutsideToast);
      } else if (canRestoreFocus(lastFocusTarget)) {
        focusOrigins.current.set(toast.id, lastFocusTarget);
      }
      seenToastIds.current.add(toast.id);
    }

    for (const id of seenToastIds.current) {
      if (liveIds.has(id)) continue;
      seenToastIds.current.delete(id);
      focusOrigins.current.delete(id);
      closeButtons.current.delete(id);
    }
  }, [toasts]);

  const dismissToast = (id: string, button: HTMLButtonElement) => {
    const toast = button.closest<HTMLElement>("[data-toast-id]");
    const hadFocus = !!toast?.contains(document.activeElement);
    const focusFellToDocument =
      document.activeElement === document.body ||
      document.activeElement === document.documentElement;
    const origin = focusOrigins.current.get(id);
    const rememberedFocus = getLastFocusTarget();
    const nextCloseButton = [...closeButtons.current.entries()].find(
      ([otherId, candidate]) => otherId !== id && candidate.isConnected,
    )?.[1];

    const target = canRestoreFocus(origin)
      ? origin
      : canRestoreFocus(rememberedFocus)
        ? rememberedFocus
        : nextCloseButton;
    if ((hadFocus || focusFellToDocument) && canRestoreFocus(target))
      target.focus();
    removeToast(id);
    if ((hadFocus || focusFellToDocument) && canRestoreFocus(target)) {
      window.requestAnimationFrame(() => {
        if (
          document.activeElement === document.body ||
          document.activeElement === document.documentElement
        ) {
          if (canRestoreFocus(target)) target.focus();
        }
      });
    }
  };

  const announcementText = announcement
    ? `${announcement.type === "error" ? "Error" : announcement.type}: ${announcement.message}`
    : "";

  const content = (
    <section className="toast-container" aria-label="Notifications">
      <div className="toast-announcer" aria-live="polite" aria-atomic="true">
        {announcement?.type !== "error" ? announcementText : ""}
      </div>
      <div className="toast-announcer" aria-live="assertive" aria-atomic="true">
        {announcement?.type === "error" ? announcementText : ""}
      </div>
      <div className="toast-list" aria-live="off">
        {toasts.map((toast) => {
          const Icon =
            toast.type === "success"
              ? CheckCircle
              : toast.type === "error"
                ? AlertCircle
                : Info;

          return (
            <div
              key={toast.id}
              className={`toast toast-${toast.type} animate-slide-up`}
              data-toast-id={toast.id}
              onMouseEnter={() => pauseToast(toast.id, "hover")}
              onMouseLeave={() => resumeToast(toast.id, "hover")}
              onFocusCapture={() => pauseToast(toast.id, "focus")}
              onBlurCapture={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                ) {
                  resumeToast(toast.id, "focus");
                }
              }}
            >
              <div className="toast-icon">
                <Icon size={18} aria-hidden="true" />
              </div>
              <div className="toast-message">{toast.message}</div>
              <button
                type="button"
                className="toast-close"
                ref={(button) => {
                  if (button) closeButtons.current.set(toast.id, button);
                  else closeButtons.current.delete(toast.id);
                }}
                onClick={(event) => dismissToast(toast.id, event.currentTarget)}
                aria-label={`Dismiss ${toast.type} notification: ${toast.message}`}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );

  return toastRoot ? createPortal(content, toastRoot) : content;
}
