import { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { aleAlignedRigid, mae, pairwiseDistanceMae, rmse, rmseAlignedRigid } from "../lib/metrics.ts";
import { EXPERIMENT_WORLD_BOUNDS_M } from "../lib/types.ts";
import { getCliSeed, makeSeed, seededRng, seedNodes } from "../lib/seed.ts";

export interface ExperimentBRow {
	nodeCount: number;
	noiseSigma: number;
	rmse: number;
	mae: number;
	rmseAligned: number;
	maeAligned: number;
	pairwiseDistMae: number;
}

/**
 * Experiment B
 *
 * Goal
 * - Sweep UWB distance noise (sigma) and measure the final localization accuracy.
 *
 * Notes
 * - This is a "final score" experiment (no time series), run after a fixed duration.
 * - Node layout is deterministic for comparability.
 */
export function runExperimentB(): ExperimentBRow[] {
	const rows: ExperimentBRow[] = [];
	const simSeconds = 300;
	const nodeCount = 8;
	const baseSeed = getCliSeed(1);
	const layout = makeSeed(nodeCount, seededRng(baseSeed + 200));

	for (const sigma of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
		const runner = new SimulationRunner({
			uwbNoiseSigma: sigma,
			worldBounds: EXPERIMENT_WORLD_BOUNDS_M,
			seed: baseSeed + 210 + Math.round(sigma * 1000),
		});
		seedNodes(runner, layout);
		runner.runFor(simSeconds);
		const snap = runner.snapshot();
		rows.push({
			nodeCount,
			noiseSigma: sigma,
			rmse: rmse(snap.nodes),
			mae: mae(snap.nodes),
			rmseAligned: rmseAlignedRigid(snap.nodes),
			maeAligned: aleAlignedRigid(snap.nodes),
			pairwiseDistMae: pairwiseDistanceMae(snap.nodes),
		});
	}
	return rows;
}
