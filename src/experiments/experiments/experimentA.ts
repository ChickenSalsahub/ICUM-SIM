import { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { applyMotionScenario } from "../lib/motion.ts";
import {
	aleAlignedRigid,
	mae,
	measurementAngleResidualMae,
	measurementRangeResidualMae,
	pairwiseDistanceMae,
	rmse,
	rmseAlignedRigid,
	sumTx,
} from "../lib/metrics.ts";
import { EXPERIMENT_WORLD_BOUNDS_M, type MotionScenarioName } from "../lib/types.ts";
import { getCliSeed, makeSeed, seededRng, seedNodes } from "../lib/seed.ts";

export interface ExperimentATimeRow {
	timeSeconds: number;
	baselineTx: number;
	baselineRmse: number;
	baselineMae: number;
	baselineRmseAligned: number;
	baselineMaeAligned: number;
	baselinePairwiseDistMae: number;
	baselineRangeResidualMae: number;
	baselineAngleResidualMae: number;
	etmTx: number;
	etmRmse: number;
	etmMae: number;
	etmRmseAligned: number;
	etmMaeAligned: number;
	etmPairwiseDistMae: number;
	etmRangeResidualMae: number;
	etmAngleResidualMae: number;
}

export interface ExperimentAScenarioTimeRow extends ExperimentATimeRow {
	scenario: MotionScenarioName;
}

export interface ExperimentAOptions {
	/** UWB range noise sigma (meters). */
	uwbNoiseSigma: number;
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
	return runExperimentAScenariosWithOptions({ uwbNoiseSigma: 0.05 });
}

export function runExperimentAScenariosWithOptions(options: ExperimentAOptions): ExperimentAScenarioTimeRow[] {
	const perfectChannel = options.uwbNoiseSigma === 0;
	const packetLoss = perfectChannel ? 0 : 0.1;
	const uwbAngleNoiseStdRad = perfectChannel ? 0 : 0.05;

	const baseSeed = getCliSeed(1);
	const layout = makeSeed(10, seededRng(baseSeed + 100));
	const scenarios: MotionScenarioName[] = ["none_moving", "few_moving", "many_moving"];
	const rows: ExperimentAScenarioTimeRow[] = [];

	for (const scenario of scenarios) {
		// Separate seeds per scenario so stochastic effects don't correlate across scenarios.
		const scenarioOffset = scenario === "none_moving" ? 0 : scenario === "few_moving" ? 10_000 : 20_000;

		// Baseline: periodic HELLO/RANGING regardless of motion state.
		const baseline = new SimulationRunner({
			uwbNoiseSigma: options.uwbNoiseSigma,
			uwbAngleNoiseStdRad,
			packetLoss,
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
			uwbNoiseSigma: options.uwbNoiseSigma,
			uwbAngleNoiseStdRad,
			packetLoss,
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
				baselineMae: mae(snapBaseline.nodes),
				baselineRmseAligned: rmseAlignedRigid(snapBaseline.nodes),
				baselineMaeAligned: aleAlignedRigid(snapBaseline.nodes),
				baselinePairwiseDistMae: pairwiseDistanceMae(snapBaseline.nodes),
				baselineRangeResidualMae: measurementRangeResidualMae(snapBaseline.nodes),
				baselineAngleResidualMae: measurementAngleResidualMae(snapBaseline.nodes),
				etmTx: sumTx(snapEtm.nodes),
				etmRmse: rmse(snapEtm.nodes),
				etmMae: mae(snapEtm.nodes),
				etmRmseAligned: rmseAlignedRigid(snapEtm.nodes),
				etmMaeAligned: aleAlignedRigid(snapEtm.nodes),
				etmPairwiseDistMae: pairwiseDistanceMae(snapEtm.nodes),
				etmRangeResidualMae: measurementRangeResidualMae(snapEtm.nodes),
				etmAngleResidualMae: measurementAngleResidualMae(snapEtm.nodes),
			});

			baseline.step(logEveryMs);
			etm.step(logEveryMs);
		}
	}

	return rows;
}
