import { writeFileSync } from "fs";
import { pathToFileURL } from "url";
import { SimulationRunner } from "../engine/SimulationRunner.ts";
import { CloudBackend, type FusedRecord } from "../logic/CloudBackend.ts";
import { CloudPublishTracker } from "../logic/cloudPublishPolicy.ts";

interface ExperimentATimeRow {
	timeSeconds: number;
	baselineTx: number;
	baselineRmse: number;
	etmTx: number;
	etmRmse: number;
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

interface ExperimentDTimeRow {
	timeSeconds: number;
	nodes: number;
	cloudBaselineRmse: number;
	cloudRobustRmse: number;
	coverageBaseline: number;
	coverageRobust: number;
}

const areaSize = { width: 50, height: 50 };

type SeededNode = { id: number; x: number; y: number };

function seedNodes(runner: SimulationRunner, nodes: SeededNode[]) {
	for (const node of nodes) {
		runner.addNode(node.id, { x: node.x, y: node.y }, { vx: 0, vy: 0 }, 3.7, node.id === 1);
	}
}

function makeSeed(count: number): SeededNode[] {
	return Array.from({ length: count }).map((_, idx) => ({
		id: idx + 1,
		x: Math.random() * areaSize.width,
		y: Math.random() * areaSize.height,
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
		if (!map.has(r.nodeId)) map.set(r.nodeId, r);
	}
	return map;
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

// Experiment A: Compare baseline vs ETM over time
function runExperimentA(): ExperimentATimeRow[] {
	const seed = makeSeed(10);
	const baseline = new SimulationRunner({ uwbNoiseSigma: 0.05 });
	const etm = new SimulationRunner({ uwbNoiseSigma: 0.05 });
	seedNodes(baseline, seed);
	seedNodes(etm, seed);

	const simSeconds = 600; // 10 minutes
	const logEveryMs = 1_000;
	const rows: ExperimentATimeRow[] = [];

	for (let t = 0; t <= simSeconds * 1000; t += logEveryMs) {
		const snapBaseline = baseline.snapshot();
		const snapEtm = etm.snapshot();
		rows.push({
			timeSeconds: t / 1000,
			baselineTx: snapBaseline.nodes.reduce((sum, node) => sum + node.txCount, 0),
			baselineRmse: rmse(snapBaseline.nodes),
			etmTx: snapEtm.nodes.reduce((sum, node) => sum + node.txCount, 0),
			etmRmse: rmse(snapEtm.nodes),
		});

		baseline.step(logEveryMs);
		etm.step(logEveryMs);
	}

	return rows;
}

// Experiment B: Vary UWB noise sigma and measure final accuracy
function runExperimentB(): ExperimentBRow[] {
	const rows: ExperimentBRow[] = [];
	const simSeconds = 300;
	const nodeCount = 8;
	for (const sigma of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
		const runner = new SimulationRunner({ uwbNoiseSigma: sigma });
		seedNodes(runner, makeSeed(nodeCount));
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

function runExperimentC(): ExperimentCTimeRow[] {
	const rows: ExperimentCTimeRow[] = [];
	const simSeconds = 300;
	const logEveryMs = 1_000;
	for (const nodeCount of [5, 10, 20, 35, 50]) {
		const runner = new SimulationRunner({ uwbNoiseSigma: 0.05 });
		seedNodes(runner, makeSeed(nodeCount));
		let previousAle = Number.POSITIVE_INFINITY;
		let stableSamples = 0;
		let convergenceMs: number | undefined;
		for (let t = 0; t <= simSeconds * 1000; t += logEveryMs) {
			const snap = runner.snapshot();
			const totalTx = snap.nodes.reduce((sum, node) => sum + node.txCount, 0);
			const currentAle = ale(snap.nodes);
			const txPerNodePerMin = totalTx / nodeCount / (snap.timeMs / 60000 || 1); // avoid div by zero at t=0

			if (convergenceMs === undefined) {
				const delta = Math.abs(currentAle - previousAle);
				stableSamples = delta < 0.01 ? stableSamples + 1 : 0;
				if (stableSamples >= 5) {
					convergenceMs = snap.timeMs;
				}
				previousAle = currentAle;
			}

			rows.push({
				timeSeconds: t / 1000,
				nodes: nodeCount,
				txPerNodePerMin,
				ale: currentAle,
				convergenceMs,
			});
			runner.step(logEveryMs);
		}
	}
	return rows;
}

// Experiment D: Compare cloud baseline vs robust fusion over time
// The difference is that robust fusion ignores outlier neighbor reports
function runExperimentD(): ExperimentDTimeRow[] {
	const rows: ExperimentDTimeRow[] = [];
	const simSeconds = 300;
	const logEveryMs = 1_000;
	const nodeCount = 12;

	const runner = new SimulationRunner({ uwbNoiseSigma: 0.05 });
	seedNodes(runner, makeSeed(nodeCount));

	const cloudBaseline = new CloudBackend({ robustFusion: false });
	const cloudRobust = new CloudBackend({ robustFusion: true });
	const publish = new CloudPublishTracker({ staleMs: 30_000 });

	for (let t = 0; t <= simSeconds * 1000; t += logEveryMs) {
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
			timeSeconds: t / 1000,
			nodes: nodeCount,
			cloudBaselineRmse: baselineStats.rmse,
			cloudRobustRmse: robustStats.rmse,
			coverageBaseline: baselineStats.coverage,
			coverageRobust: robustStats.coverage,
		});

		runner.step(logEveryMs);
	}

	return rows;
}

export function main() {
	const write = (filename: string, header: string, lines: string[]) => {
		writeFileSync(filename, header + lines.join("\n"));
		// eslint-disable-next-line no-console
		console.log(`${filename} written`);
	};

	const rowsA = runExperimentA();
	write(
		"experiments_A.csv",
		"Time,Baseline_Tx,Baseline_RMSE,ETM_Tx,ETM_RMSE\n",
		rowsA.map((r) => [r.timeSeconds, r.baselineTx, r.baselineRmse, r.etmTx, r.etmRmse].join(","))
	);

	const headerB = "NodeCount,Noise,RMSE,MAE\n";
	write(
		"experiments_B.csv",
		headerB,
		runExperimentB().map((r) => [r.nodeCount, r.noiseSigma, r.rmse, r.mae].join(","))
	);

	const headerC = "Time,Nodes,Tx,RMSE\n";
	write(
		"experiments_C.csv",
		headerC,
		runExperimentC().map((r) => [r.timeSeconds, r.nodes, r.txPerNodePerMin, r.ale, r.convergenceMs ?? ""].join(","))
	);

	const headerD = "Time,Nodes,CloudBaseline_RMSE,CloudRobust_RMSE,CoverageBaseline,CoverageRobust\n";
	write(
		"experiments_D.csv",
		headerD,
		runExperimentD().map((r) =>
			[r.timeSeconds, r.nodes, r.cloudBaselineRmse, r.cloudRobustRmse, r.coverageBaseline, r.coverageRobust].join(",")
		)
	);
}
const isMain = () => import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain()) {
	main();
}
