import { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { EXPERIMENT_WORLD_BOUNDS_M, type MotionScenarioName } from "../lib/types.ts";
import { measurementAngleResidualMae, measurementRangeResidualMae, rmseAlignedRigid, sumTx } from "../lib/metrics.ts";
import { getCliSeed, makeSeed, seededRng, seedNodes } from "../lib/seed.ts";
import { applyMotionScenario } from "../lib/motion.ts";

export interface ExperimentETimeRow {
	scenario: string;
	policy: "baseline" | "icum";
	seed: number;
	timeSeconds: number;
	txTotal: number;
	rmse: number;
	rangeResidualMae: number;
	angleResidualMae: number;
}

/**
 * Experiment E
 *
 * Goal
 * - A compact A/B experiment runner that compares two policies across scenarios.
 *
 * Why it exists (vs Experiment A)
 * - Experiment A is a single time series comparison.
 * - Experiment E is meant for repeated paper-style runs with explicit seed per policy+scenario,
 *   and it uses a finer simulation timestep to more closely approximate continuous behavior.
 */
export function runExperimentE(): ExperimentETimeRow[] {
	const baseSeed = getCliSeed(1);
	const simSeconds = 300;
	const dtMs = 250;
	const logEveryMs = 1_000;
	const nodeCount = 10;
	const uwbNoiseSigma: number = 0.05;
	const perfectChannel = uwbNoiseSigma === 0;
	const layout = makeSeed(nodeCount, seededRng(baseSeed + 600));

	const makeRunner = (policy: "baseline" | "icum", seed: number) =>
		new SimulationRunner({
			uwbNoiseSigma,
			uwbAngleNoiseStdRad: perfectChannel ? 0 : 0.05,
			packetLoss: perfectChannel ? 0 : 0.1,
			seed,
			firmwareConfig:
				policy === "baseline"
					? {
							eventDrivenSensing: false,
							helloIntervalMovingMs: 2_000,
							helloIntervalIdleMs: 2_000,
							rangingIntervalMovingMs: 2_000,
							rangingIntervalIdleMs: 2_000,
							neighborTimeoutMs: 5_000,
					  }
					: { eventDrivenSensing: true },
			worldBounds: EXPERIMENT_WORLD_BOUNDS_M,
		});

	const scenarios: MotionScenarioName[] = ["none_moving", "few_moving", "many_moving"];
	const rows: ExperimentETimeRow[] = [];
 
	for (const scenario of scenarios) {
		for (const policy of ["baseline", "icum"] as const) {
			const seed = baseSeed + 700 + scenario.length * 31 + (policy === "baseline" ? 1 : 2);
			const runner = makeRunner(policy, seed);
			// runner.setWorldBounds(EXPERIMENT_WORLD_BOUNDS_M); // Set in makeRunner
			seedNodes(runner, layout);
 
			let nextLog = 0;
			for (let tMs = 0; tMs <= simSeconds * 1000; tMs += dtMs) {
				applyMotionScenario(runner, scenario, tMs);
				if (tMs >= nextLog) {
					const snap = runner.snapshot();
					rows.push({
						scenario,
						policy,
						seed,
						timeSeconds: tMs / 1000,
						txTotal: sumTx(snap),
						rmse: rmseAlignedRigid(snap),
						rangeResidualMae: measurementRangeResidualMae(snap),
						angleResidualMae: measurementAngleResidualMae(snap),
					});
					nextLog += logEveryMs;
				}
				runner.step(dtMs);
			}
		}
	}

	return rows;
}
