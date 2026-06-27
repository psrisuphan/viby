export class LogicalSize {
	width: number;
	height: number;

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
	}
}

type Size = { width: number; height: number };
type Position = { x: number; y: number };

class BrowserWindow {
	private resizable = true;
	private maximized = false;

	async close() {}
	async minimize() {}
	async toggleMaximize() {
		this.maximized = !this.maximized;
	}
	async maximize() {
		this.maximized = true;
	}
	async isMaximized() {
		return this.maximized;
	}
	async show() {}
	async hide() {}
	async setFocus() {}
	async startDragging() {}
	async startResizeDragging(_direction: string) {}
	async setResizable(value: boolean) {
		this.resizable = value;
	}
	async isResizable() {
		return this.resizable;
	}
	async setMinSize(_size: LogicalSize) {}
	async setSize(_size: LogicalSize) {}
	async innerSize(): Promise<Size> {
		return { width: 1280, height: 800 };
	}
	async outerPosition(): Promise<Position> {
		return { x: 0, y: 0 };
	}
	async setPosition(_position: Position) {}
	async center() {}
	async setAlwaysOnTop(value: boolean) {
		void value;
	}
	onResized(_handler: () => void): Promise<() => void> {
		return Promise.resolve(() => {});
	}
}

const windowInstance = new BrowserWindow();

export function getCurrentWindow() {
	return windowInstance;
}
