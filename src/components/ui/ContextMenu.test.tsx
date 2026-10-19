// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
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
});

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
});
