// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DragNumField } from "./EqNumericField";

afterEach(cleanup);

function pointerClick(target: Element, pointerId: number) {
  const pointer = {
    button: 0,
    clientY: 100,
    isPrimary: true,
    pointerId,
  };
  fireEvent.pointerDown(target, pointer);
  fireEvent.pointerUp(target, pointer);
}

describe("DragNumField", () => {
  it("resets on a mouse double-click even though the first click opens editing", () => {
    const onCommit = vi.fn();
    const onCommitEnd = vi.fn();
    render(
      <DragNumField
        value={1.75}
        min={0}
        max={4}
        resetValue={1}
        ariaLabel="Band Q"
        onCommit={onCommit}
        onCommitEnd={onCommitEnd}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Band Q" });
    pointerClick(slider, 1);
    const input = screen.getByRole("textbox", { name: "Band Q" });
    expect(input).not.toBeNull();

    // The first click of this pair opened the editor; the next click lands on it.
    fireEvent.click(input.parentElement as HTMLElement, { detail: 1 });
    fireEvent.click(input, { detail: 2 });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(1);
    expect(onCommitEnd).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "Band Q" })).toBeNull();
    expect(screen.getByRole("slider", { name: "Band Q" })).toBe(
      document.activeElement,
    );
  });

  it("does not reset or discard a draft when double-clicking inside an open editor", () => {
    const onCommit = vi.fn();
    render(
      <DragNumField
        value={1.75}
        min={0}
        max={4}
        resetValue={1}
        ariaLabel="Band Q"
        onCommit={onCommit}
      />,
    );

    pointerClick(screen.getByRole("slider", { name: "Band Q" }), 1);
    const input = screen.getByRole("textbox", { name: "Band Q" });
    fireEvent.change(input, { target: { value: "3.5" } });
    fireEvent.click(input, { detail: 1 });
    fireEvent.click(input, { detail: 2 });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Band Q" })).toBe(input);
    expect((input as HTMLInputElement).value).toBe("3.5");
  });

  it("keeps an unchanged value editable when double-clicking an existing input", () => {
    const onCommit = vi.fn();
    render(
      <DragNumField
        value={1.75}
        min={0}
        max={4}
        resetValue={1}
        ariaLabel="Band Q"
        onCommit={onCommit}
      />,
    );

    pointerClick(screen.getByRole("slider", { name: "Band Q" }), 1);
    const input = screen.getByRole("textbox", { name: "Band Q" });
    expect((input as HTMLInputElement).value).toBe("1.75");
    fireEvent.click(input, { detail: 1 });
    fireEvent.click(input, { detail: 2 });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Band Q" })).toBe(input);
    expect((input as HTMLInputElement).value).toBe("1.75");
  });

  it("keeps single-click editing, Enter commit, Escape cancel, and focus restoration", () => {
    const onCommit = vi.fn();
    render(
      <DragNumField
        value={1.5}
        min={0}
        max={4}
        resetValue={1}
        ariaLabel="Band Q"
        onCommit={onCommit}
      />,
    );

    pointerClick(screen.getByRole("slider", { name: "Band Q" }), 1);
    const input = screen.getByRole("textbox", { name: "Band Q" });
    fireEvent.change(input, { target: { value: "3.25" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("slider", { name: "Band Q" })).toBe(
      document.activeElement,
    );

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });
    const secondInput = screen.getByRole("textbox", { name: "Band Q" });
    fireEvent.change(secondInput, { target: { value: "2.25" } });
    fireEvent.keyDown(secondInput, { key: "Enter" });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(2.25);
    expect(screen.getByRole("slider", { name: "Band Q" })).toBe(
      document.activeElement,
    );

    const slider = document.activeElement as HTMLElement;
    fireEvent.keyDown(slider, { key: "r", ctrlKey: true });
    expect(onCommit).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(slider, { key: "r" });
    expect(onCommit).toHaveBeenLastCalledWith(1);
  });

  it("restores the drag baseline and ends a cancelled drag once", () => {
    const onCommit = vi.fn();
    const onCommitEnd = vi.fn();
    render(
      <DragNumField
        value={2}
        min={0}
        max={4}
        resetValue={1}
        ariaLabel="Band Q"
        onCommit={onCommit}
        onCommitEnd={onCommitEnd}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Band Q" });
    fireEvent.pointerDown(slider, {
      button: 0,
      clientY: 100,
      isPrimary: true,
      pointerId: 3,
    });
    fireEvent.pointerMove(slider, {
      clientY: 50,
      pointerId: 3,
    });
    fireEvent.pointerCancel(slider, { pointerId: 3 });

    expect(onCommit.mock.calls.map(([value]) => value)).toEqual([3.33, 2]);
    expect(onCommitEnd).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("slider", { name: "Band Q" })).toBe(
      document.activeElement,
    );
  });
});
