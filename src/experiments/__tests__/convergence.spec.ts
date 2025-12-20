import { describe, expect, it } from "vitest";
import { createRollingMeanConvergenceTracker } from "../lib/convergence.ts";

describe("createRollingMeanConvergenceTracker", () => {
	it("detects stability when rolling mean stops changing", () => {
		const tracker = createRollingMeanConvergenceTracker({
			samplePeriodMs: 1000,
			windowMs: 3000,
			stableDelta: 0.05,
			stableHoldMs: 5000,
		});

		// First 3 samples fill the window; after that the mean is constant at 1.0.
		for (let t = 0; t <= 10_000; t += 1000) {
			tracker.update(t, 1.0);
		}

		const s = tracker.getState();
		// Window fills at t=2000 (3 samples). Stability comparisons start at t=3000.
		// With a 5-sample hold, convergence triggers at t=7000.
		expect(s.convergenceStableMs).toBe(7_000);
	});

	it("detects threshold time when rolling mean stays below threshold for hold", () => {
		const tracker = createRollingMeanConvergenceTracker({
			samplePeriodMs: 1000,
			windowMs: 2000,
			stableDelta: 0.01,
			stableHoldMs: 5000,
			threshold: 1.0,
			thresholdHoldMs: 2000,
		});

		// Window fills at t=1000. Mean becomes <=1.0 starting at t=3000 and stays.
		tracker.update(0, 2.0);
		tracker.update(1000, 1.2);
		tracker.update(2000, 0.9);
		tracker.update(3000, 0.9);
		tracker.update(4000, 0.9);

		const s = tracker.getState();
		expect(s.tThresholdMs).toBe(4_000);
	});

	it("ignores non-finite samples", () => {
		const tracker = createRollingMeanConvergenceTracker({
			samplePeriodMs: 1000,
			windowMs: 2000,
			stableDelta: 0.01,
			stableHoldMs: 2000,
		});

		tracker.update(0, Number.NaN);
		tracker.update(1000, 1.0);
		tracker.update(2000, 1.0);
		tracker.update(3000, 1.0);
		tracker.update(4000, 1.0);

		// With window=2, the first valid mean exists at t=2000.
		// Stability hold is 2 samples (2 comparisons), so it triggers at t=4000.
		expect(tracker.getState().convergenceStableMs).toBe(4_000);
	});
});
