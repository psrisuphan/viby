// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useToastStore } from "../../stores/toastStore";
import ToastContainer from "./ToastContainer";

afterEach(() => {
  cleanup();
  useToastStore.setState({ toasts: [] });
});

describe("ToastContainer", () => {
  it("renders a toast and dismisses it when its close button is activated", () => {
    useToastStore.setState({
      toasts: [
        {
          id: "test-toast",
          message: "Saved successfully",
          type: "success",
          duration: 0,
        },
      ],
    });

    render(<ToastContainer />);

    expect(screen.getByText("Saved successfully")).not.toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("Saved successfully")).toBeNull();
  });

  it("keeps overflow errors visible without removing or defocusing a focused toast", () => {
    render(<ToastContainer />);

    act(() => {
      for (let index = 1; index <= 5; index += 1) {
        useToastStore.getState().addToast(`Failure ${index}`, "error");
      }
      for (const toast of useToastStore.getState().toasts) {
        useToastStore.getState().pauseToast(toast.id, "focus");
      }
      useToastStore.getState().addToast("Failure 6", "error");
    });

    const firstClose = screen.getByRole("button", {
      name: "Dismiss error notification: Failure 1",
    });
    firstClose.focus();
    expect(screen.getByText(/Additional errors \(1\)/)).not.toBeNull();
    expect(screen.getByText("Failure 6")).not.toBeNull();

    act(() => useToastStore.getState().addToast("Failure 7", "error"));

    expect(screen.getByText(/Additional errors \(2\)/)).not.toBeNull();
    expect(screen.getByText("Failure 7")).not.toBeNull();
    expect(firstClose.isConnected).toBe(true);
    expect(document.activeElement).toBe(firstClose);
    expect(document.querySelectorAll("[data-toast-id]")).toHaveLength(6);
  });
});
