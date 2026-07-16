export function shuffled<T>(items: readonly T[]): T[] {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

export function sample<T>(items: readonly T[], count: number): T[] {
	const result = [...items];
	const limit = Math.min(Math.max(0, count), result.length);
	for (let i = 0; i < limit; i++) {
		const j = i + Math.floor(Math.random() * (result.length - i));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result.slice(0, limit);
}
