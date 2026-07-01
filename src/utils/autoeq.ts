import { type PeqBand } from "../stores/settingsStore";

interface ParsedAutoEq {
	preamp: number;
	bands: PeqBand[];
}

export function parseAutoEqFilters(text: string): ParsedAutoEq {
	const lines = text.split("\n");
	let preamp = 0;
	const bands: PeqBand[] = [];

	for (let line of lines) {
		line = line.trim();
		if (!line) continue;

		if (line.toLowerCase().startsWith("preamp:")) {
			const parts = line.split(":");
			if (parts[1]) {
				const value = Number.parseFloat(parts[1].trim());
				if (!Number.isNaN(value)) preamp = value;
			}
			continue;
		}

		if (!line.toLowerCase().startsWith("filter")) continue;

		const parts = line.split(":");
		if (!parts[1]) continue;

		const tokens = parts[1].trim().split(/\s+/);
		const enabled = tokens[0]?.toUpperCase() === "ON";
		const typeToken = tokens[1]?.toUpperCase();
		let filterType: PeqBand["filterType"] = 0;
		if (typeToken === "LSC") filterType = 1;
		else if (typeToken === "HSC") filterType = 2;
		else if (typeToken === "LP") filterType = 3;
		else if (typeToken === "HP") filterType = 4;

		const freq = readNumberAfter(tokens, "fc", 1000);
		const gain = readNumberAfter(tokens, "gain", 0);
		const q = readNumberAfter(tokens, "q", 1);

		bands.push({ enabled, filterType, freq, gain, q });
	}

	return { preamp, bands };
}

function readNumberAfter(tokens: string[], key: string, fallback: number): number {
	const index = tokens.findIndex((token) => token.toLowerCase() === key);
	if (index === -1 || !tokens[index + 1]) return fallback;

	const value = Number.parseFloat(tokens[index + 1]);
	return Number.isNaN(value) ? fallback : value;
}
