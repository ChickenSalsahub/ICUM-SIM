import { writeFileSync } from "fs";
import { pathToFileURL } from "url";
import { SimulationRunner } from "../engine/SimulationRunner.ts";

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
	tx: number;
	rmse: number;
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
	const simSeconds = 10_000;
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
		for (let t = 0; t <= simSeconds * 1000; t += logEveryMs) {
			const snap = runner.snapshot();
			rows.push({
				timeSeconds: t / 1000,
				nodes: nodeCount,
				tx: snap.nodes.reduce((sum, node) => sum + node.txCount, 0),
				rmse: rmse(snap.nodes),
			});
			runner.step(logEveryMs);
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
		runExperimentC().map((r) => [r.timeSeconds, r.nodes, r.tx, r.rmse].join(","))
	);
}
const isMain = () => import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain()) {
	main();
}
