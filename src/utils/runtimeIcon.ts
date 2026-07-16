import { TrayIcon } from "@tauri-apps/api/tray";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logoUrl from "../../assets/logo.png";

const TRAY_ID = "main";
const FALLBACK_ACCENT = "hsl(125, 75%, 70%)";
const iconCache = new Map<string, Promise<Uint8Array>>();

export async function applyThemeRuntimeIcon(accent: string) {
	if (!("__TAURI_INTERNALS__" in window)) return;

	const icon = await getThemedIcon(accent);
	const [windowResult, trayResult] = await Promise.allSettled([
		getCurrentWindow().setIcon(icon),
		updateTrayIcon(icon),
	]);

	if (trayResult.status === "rejected") {
		console.warn(
			"Failed to update themed runtime tray icon:",
			trayResult.reason,
		);
	}

	if (windowResult.status === "rejected") {
		throw toError(
			"Failed to update themed runtime window icon",
			windowResult.reason,
		);
	}
}

async function updateTrayIcon(icon: Uint8Array) {
	const tray = await TrayIcon.getById(TRAY_ID);
	if (tray) await tray.setIcon(icon);
}

function getThemedIcon(accent: string) {
	const normalizedAccent = accent.trim() || FALLBACK_ACCENT;
	const cached = iconCache.get(normalizedAccent);
	if (cached) return cached;

	const next = createThemedIcon(normalizedAccent).catch((err) => {
		iconCache.delete(normalizedAccent);
		throw err;
	});
	iconCache.set(normalizedAccent, next);
	return next;
}

function toError(message: string, reason: unknown) {
	if (reason instanceof Error) {
		return new Error(`${message}: ${reason.message}`);
	}
	return new Error(`${message}: ${String(reason)}`);
}

async function createThemedIcon(accent: string) {
	const image = await loadImage(logoUrl);
	const canvas = document.createElement("canvas");
	canvas.width = image.naturalWidth;
	canvas.height = image.naturalHeight;

	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) throw new Error("Canvas 2D context is unavailable");

	context.drawImage(image, 0, 0);
	const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
	const accentRgb = cssColorToRgb(accent) ?? cssColorToRgb(FALLBACK_ACCENT);
	if (!accentRgb) throw new Error(`Unsupported runtime icon color: ${accent}`);

	for (let index = 0; index < imageData.data.length; index += 4) {
		const r = imageData.data[index];
		const g = imageData.data[index + 1];
		const b = imageData.data[index + 2];
		const a = imageData.data[index + 3];

		if (a > 0 && g > 120 && g > r * 1.25 && g > b * 1.25) {
			const shade = Math.max(r, g, b) / 255;
			const strength = 0.72 + shade * 0.28;
			imageData.data[index] = Math.round(accentRgb.r * strength);
			imageData.data[index + 1] = Math.round(accentRgb.g * strength);
			imageData.data[index + 2] = Math.round(accentRgb.b * strength);
		}
	}

	context.putImageData(imageData, 0, 0);
	const blob = await new Promise<Blob>((resolve, reject) => {
		canvas.toBlob((result) => {
			if (result) resolve(result);
			else reject(new Error("Failed to encode themed runtime icon"));
		}, "image/png");
	});

	return new Uint8Array(await blob.arrayBuffer());
}

function loadImage(src: string) {
	return new Promise<HTMLImageElement>((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error(`Failed to load runtime icon: ${src}`));
		image.src = src;
	});
}

function cssColorToRgb(color: string) {
	const canvas = document.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;

	const context = canvas.getContext("2d");
	if (!context) return null;

	context.fillStyle = "rgba(0, 0, 0, 0)";
	context.fillRect(0, 0, 1, 1);
	context.fillStyle = color;
	context.fillRect(0, 0, 1, 1);

	const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
	if (a === 0) return null;
	return { r, g, b };
}
