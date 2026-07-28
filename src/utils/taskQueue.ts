export function createTaskQueue(concurrency: number) {
	let active = 0;
	const pending: Array<() => void> = [];

	const pump = () => {
		while (active < concurrency && pending.length > 0) {
			pending.shift()?.();
		}
	};

	return <T>(task: () => Promise<T>) =>
		new Promise<T>((resolve, reject) => {
			pending.push(() => {
				active += 1;
				Promise.resolve().then(task).then(resolve, reject).finally(() => {
					active -= 1;
					pump();
				});
			});
			pump();
		});
}
