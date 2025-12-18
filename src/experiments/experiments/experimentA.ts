import { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { applyMotionScenario } from "../lib/motion.ts";
import { rmse, sumTx } from "../lib/metrics.ts";
import { EXPERIMENT_WORLD_BOUNDS_M, type MotionScenarioName } from "../lib/types.ts";
import { getCliSeed, makeSeed, seededRng, seedNodes } from "../lib/seed.ts";

export interface ExperimentATimeRow {
	timeSeconds: number;
	baselineTx: number;
	baselineRmse: number;
	etmTx: number;
	etmRmse: number;
}

export interface ExperimentAScenarioTimeRow extends ExperimentATimeRow {
	scenario: MotionScenarioName;
}

/**
 * Experiment A
 *
 * Goal
 * - Compare a "baseline" periodic messaging policy vs ICUM/ETM event-driven sensing.
 *
 * What this measures
 * - Total Tx count (proxy for energy / airtime)
 * - Localization RMSE over time
 *
 * How it's run
 * - Fixed node layout per run (deterministic)
 * - Three motion scenarios (none/few/many moving)
 * - Time series sampled every 1s
 */
export function runExperimentAScenarios(): ExperimentAScenarioTimeRow[] {
	const baseSeed = getCliSeed(1);
	const layout = makeSeed(10, seededRng(baseSeed + 100));
	const scenarios: MotionScenarioName[] = ["none_moving", "few_moving", "many_moving"];
	const rows: ExperimentAScenarioTimeRow[] = [];

	for (const scenario of scenarios) {
		// Separate seeds per scenario so stochastic effects don't correlate across scenarios.
		const scenarioOffset = scenario === "none_moving" ? 0 : scenario === "few_moving" ? 10_000 : 20_000;

		// Baseline: periodic HELLO/RANGING regardless of motion state.
		const baseline = new SimulationRunner({
			uwbNoiseSigma: 0.05,
			worldBounds: EXPERIMENT_WORLD_BOUNDS_M,
			seed: baseSeed + 101 + scenarioOffset,
			firmwareConfig: {
				eventDrivenSensing: false,
				helloIntervalMovingMs: 2_000,
				helloIntervalIdleMs: 2_000,
				rangingIntervalMovingMs: 2_000,
				rangingIntervalIdleMs: 2_000,
				neighborTimeoutMs: 5_000,
			},
		});

		// ETM/ICUM: event-driven sensing while stationary+stable.
		const etm = new SimulationRunner({
			uwbNoiseSigma: 0.05,
			worldBounds: EXPERIMENT_WORLD_BOUNDS_M,
			seed: baseSeed + 102 + scenarioOffset,
			firmwareConfig: { eventDrivenSensing: true },
		});

		seedNodes(baseline, layout);
		seedNodes(etm, layout);

		const simSeconds = 600;
		const logEveryMs = 1_000;
		for (let t = 0; t <= simSeconds * 1000; t += logEveryMs) {
			applyMotionScenario(baseline, scenario, t);
			applyMotionScenario(etm, scenario, t);

			const snapBaseline = baseline.snapshot();
			const snapEtm = etm.snapshot();
			rows.push({
				scenario,
				timeSeconds: t / 1000,
				baselineTx: sumTx(snapBaseline.nodes),
				baselineRmse: rmse(snapBaseline.nodes),
				etmTx: sumTx(snapEtm.nodes),
				etmRmse: rmse(snapEtm.nodes),
			});

			baseline.step(logEveryMs);
			etm.step(logEveryMs);
		}
	}

	return rows;
}
