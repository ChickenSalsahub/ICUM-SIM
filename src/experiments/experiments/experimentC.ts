import { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { applyMotionScenario } from "../lib/motion.ts";
import { rmseAlignedRigid, sumTx } from "../lib/metrics.ts";
import { EXPERIMENT_WORLD_BOUNDS_M, type MotionScenarioName } from "../lib/types.ts";
import { getCliSeed, makeSeed, seededRng, seedNodes } from "../lib/seed.ts";
// import { createRollingMeanConvergenceTracker } from "../lib/convergence.ts";

export interface ExperimentCTimeRow {
	timeSeconds: number;
	nodes: number;
	txPerNodePerMin: number;
	rmse: number;
}

export interface ExperimentCScenarioTimeRow extends ExperimentCTimeRow {
	scenario: MotionScenarioName;
}

/**
 * Experiment C
 *
 * Goal
 * - Understand scalability: as node count grows, how fast does the system converge,
 *   and what is the messaging rate?
 *
 * What this measures
 * - Tx per node per minute (instantaneous rate)
 * - RMSE (root mean squared error) over time
 */
export function runExperimentCScenarios(): ExperimentCScenarioTimeRow[] {
	const rows: ExperimentCScenarioTimeRow[] = [];
	const simSeconds = 600;
	const logEveryMs = 1_000;

	const baseSeed = getCliSeed(1);
	const scenarios: MotionScenarioName[] = ["none_moving", "few_moving", "many_moving"];

	for (const scenario of scenarios) {
		for (const nodeCount of [5, 10, 20, 35, 50]) {
			const uwbNoiseSigma: number = 0.05;
			const perfectChannel = uwbNoiseSigma === 0;
			const scenarioOffset = scenario === "none_moving" ? 0 : scenario === "few_moving" ? 10_000 : 20_000;
			const layout = makeSeed(nodeCount, seededRng(baseSeed + 300 + nodeCount + scenarioOffset));
			const runner = new SimulationRunner({
				uwbNoiseSigma,
				uwbAngleNoiseStdRad: perfectChannel ? 0 : 0.05,
				packetLoss: perfectChannel ? 0 : 0.1,
				worldBounds: EXPERIMENT_WORLD_BOUNDS_M,
				seed: baseSeed + 301 + nodeCount + scenarioOffset,
			});
			seedNodes(runner, layout);

			// Convergence heuristic (paper-friendly, noise-tolerant):
			//
			// Cooperative localization without anchors is only identifiable up to a global
			// rotation/translation. We therefore use an anchor-free RMSE (rigid alignment to
			// truth) and detect convergence by looking at a smoothed metric.
			//
			// Definition:
			// - Let m(t) be the rolling mean of aligned RMSE over a 30 second window.
			// - Declare convergence at the first time where |m(t) - m(t-1)| <= 0.05m for
			//   5 consecutive seconds.
			// const tracker = createRollingMeanConvergenceTracker({
			// 	samplePeriodMs: logEveryMs,
			// 	windowMs: 30_000,
			// 	stableDelta: 0.05,
			// 	stableHoldMs: 10_000,
			// });

			let lastTotalTx = 0;
			for (let t = 0; t <= simSeconds * 1000; t += logEveryMs) {
				applyMotionScenario(runner, scenario, t);
				const snap = runner.snapshot();
				const currentTotalTx = sumTx(snap.nodes);
				const currentRmse = rmseAlignedRigid(snap.nodes);

				// Instantaneous rate: (delta_tx / nodes) / (delta_time_min)
				// delta_time is logEveryMs (1 sec) = 1/60 min
				const deltaTx = currentTotalTx - lastTotalTx;
				lastTotalTx = currentTotalTx;
				const txPerNodePerMin = (deltaTx / nodeCount) * 60;

				rows.push({
					scenario,
					timeSeconds: t / 1000,
					nodes: nodeCount,
					txPerNodePerMin,
					rmse: currentRmse,
				});

				// tracker.update(t, currentRmse);
				// const { convergenceStableMs } = tracker.getState();
				// if (convergenceStableMs !== undefined) {
				// 	// Optimization: early exit if stable.
				// 	// For moving scenarios, we MUST wait until after the motion block (180s)
				// 	// to ensure we capture the motion handling and recovery.
				// 	// if (scenario === "none_moving") break;
				// 	// if (t > MOTION_STOP_MS + 30_000) break;
				// }

				runner.step(logEveryMs);
			}
		}
	}

	return rows;
}
