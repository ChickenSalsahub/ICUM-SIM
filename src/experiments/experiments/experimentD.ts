import { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { CloudBackend } from "../../logic/CloudBackend.ts";
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
		const uwbNoiseSigma: number = 0.05;
		const perfectChannel = uwbNoiseSigma === 0;
		const runner = new SimulationRunner({
			uwbNoiseSigma,
			uwbAngleNoiseStdRad: perfectChannel ? 0 : 0.05,
			packetLoss: perfectChannel ? 0 : 0.1,
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

		runner.setHooks({
			onTx: ({ timeMs, senderId, packet, senderPos }) => {
				if (packet.type !== "UPLINK") return;
				if (!packet.payload || typeof packet.payload !== "object") return;
				if ((packet.payload as { type?: unknown }).type !== "UPLINK_BATCH") return;

				const rawEvents = (packet.payload as { events?: unknown }).events;
				if (Array.isArray(rawEvents)) {
					for (const raw of rawEvents) {
						if (!raw || typeof raw !== "object") continue;
						const e = raw as any;
						const timestamp = Number(e.timestamp);
						if (!Number.isFinite(timestamp)) continue;
						const kind = typeof e.kind === "string" ? e.kind : "EVENT";
						const level = e.level === "WARN" || e.level === "ERROR" ? e.level : "INFO";
						const nodeId = Number(e.nodeId);
						cloudBaseline.recordEvent({
							timestamp,
							level,
							kind,
							nodeId: Number.isFinite(nodeId) ? nodeId : undefined,
							message: typeof e.message === "string" ? e.message : String(e.message ?? kind),
						});
						cloudRobust.recordEvent({
							timestamp,
							level,
							kind,
							nodeId: Number.isFinite(nodeId) ? nodeId : undefined,
							message: typeof e.message === "string" ? e.message : String(e.message ?? kind),
						});
					}
				}

				const reports = (packet.payload as { reports?: unknown }).reports;
				if (!Array.isArray(reports) || reports.length === 0) return;

				for (const raw of reports) {
					if (!raw || typeof raw !== "object") continue;
					const r = raw as any;
					const nodeId = Number(r.nodeId);
					if (!Number.isFinite(nodeId)) continue;

					const neighborsRaw = r.neighbors;
					const neighbors = Array.isArray(neighborsRaw)
						? neighborsRaw
								.map((n: any) => ({
									id: Number(n?.id),
									range: Number(n?.range),
									aoa: n?.aoa,
								}))
								.filter((n: any) => Number.isFinite(n.id) && Number.isFinite(n.range))
						: [];

					const report: any = {
						nodeId,
						timestamp: timeMs,
						battery: Number(r.batteryV ?? 0),
						status: r.status === "MOVING" ? "MOVING" : "STATIONARY",
						neighbors,
					};

					// Anchor the cloud graph to world coords using the LTE-capable uplink sender.
					if (Boolean(r.lteCapable) && nodeId === senderId) {
						report.x = senderPos.x;
						report.y = senderPos.y;
					}

					cloudBaseline.ingest(report);
					cloudRobust.ingest(report);
				}
			},
		});

		for (let t = 0; t <= simSeconds * 1000; t += logEveryMs) {
			applyMotionScenario(runner, scenario, t);
			const snap = runner.snapshot();
			const nowMs = t;

			// Ground truth for error computation.
			const truth = new Map<number, { x: number; y: number }>();

			for (const sn of snap.nodes) {
				truth.set(sn.id, { x: sn.trueX, y: sn.trueY });
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
