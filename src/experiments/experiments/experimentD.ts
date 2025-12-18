import { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { CloudBackend } from "../../logic/CloudBackend.ts";
import { CloudPublishTracker } from "../../logic/cloudPublishPolicy.ts";
import { createMulberry32 } from "../../logic/math/Random.ts";
import { applyMotionScenario } from "../lib/motion.ts";
import { cloudRmse, latestByNode } from "../lib/cloudMetrics.ts";
import { EXPERIMENT_WORLD_BOUNDS_M, type MotionScenarioName } from "../lib/types.ts";
import { getCliSeed, makeSeed, seededRng, seedNodes } from "../lib/seed.ts";

export interface ExperimentDTimeRow {
	timeSeconds: number;
	nodes: number;
	cloudBaselineRmse: number;
	cloudRobustRmse: number;
	coverageBaseline: number;
	coverageRobust: number;
}

export interface ExperimentDScenarioTimeRow extends ExperimentDTimeRow {
	scenario: MotionScenarioName;
}

/**
 * Experiment D
 *
 * Goal
 * - Compare cloud-side fusion accuracy between:
 *   - baseline least squares
 *   - robust fusion (Huber loss, outlier resistance)
 *
 * How it's run
 * - Run a local simulation
 * - Periodically publish node neighbor observations to the cloud
 * - Measure cloud position RMSE vs truth over time
 */
export function runExperimentDScenarios(): ExperimentDScenarioTimeRow[] {
	const rows: ExperimentDScenarioTimeRow[] = [];
	const simSeconds = 300;
	const logEveryMs = 1_000;
	const nodeCount = 12;
	const baseSeed = getCliSeed(1);
	const scenarios: MotionScenarioName[] = ["none_moving", "few_moving", "many_moving"];
	const layout = makeSeed(nodeCount, seededRng(baseSeed + 401));

	for (const scenario of scenarios) {
		const scenarioOffset = scenario === "none_moving" ? 0 : scenario === "few_moving" ? 10_000 : 20_000;
		const runner = new SimulationRunner({
			uwbNoiseSigma: 0.05,
			worldBounds: EXPERIMENT_WORLD_BOUNDS_M,
			seed: baseSeed + 400 + scenarioOffset,
		});
		seedNodes(runner, layout);

		// Deterministic RNG per cloud backend so results are stable.
		const cloudBaseline = new CloudBackend({
			robustFusion: false,
			rng: createMulberry32(baseSeed + 500 + scenarioOffset),
		});
		const cloudRobust = new CloudBackend({
			robustFusion: true,
			rng: createMulberry32(baseSeed + 501 + scenarioOffset),
		});
		const publish = new CloudPublishTracker({ staleMs: 30_000 });

		for (let t = 0; t <= simSeconds * 1000; t += logEveryMs) {
			applyMotionScenario(runner, scenario, t);
			const snap = runner.snapshot();
			const nowMs = t;

			// Ground truth for error computation.
			const truth = new Map<number, { x: number; y: number }>();

			for (const sn of snap.nodes) {
				truth.set(sn.id, { x: sn.trueX, y: sn.trueY });

				// What the node would report to the cloud.
				const neighbors = sn.firmware.neighbors.map((nb) => ({
					id: nb.id,
					range: nb.rangeMeters,
					aoa: nb.angleRad,
				}));
				const report = {
					nodeId: sn.id,
					timestamp: nowMs,
					battery: 100,
					status: sn.firmware.state === "ISOLATED" ? "STATIONARY" : (sn.firmware.state as "MOVING" | "STATIONARY"),
					neighbors,
				};

				const shouldPublish = publish.shouldPublish({
					nodeId: sn.id,
					nowMs,
					isAnchor: false,
					isMoving: sn.firmware.state === "MOVING",
					neighborIds: sn.firmware.neighbors.map((nb) => nb.id),
				});
				if (shouldPublish) {
					cloudBaseline.ingest(report);
					cloudRobust.ingest(report);
				}
			}

			cloudBaseline.tick(nowMs);
			cloudRobust.tick(nowMs);

			const baselineLatest = latestByNode(cloudBaseline.getRecords());
			const robustLatest = latestByNode(cloudRobust.getRecords());
			const baselineStats = cloudRmse(baselineLatest, truth);
			const robustStats = cloudRmse(robustLatest, truth);

			rows.push({
				scenario,
				timeSeconds: t / 1000,
				nodes: nodeCount,
				cloudBaselineRmse: baselineStats.rmse,
				cloudRobustRmse: robustStats.rmse,
				coverageBaseline: baselineStats.coverage,
				coverageRobust: robustStats.coverage,
			});

			runner.step(logEveryMs);
		}
	}

	return rows;
}
