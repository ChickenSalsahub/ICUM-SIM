export type RollingMeanConvergenceOptions = {
	/** Sample period of updates (ms). */
	samplePeriodMs: number;
	/** Rolling mean window length (ms). */
	windowMs: number;
	/** Stability threshold on |mean(t) - mean(t-1 sample)| (same units as metric). */
	stableDelta: number;
	/** Required duration of stability before declaring convergence (ms). */
	stableHoldMs: number;
	/** Optional absolute threshold on the rolling mean (same units as metric). */
	threshold?: number;
	/** Optional required duration below threshold (ms). */
	thresholdHoldMs?: number;
};

export type RollingMeanConvergenceState = {
	convergenceStableMs?: number;
	tThresholdMs?: number;
	lastMean?: number;
	stableHoldSamples: number;
	thresholdHoldSamples: number;
	recent: number[];
	windowSamples: number;
	stableHoldRequiredSamples: number;
	thresholdHoldRequiredSamples: number;
};

export function createRollingMeanConvergenceTracker(opts: RollingMeanConvergenceOptions) {
	const windowSamples = Math.max(1, Math.round(opts.windowMs / Math.max(1, opts.samplePeriodMs)));
	const stableHoldRequiredSamples = Math.max(1, Math.round(opts.stableHoldMs / Math.max(1, opts.samplePeriodMs)));
	const thresholdHoldRequiredSamples = opts.thresholdHoldMs
		? Math.max(1, Math.round(opts.thresholdHoldMs / Math.max(1, opts.samplePeriodMs)))
		: 0;

	const state: RollingMeanConvergenceState = {
		recent: [],
		windowSamples,
		stableHoldSamples: 0,
		thresholdHoldSamples: 0,
		stableHoldRequiredSamples,
		thresholdHoldRequiredSamples,
	};

	const update = (timeMs: number, value: number) => {
		if (!Number.isFinite(value)) return { ...state };

		state.recent.push(value);
		if (state.recent.length > state.windowSamples) state.recent.shift();
		if (state.recent.length < state.windowSamples) return { ...state };

		const mean = state.recent.reduce((s, v) => s + v, 0) / state.recent.length;

		// Time-to-threshold: first time mean stays <= threshold for thresholdHoldRequiredSamples.
		if (opts.threshold !== undefined && state.tThresholdMs === undefined) {
			if (mean <= opts.threshold) {
				state.thresholdHoldSamples++;
				if (state.thresholdHoldSamples >= state.thresholdHoldRequiredSamples) state.tThresholdMs = timeMs;
			} else {
				state.thresholdHoldSamples = 0;
			}
		}

		// Stability: first time successive rolling means stay within stableDelta for stableHoldRequiredSamples.
		if (state.lastMean !== undefined && state.convergenceStableMs === undefined) {
			state.stableHoldSamples = Math.abs(mean - state.lastMean) <= opts.stableDelta ? state.stableHoldSamples + 1 : 0;
			if (state.stableHoldSamples >= state.stableHoldRequiredSamples) state.convergenceStableMs = timeMs;
		}

		state.lastMean = mean;
		return { ...state };
	};

	return {
		update,
		getState: () => ({ ...state }),
		reset: () => {
			state.recent.length = 0;
			state.convergenceStableMs = undefined;
			state.tThresholdMs = undefined;
			state.lastMean = undefined;
			state.stableHoldSamples = 0;
			state.thresholdHoldSamples = 0;
		},
	};
}
