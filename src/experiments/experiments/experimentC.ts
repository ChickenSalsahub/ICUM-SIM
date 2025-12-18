import { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { applyMotionScenario } from "../lib/motion.ts";
import { ale, sumTx } from "../lib/metrics.ts";
import { EXPERIMENT_WORLD_BOUNDS_M, type MotionScenarioName } from "../lib/types.ts";
import { getCliSeed, makeSeed, seededRng, seedNodes } from "../lib/seed.ts";

export interface ExperimentCTimeRow {
	timeSeconds: number;
	nodes: number;
	txPerNodePerMin: number;
	ale: number;
	convergenceMs?: number;
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
	const baseSeed = getCliSeed(1);
	const scenarios: MotionScenarioName[] = ["none_moving", "few_moving", "many_moving"];

	for (const scenario of scenarios) {
		for (const nodeCount of [5, 10, 20, 35, 50]) {
			const scenarioOffset = scenario === "none_moving" ? 0 : scenario === "few_moving" ? 10_000 : 20_000;
			const layout = makeSeed(nodeCount, seededRng(baseSeed + 300 + nodeCount + scenarioOffset));
			const runner = new SimulationRunner({
				uwbNoiseSigma: 0.05,
				worldBounds: EXPERIMENT_WORLD_BOUNDS_M,
				seed: baseSeed + 301 + nodeCount + scenarioOffset,
			});
			seedNodes(runner, layout);

			let previousAle = Number.POSITIVE_INFINITY;
			let stableSamples = 0;
			let convergenceMs: number | undefined;

			for (let t = 0; t <= simSeconds * 1000; t += logEveryMs) {
				applyMotionScenario(runner, scenario, t);
				const snap = runner.snapshot();
				const totalTx = sumTx(snap.nodes);
				const currentAle = ale(snap.nodes);

				// Normalize by time elapsed so this stays meaningful even if we
				// change the sample period.
				const txPerNodePerMin = totalTx / nodeCount / (snap.timeMs / 60000 || 1);

				// Convergence heuristic:
				// - Track ALE changes
				// - Declare converged once it stays within 0.01m for 5 consecutive samples
				if (convergenceMs === undefined) {
					const delta = Math.abs(currentAle - previousAle);
					stableSamples = delta < 0.01 ? stableSamples + 1 : 0;
					if (stableSamples >= 5) convergenceMs = snap.timeMs;
					previousAle = currentAle;
				}

				rows.push({
					scenario,
					timeSeconds: t / 1000,
					nodes: nodeCount,
					txPerNodePerMin,
					ale: currentAle,
					convergenceMs,
				});
				runner.step(logEveryMs);
			}
		}
	}

	return rows;
}
