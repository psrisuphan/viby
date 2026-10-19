// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AccessibleDialog from "./AccessibleDialog";
import ContextMenu from "./ContextMenu";

function SongRowHarness({
  onActionFocus,
}: {
  onActionFocus: (active: Element | null) => void;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <button ref={rowRef} type="button" onClick={() => setMenuOpen(true)}>
        Song row
      </button>
      {menuOpen && (
        <ContextMenu
          x={0}
          y={0}
          items={[
            {
              label: "Play",
              onClick: () => onActionFocus(document.activeElement),
            },
            {
              label: "Add to Playlist...",
              onClick: () => {
                onActionFocus(document.activeElement);
                setDialogOpen(true);
              },
            },
            {
              label: "Song Info",
              onClick: () => onActionFocus(document.activeElement),
            },
          ]}
          onClose={() => setMenuOpen(false)}
          returnFocusTo={rowRef.current ?? undefined}
        />
      )}
      {dialogOpen && (
        <AccessibleDialog
          ariaLabel="Add to playlist"
          overlayClassName="overlay"
          contentClassName="content"
          onClose={() => setDialogOpen(false)}
        >
          <button type="button">Choose playlist</button>
        </AccessibleDialog>
      )}
    </>
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Song row" }));
  return screen.getByRole("menu", { name: "Song actions" });
}

function activeElement() {
  return document.activeElement as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function DialogContextMenuHarness() {
  const openerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [nestedDialogOpen, setNestedDialogOpen] = useState(false);

  return (
    <AccessibleDialog
      ariaLabel="Search"
      overlayClassName="overlay"
      contentClassName="content"
      onClose={() => {}}
    >
      <input aria-label="query" />
      <button
        ref={openerRef}
        type="button"
        onContextMenu={(event) => {
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          setMenuOpen(true);
        }}
      >
        Search result
      </button>
      {menuOpen && (
        <ContextMenu
          x={10}
          y={10}
          returnFocusTo={openerRef.current ?? undefined}
          onClose={() => setMenuOpen(false)}
          items={[
            { label: "Play", onClick: () => {} },
            { label: "Queue", onClick: () => {} },
            {
              label: "Open nested dialog",
              onClick: () => setNestedDialogOpen(true),
            },
          ]}
        />
      )}
      {nestedDialogOpen && (
        <AccessibleDialog
          ariaLabel="Nested action"
          overlayClassName="nested-overlay"
          contentClassName="nested-content"
          onClose={() => setNestedDialogOpen(false)}
        >
          <button type="button">Nested action</button>
        </AccessibleDialog>
      )}
    </AccessibleDialog>
  );
}

function openDialogMenu() {
  const opener = screen.getByRole("button", { name: "Search result" });
  fireEvent.contextMenu(opener);
  return { opener, menu: screen.getByRole("menu", { name: "Song actions" }) };
}

describe("ContextMenu focus ownership", () => {
  it("returns focus to the row before an action runs, so a dialog opened from it restores to the row", async () => {
    const onActionFocus = vi.fn();
    render(<SongRowHarness onActionFocus={onActionFocus} />);
    const row = screen.getByRole("button", { name: "Song row" });

    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Add to Playlist..." }),
    );

    expect(onActionFocus).toHaveBeenCalledWith(row);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Add to playlist" }),
    ).not.toBeNull();

    fireEvent.keyDown(screen.getByRole("button", { name: "Choose playlist" }), {
      key: "Escape",
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("moves focus between menu items with arrow, Home, and End keys and wraps at the ends", () => {
    render(<SongRowHarness onActionFocus={() => {}} />);
    const menu = openMenu();
    const items = screen.getAllByRole("menuitem");
    const [play, playlist, info] = items;

    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.dataset.dialogOwner).toBeUndefined();
    expect(document.activeElement).toBe(play);

    fireEvent.keyDown(activeElement(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(playlist);

    fireEvent.keyDown(activeElement(), { key: "ArrowUp" });
    fireEvent.keyDown(activeElement(), { key: "ArrowUp" });
    expect(document.activeElement).toBe(info);

    fireEvent.keyDown(activeElement(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(play);

    fireEvent.keyDown(activeElement(), { key: "End" });
    expect(document.activeElement).toBe(info);

    fireEvent.keyDown(activeElement(), { key: "Home" });
    expect(document.activeElement).toBe(play);

    expect(items.map((item) => item.tabIndex)).toEqual([0, -1, -1]);
  });

  it("Escape closes the menu and returns focus to the row", async () => {
    render(<SongRowHarness onActionFocus={() => {}} />);
    const row = screen.getByRole("button", { name: "Song row" });

    openMenu();
    fireEvent.keyDown(activeElement(), { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("keeps a Search-style dialog menu in its owner's focus scope", async () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      { width: 1, height: 1 } as DOMRect,
    ] as unknown as DOMRectList);
    render(<DialogContextMenuHarness />);

    const { opener, menu } = openDialogMenu();
    const items = screen.getAllByRole("menuitem");
    const dialog = screen.getByRole("dialog", { name: "Search" });

    expect(menu.dataset.dialogOwner).toBe(dialog.id);
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "End" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2], { key: "Home" });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(items[0], { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Search" })).toBe(dialog);
  });

  it("restores the search opener after a nested dialog closes from the menu", async () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      { width: 1, height: 1 } as DOMRect,
    ] as unknown as DOMRectList);
    render(<DialogContextMenuHarness />);

    const { opener } = openDialogMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Open nested dialog" }),
    );

    expect(screen.getByRole("dialog", { name: "Nested action" })).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Nested action" }), {
      key: "Escape",
    });

    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(screen.queryByRole("dialog", { name: "Nested action" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Search" })).not.toBeNull();
  });
});
