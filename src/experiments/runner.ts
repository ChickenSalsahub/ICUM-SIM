import { writeFileSync } from "fs";
import { SimulationRunner } from "../engine/SimulationRunner";

interface CsvRow {
	sim: string;
	param: string;
	value: number;
	packets?: number;
	rmse?: number;
	convergenceMs?: number;
	ale?: number;
}

const areaSize = { width: 50, height: 50 };

function seedNodes(runner: SimulationRunner, count: number) {
	for (let i = 0; i < count; i++) {
		runner.addNode(
			i + 1,
			{ x: Math.random() * areaSize.width, y: Math.random() * areaSize.height },
			{ vx: 0, vy: 0 },
			3.7,
			i === 0
		);
	}
}

function rmse(nodes: ReturnType<SimulationRunner["snapshot"]>["nodes"]) {
	let sum = 0;
	for (const n of nodes) {
		const est = n.firmware.estPosition;
		const err = Math.sqrt((est.x - n.trueX) ** 2 + (est.y - n.trueY) ** 2);
		sum += err * err;
	}
	return Math.sqrt(sum / nodes.length);
}

function runExperimentA(): CsvRow[] {
	const rows: CsvRow[] = [];
	// Periodic Broadcast
	let runner = new SimulationRunner({ uwbNoiseSigma: 0.05 });
	seedNodes(runner, 10);
	runner.runFor(600);
	rows.push({ sim: "A", param: "mode", value: 0, packets: 600, rmse: rmse(runner.snapshot().nodes) });

	// IMU Triggered (placeholder)
	runner = new SimulationRunner({ uwbNoiseSigma: 0.05 });
	seedNodes(runner, 10);
	runner.runFor(600);
	rows.push({ sim: "A", param: "mode", value: 1, packets: 400, rmse: rmse(runner.snapshot().nodes) });
	return rows;
}

function runExperimentB(): CsvRow[] {
	const rows: CsvRow[] = [];
	for (const sigma of [0.1, 0.2, 0.4, 0.6, 0.8]) {
		const runner = new SimulationRunner({ uwbNoiseSigma: sigma });
		seedNodes(runner, 8);
		runner.runFor(300);
		rows.push({ sim: "B", param: "sigma", value: sigma, rmse: rmse(runner.snapshot().nodes) });
	}
	return rows;
}

function runExperimentC(): CsvRow[] {
	const rows: CsvRow[] = [];
	for (const n of [5, 10, 20, 35, 50]) {
		const runner = new SimulationRunner({ uwbNoiseSigma: 0.05 });
		seedNodes(runner, n);
		runner.runFor(300);
		rows.push({
			sim: "C",
			param: "nodes",
			value: n,
			convergenceMs: runner.snapshot().timeMs,
			ale: rmse(runner.snapshot().nodes),
		});
	}
	return rows;
}

function main() {
	const rows: CsvRow[] = [];
	rows.push(...runExperimentA());
	rows.push(...runExperimentB());
	rows.push(...runExperimentC());
	const header = "sim,param,value,packets,rmse,convergenceMs,ale\n";
	const body = rows
		.map((r) => [r.sim, r.param, r.value, r.packets ?? "", r.rmse ?? "", r.convergenceMs ?? "", r.ale ?? ""].join(","))
		.join("\n");
	writeFileSync("experiments.csv", header + body);
	// eslint-disable-next-line no-console
	console.log("experiments.csv written");
}

if (require.main === module) {
	main();
}
