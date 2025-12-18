import { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { applyMotionScenario } from "../lib/motion.ts";
import { aleAlignedRigid, sumTx } from "../lib/metrics.ts";
import { EXPERIMENT_WORLD_BOUNDS_M, type MotionScenarioName } from "../lib/types.ts";
import { getCliNumber } from "../lib/cli.ts";
import { getCliSeed, makeSeed, seededRng, seedNodes } from "../lib/seed.ts";
import { createRollingMeanConvergenceTracker } from "../lib/convergence.ts";

export interface ExperimentCTimeRow {
	timeSeconds: number;
	nodes: number;
	txPerNodePerMin: number;
	ale: number;
	convergenceMs?: number;
	/** First time the smoothed ALE crosses <= convEps (and stays for convHold samples). */
	tEpsMs?: number;
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
 * - Tx per node per minute (normalized for fair comparison)
 * - ALE (average localization error) over time
 * - A simple convergence time heuristic
 */
export function runExperimentCScenarios(): ExperimentCScenarioTimeRow[] {
	const rows: ExperimentCScenarioTimeRow[] = [];
	const simSeconds = 300;
	const logEveryMs = 1_000;

	// Paper-friendly convergence (tweakable): time-to-threshold with hold + smoothing.
	// Run with e.g. `npm run experiments -- --convEps=1 --convHold=5 --convWindow=30`
	const convEpsMeters = getCliNumber("convEps", 1.0);
	const convHoldSamples = Math.max(1, Math.floor(getCliNumber("convHold", 5)));
	const convWindowSeconds = Math.max(1, getCliNumber("convWindow", 30));
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
			// rotation/translation. We therefore use an anchor-free ALE (rigid alignment to
			// truth) and detect convergence by looking at a smoothed metric.
			//
			// Definition:
			// - Let m(t) be the rolling mean of aligned ALE over a 30 second window.
			// - Declare convergence at the first time where |m(t) - m(t-1)| <= 0.05m for
			//   5 consecutive seconds.
			//
			// This avoids false "no convergence" when the per-second ALE jitters (which it
			// will, with packet loss and measurement noise).
			const tracker = createRollingMeanConvergenceTracker({
				samplePeriodMs: logEveryMs,
				windowMs: convWindowSeconds * 1000,
				stableDelta: 0.05,
				stableHoldMs: 5_000,
				threshold: convEpsMeters,
				thresholdHoldMs: convHoldSamples * logEveryMs,
			});

			for (let t = 0; t <= simSeconds * 1000; t += logEveryMs) {
				applyMotionScenario(runner, scenario, t);
				const snap = runner.snapshot();
				const totalTx = sumTx(snap.nodes);
				const currentAle = aleAlignedRigid(snap.nodes);

				// Normalize by time elapsed so this stays meaningful even if we
				// change the sample period.
				const txPerNodePerMin = totalTx / nodeCount / (snap.timeMs / 60000 || 1);

				tracker.update(snap.timeMs, currentAle);
				const { convergenceStableMs: convergenceMs, tThresholdMs: tEpsMs } = tracker.getState();

				rows.push({
					scenario,
					timeSeconds: t / 1000,
					nodes: nodeCount,
					txPerNodePerMin,
					ale: currentAle,
					convergenceMs,
					tEpsMs,
				});
				runner.step(logEveryMs);
			}
		}
	}

	return rows;
}
