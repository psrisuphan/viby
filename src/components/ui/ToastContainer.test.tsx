// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});
