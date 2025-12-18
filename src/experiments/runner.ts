import { writeFileSync } from "fs";
import { pathToFileURL } from "url";
import { SimulationRunner } from "../engine/SimulationRunner.ts";
import { CloudBackend, type FusedRecord } from "../logic/CloudBackend.ts";
import { CloudPublishTracker } from "../logic/cloudPublishPolicy.ts";
import { createMulberry32, type RngFn } from "../logic/math/Random.ts";

interface ExperimentATimeRow {
	timeSeconds: number;
	baselineTx: number;
	baselineRmse: number;
	etmTx: number;
	etmRmse: number;
}

interface ExperimentAScenarioTimeRow extends ExperimentATimeRow {
	scenario: MotionScenarioName;
}

interface ExperimentBRow {
	nodeCount: number;
	noiseSigma: number;
	rmse: number;
	mae: number;
}

interface ExperimentCTimeRow {
	timeSeconds: number;
	nodes: number;
	txPerNodePerMin: number;
	ale: number;
	convergenceMs?: number;
}

interface ExperimentCScenarioTimeRow extends ExperimentCTimeRow {
	scenario: MotionScenarioName;
}

interface ExperimentDTimeRow {
	timeSeconds: number;
	nodes: number;
	cloudBaselineRmse: number;
	cloudRobustRmse: number;
	coverageBaseline: number;
	coverageRobust: number;
}

interface ExperimentDScenarioTimeRow extends ExperimentDTimeRow {
	scenario: MotionScenarioName;
}

interface ExperimentETimeRow {
	scenario: string;
	policy: "baseline" | "icum";
	seed: number;
	timeSeconds: number;
	txTotal: number;
	rmse: number;
}

type MotionScenarioName = "none_moving" | "few_moving" | "many_moving";

const MOTION_START_MS = 120_000;
const MOTION_STOP_MS = 180_000;

function applyMotionScenario(runner: SimulationRunner, scenario: MotionScenarioName, tMs: number) {
	if (scenario === "none_moving") return;
	if (tMs !== MOTION_START_MS && tMs !== MOTION_STOP_MS) return;

	const moving = tMs === MOTION_START_MS;
	const nodeIds = new Set(runner.getNodeIds());
	const setVel = (id: number, v: { vx: number; vy: number }) => {
		if (!nodeIds.has(id)) return;
		runner.setNodeVelocity(id, v);
	};

	// Velocity palette (m/s). These are comfortably above the 0.05 m/s
	// movement-detection threshold in SimulationRunner's synthetic IMU.
	const palette: Array<{ id: number; v: { vx: number; vy: number } }> = [
		{ id: 2, v: { vx: 0.5, vy: 0.0 } },
		{ id: 3, v: { vx: 0.0, vy: 0.5 } },
		{ id: 4, v: { vx: -0.35, vy: 0.35 } },
		{ id: 5, v: { vx: 0.25, vy: -0.4 } },
		{ id: 6, v: { vx: -0.45, vy: 0.1 } },
		{ id: 7, v: { vx: 0.15, vy: 0.45 } },
		{ id: 8, v: { vx: -0.2, vy: -0.35 } },
	];

	const subset = scenario === "few_moving" ? palette.slice(0, 3) : palette; // 2-4 vs 2-8
	for (const { id, v } of subset) {
		setVel(id, moving ? v : { vx: 0, vy: 0 });
	}
}

const areaSize = { width: 50, height: 50 };
const worldBounds = { minX: 0, maxX: areaSize.width, minY: 0, maxY: areaSize.height };

type SeededNode = { id: number; x: number; y: number };

function seedNodes(runner: SimulationRunner, nodes: SeededNode[]) {
	for (const node of nodes) {
		runner.addNode(node.id, { x: node.x, y: node.y }, { vx: 0, vy: 0 }, 3.7, node.id === 1);
	}
}

function makeSeed(count: number, rng: RngFn): SeededNode[] {
	return Array.from({ length: count }).map((_, idx) => ({
		id: idx + 1,
		x: rng() * areaSize.width,
		y: rng() * areaSize.height,
	}));
}

function rmse(nodes: ReturnType<SimulationRunner["snapshot"]>["nodes"]) {
	let sum = 0;
	for (const node of nodes) {
		const est = node.firmware.estPosition;
		const err = Math.sqrt((est.x - node.trueX) ** 2 + (est.y - node.trueY) ** 2);
		sum += err * err;
	}
	return Math.sqrt(sum / nodes.length);
}

function mae(nodes: ReturnType<SimulationRunner["snapshot"]>["nodes"]) {
	let sum = 0;
	for (const node of nodes) {
		const est = node.firmware.estPosition;
		const err = Math.sqrt((est.x - node.trueX) ** 2 + (est.y - node.trueY) ** 2);
		sum += err;
	}
	return sum / nodes.length;
}

function ale(nodes: ReturnType<SimulationRunner["snapshot"]>["nodes"]) {
	let sum = 0;
	for (const node of nodes) {
		const est = node.firmware.estPosition;
		const err = Math.sqrt((est.x - node.trueX) ** 2 + (est.y - node.trueY) ** 2);
		sum += err;
	}
	return sum / nodes.length;
}

function latestByNode(records: FusedRecord[]) {
	const map = new Map<number, FusedRecord>();
	for (const r of records) {
		const prev = map.get(r.nodeId);
		if (!prev || r.timestamp >= prev.timestamp) map.set(r.nodeId, r);
	}
	return map;
}

function getCliSeed(defaultSeed: number) {
	const argv = process.argv.slice(2);
	const eq = argv.find((a) => a.startsWith("--seed="));
	if (eq) {
		const v = Number(eq.split("=")[1]);
		return Number.isFinite(v) ? v : defaultSeed;
	}
	const idx = argv.indexOf("--seed");
	if (idx >= 0 && idx + 1 < argv.length) {
		const v = Number(argv[idx + 1]);
		return Number.isFinite(v) ? v : defaultSeed;
	}
	const env = process.env.EXPERIMENT_SEED;
	if (env !== undefined) {
		const v = Number(env);
		return Number.isFinite(v) ? v : defaultSeed;
	}
	return defaultSeed;
}

function sumTx(nodes: ReturnType<SimulationRunner["snapshot"]>["nodes"]) {
	return nodes.reduce((sum, node) => sum + node.txCount, 0);
}

function cloudRmse(latest: Map<number, FusedRecord>, truth: Map<number, { x: number; y: number }>) {
	let sumSq = 0;
	let count = 0;
	for (const [id, t] of truth.entries()) {
		const r = latest.get(id);
		if (!r) continue;
		const dx = r.position.x - t.x;
		const dy = r.position.y - t.y;
		sumSq += dx * dx + dy * dy;
		count += 1;
	}
	return { rmse: count > 0 ? Math.sqrt(sumSq / count) : Number.NaN, coverage: count };
}

// Experiment A: Compare baseline vs ICUM/ETM over time across motion scenarios.

function runExperimentAScenarios(): ExperimentAScenarioTimeRow[] {
	const baseSeed = getCliSeed(1);
	const layout = makeSeed(10, createMulberry32(baseSeed + 100));
	const scenarios: MotionScenarioName[] = ["none_moving", "few_moving", "many_moving"];
	const rows: ExperimentAScenarioTimeRow[] = [];

	for (const scenario of scenarios) {
		const scenarioOffset = scenario === "none_moving" ? 0 : scenario === "few_moving" ? 10_000 : 20_000;
		const baseline = new SimulationRunner({
			uwbNoiseSigma: 0.05,
			worldBounds,
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
		const etm = new SimulationRunner({
			uwbNoiseSigma: 0.05,
			worldBounds,
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

// Experiment B: Vary UWB noise sigma and measure final accuracy
function runExperimentB(): ExperimentBRow[] {
	const rows: ExperimentBRow[] = [];
	const simSeconds = 300;
	const nodeCount = 8;
	const baseSeed = getCliSeed(1);
	const layout = makeSeed(nodeCount, createMulberry32(baseSeed + 200));
	for (const sigma of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
		const runner = new SimulationRunner({
			uwbNoiseSigma: sigma,
			worldBounds,
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
		});
	}
	return rows;
}

// Experiment C: Scalability and convergence across motion scenarios.

function runExperimentCScenarios(): ExperimentCScenarioTimeRow[] {
	const rows: ExperimentCScenarioTimeRow[] = [];
	const simSeconds = 300;
	const logEveryMs = 1_000;
	const baseSeed = getCliSeed(1);
	const scenarios: MotionScenarioName[] = ["none_moving", "few_moving", "many_moving"];

	for (const scenario of scenarios) {
		for (const nodeCount of [5, 10, 20, 35, 50]) {
			const scenarioOffset = scenario === "none_moving" ? 0 : scenario === "few_moving" ? 10_000 : 20_000;
			const layout = makeSeed(nodeCount, createMulberry32(baseSeed + 300 + nodeCount + scenarioOffset));
			const runner = new SimulationRunner({
				uwbNoiseSigma: 0.05,
				worldBounds,
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
				const txPerNodePerMin = totalTx / nodeCount / (snap.timeMs / 60000 || 1);

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

// Experiment D: Compare cloud baseline vs robust fusion over time
// The difference is that robust fusion ignores outlier neighbor reports

// Experiment D: Cloud fusion baseline vs robust across motion scenarios.

function runExperimentDScenarios(): ExperimentDScenarioTimeRow[] {
	const rows: ExperimentDScenarioTimeRow[] = [];
	const simSeconds = 300;
	const logEveryMs = 1_000;
	const nodeCount = 12;
	const baseSeed = getCliSeed(1);
	const scenarios: MotionScenarioName[] = ["none_moving", "few_moving", "many_moving"];
	const layout = makeSeed(nodeCount, createMulberry32(baseSeed + 401));

	for (const scenario of scenarios) {
		const scenarioOffset = scenario === "none_moving" ? 0 : scenario === "few_moving" ? 10_000 : 20_000;
		const runner = new SimulationRunner({ uwbNoiseSigma: 0.05, worldBounds, seed: baseSeed + 400 + scenarioOffset });
		seedNodes(runner, layout);
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
			const truth = new Map<number, { x: number; y: number }>();

			for (const sn of snap.nodes) {
				truth.set(sn.id, { x: sn.trueX, y: sn.trueY });
				const neighbors = sn.firmware.neighbors.map((nb) => ({ id: nb.id, range: nb.rangeMeters, aoa: nb.angleRad }));
				const base = {
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
					cloudBaseline.ingest(base);
					cloudRobust.ingest(base);
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

function runExperimentE(): ExperimentETimeRow[] {
	const baseSeed = getCliSeed(1);
	const simSeconds = 300;
	const dtMs = 250;
	const logEveryMs = 1_000;
	const nodeCount = 10;
	const layout = makeSeed(nodeCount, createMulberry32(baseSeed + 600));

	const makeRunner = (policy: "baseline" | "icum", seed: number) =>
		new SimulationRunner({
			uwbNoiseSigma: 0.05,
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
		});

	const scenarios: Array<{ name: string; apply: (runner: SimulationRunner, tMs: number) => void }> = [
		{
			name: "none_moving",
			apply: () => {
				// no-op
			},
		},
		{
			name: "few_moving",
			apply: (runner, tMs) => {
				if (tMs === 120_000) {
					runner.setNodeVelocity(2, { vx: 0.5, vy: 0 });
					runner.setNodeVelocity(3, { vx: 0.0, vy: 0.5 });
					runner.setNodeVelocity(4, { vx: -0.35, vy: 0.35 });
				}
				if (tMs === 180_000) {
					runner.setNodeVelocity(2, { vx: 0, vy: 0 });
					runner.setNodeVelocity(3, { vx: 0, vy: 0 });
					runner.setNodeVelocity(4, { vx: 0, vy: 0 });
				}
			},
		},
		{
			name: "many_moving",
			apply: (runner, tMs) => {
				if (tMs === 120_000) {
					// Move a larger subset of nodes for a sustained window.
					runner.setNodeVelocity(2, { vx: 0.5, vy: 0.0 });
					runner.setNodeVelocity(3, { vx: 0.0, vy: 0.5 });
					runner.setNodeVelocity(4, { vx: -0.35, vy: 0.35 });
					runner.setNodeVelocity(5, { vx: 0.25, vy: -0.4 });
					runner.setNodeVelocity(6, { vx: -0.45, vy: 0.1 });
					runner.setNodeVelocity(7, { vx: 0.15, vy: 0.45 });
					runner.setNodeVelocity(8, { vx: -0.2, vy: -0.35 });
				}
				if (tMs === 180_000) {
					runner.setNodeVelocity(2, { vx: 0, vy: 0 });
					runner.setNodeVelocity(3, { vx: 0, vy: 0 });
					runner.setNodeVelocity(4, { vx: 0, vy: 0 });
					runner.setNodeVelocity(5, { vx: 0, vy: 0 });
					runner.setNodeVelocity(6, { vx: 0, vy: 0 });
					runner.setNodeVelocity(7, { vx: 0, vy: 0 });
					runner.setNodeVelocity(8, { vx: 0, vy: 0 });
				}
			},
		},
	];

	const rows: ExperimentETimeRow[] = [];

	for (const scenario of scenarios) {
		for (const policy of ["baseline", "icum"] as const) {
			const seed = baseSeed + 700 + scenario.name.length * 31 + (policy === "baseline" ? 1 : 2);
			const runner = makeRunner(policy, seed);
			runner.setWorldBounds(worldBounds);
			seedNodes(runner, layout);

			let nextLog = 0;
			for (let tMs = 0; tMs <= simSeconds * 1000; tMs += dtMs) {
				scenario.apply(runner, tMs);
				if (tMs >= nextLog) {
					const snap = runner.snapshot();
					rows.push({
						scenario: scenario.name,
						policy,
						seed,
						timeSeconds: tMs / 1000,
						txTotal: sumTx(snap.nodes),
						rmse: rmse(snap.nodes),
					});
					nextLog += logEveryMs;
				}
				runner.step(dtMs);
			}
		}
	}

	return rows;
}

export function main() {
	const write = (filename: string, header: string, lines: string[]) => {
		writeFileSync(filename, header + lines.join("\n"));
		// eslint-disable-next-line no-console
		console.log(`${filename} written`);
	};

	// eslint-disable-next-line no-console
	console.log(
		`World bounds enabled: x=[${worldBounds.minX}, ${worldBounds.maxX}] y=[${worldBounds.minY}, ${worldBounds.maxY}]`
	);

	// Option 1: scenario-aware outputs are the defaults.
	write(
		"experiments_A.csv",
		"Scenario,Time,Baseline_Tx,Baseline_RMSE,ETM_Tx,ETM_RMSE\n",
		runExperimentAScenarios().map((r) =>
			[r.scenario, r.timeSeconds, r.baselineTx, r.baselineRmse, r.etmTx, r.etmRmse].join(",")
		)
	);

	const headerB = "NodeCount,Noise,RMSE,MAE\n";
	write(
		"experiments_B.csv",
		headerB,
		runExperimentB().map((r) => [r.nodeCount, r.noiseSigma, r.rmse, r.mae].join(","))
	);

	write(
		"experiments_C.csv",
		"Scenario,Time,Nodes,TxPerNodePerMin,ALE,ConvergenceMs\n",
		runExperimentCScenarios().map((r) =>
			[r.scenario, r.timeSeconds, r.nodes, r.txPerNodePerMin, r.ale, r.convergenceMs ?? ""].join(",")
		)
	);

	write(
		"experiments_D.csv",
		"Scenario,Time,Nodes,CloudBaseline_RMSE,CloudRobust_RMSE,CoverageBaseline,CoverageRobust\n",
		runExperimentDScenarios().map((r) =>
			[
				r.scenario,
				r.timeSeconds,
				r.nodes,
				r.cloudBaselineRmse,
				r.cloudRobustRmse,
				r.coverageBaseline,
				r.coverageRobust,
			].join(",")
		)
	);

	const headerE = "Scenario,Policy,Seed,Time,TxTotal,RMSE\n";
	write(
		"experiments_E.csv",
		headerE,
		runExperimentE().map((r) => [r.scenario, r.policy, r.seed, r.timeSeconds, r.txTotal, r.rmse].join(","))
	);
}
const isMain = () => import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain()) {
	main();
}
