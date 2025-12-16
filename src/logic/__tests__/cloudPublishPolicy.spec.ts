import { describe, it, expect } from "vitest";
import { CloudPublishTracker } from "../cloudPublishPolicy";

describe("CloudPublishTracker", () => {
	it("publishes on first report, then suppresses if nothing changes", () => {
		const tracker = new CloudPublishTracker({ staleMs: 30_000 });
		const t0 = 1_000;
		expect(tracker.shouldPublish({ nodeId: 1, nowMs: t0, isAnchor: false, isMoving: false, neighborIds: [2, 3] })).toBe(
			true
		);
		expect(
			tracker.shouldPublish({ nodeId: 1, nowMs: t0 + 1_000, isAnchor: false, isMoving: false, neighborIds: [2, 3] })
		).toBe(false);
	});

	it("publishes when moving", () => {
		const tracker = new CloudPublishTracker({ staleMs: 30_000 });
		const t0 = 1_000;
		tracker.shouldPublish({ nodeId: 1, nowMs: t0, isMoving: false, neighborIds: [] });
		expect(tracker.shouldPublish({ nodeId: 1, nowMs: t0 + 500, isMoving: true, neighborIds: [] })).toBe(true);
	});

	it("publishes when acting as anchor", () => {
		const tracker = new CloudPublishTracker({ staleMs: 30_000 });
		expect(tracker.shouldPublish({ nodeId: 99, nowMs: 1_000, isAnchor: true, isMoving: false, neighborIds: [] })).toBe(
			true
		);
		expect(tracker.shouldPublish({ nodeId: 99, nowMs: 1_500, isAnchor: true, isMoving: false, neighborIds: [] })).toBe(
			true
		);
	});

	it("publishes when topology changes", () => {
		const tracker = new CloudPublishTracker({ staleMs: 30_000 });
		const t0 = 1_000;
		tracker.shouldPublish({ nodeId: 1, nowMs: t0, isMoving: false, neighborIds: [2] });
		// suppressed, but signature should still be tracked
		expect(tracker.shouldPublish({ nodeId: 1, nowMs: t0 + 1_000, isMoving: false, neighborIds: [2] })).toBe(false);
		// topology change -> publish
		expect(tracker.shouldPublish({ nodeId: 1, nowMs: t0 + 2_000, isMoving: false, neighborIds: [2, 3] })).toBe(true);
	});

	it("publishes when stale timer elapses", () => {
		const tracker = new CloudPublishTracker({ staleMs: 1_000 });
		const t0 = 10_000;
		tracker.shouldPublish({ nodeId: 1, nowMs: t0, isMoving: false, neighborIds: [] });
		expect(tracker.shouldPublish({ nodeId: 1, nowMs: t0 + 500, isMoving: false, neighborIds: [] })).toBe(false);
		expect(tracker.shouldPublish({ nodeId: 1, nowMs: t0 + 1_001, isMoving: false, neighborIds: [] })).toBe(true);
	});
});
