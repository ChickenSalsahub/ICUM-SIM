import { describe, it, expect } from "vitest";
import { CloudBackend } from "../CloudBackend";

function link(id: number, range: number) {
	return { id, range, aoa: 0 };
}

describe("CloudBackend", () => {
	it("produces fused records without any x/y anchors", () => {
		const cloud = new CloudBackend();
		// Triangle-ish ranges; AoA omitted/ignored by using 0.
		cloud.ingest({
			nodeId: 1,
			timestamp: 0,
			battery: 100,
			status: "STATIONARY",
			neighbors: [link(2, 5), link(3, 7)],
		});
		cloud.ingest({
			nodeId: 2,
			timestamp: 0,
			battery: 100,
			status: "STATIONARY",
			neighbors: [link(1, 5), link(3, 6)],
		});
		cloud.ingest({
			nodeId: 3,
			timestamp: 0,
			battery: 100,
			status: "STATIONARY",
			neighbors: [link(1, 7), link(2, 6)],
		});

		const updated = cloud.tick(1001);
		expect(updated).toBe(true);

		const records = cloud.getRecords();
		// Expect at least one record per ingested node.
		const ids = new Set(records.slice(0, 3).map((r) => r.nodeId));
		expect(ids.has(1)).toBe(true);
		expect(ids.has(2)).toBe(true);
		expect(ids.has(3)).toBe(true);
		for (const r of records.slice(0, 3)) {
			expect(Number.isFinite(r.position.x)).toBe(true);
			expect(Number.isFinite(r.position.y)).toBe(true);
		}
	});
});
