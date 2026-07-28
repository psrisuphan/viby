import { describe, expect, it } from "vitest";
import { createTaskQueue } from "./taskQueue";

describe("createTaskQueue", () => {
	it("limits concurrent work", async () => {
		const run = createTaskQueue(3);
		let active = 0;
		let peak = 0;
		const results = await Promise.all(
			Array.from({ length: 9 }, (_, value) =>
				run(async () => {
					active += 1;
					peak = Math.max(peak, active);
					await new Promise((resolve) => setTimeout(resolve, 1));
					active -= 1;
					return value;
				}),
			),
		);

		expect(peak).toBe(3);
		expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
	});
});
