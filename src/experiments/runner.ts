import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "url";
import { EXPERIMENT_WORLD_BOUNDS_M } from "./lib/types.ts";
import { runExperimentAScenariosWithOptions } from "./experiments/experimentA.ts";
import { runExperimentB, runExperimentBRaw, runExperimentBSummary } from "./experiments/experimentB.ts";
import { runExperimentCScenarios } from "./experiments/experimentC.ts";
import { runExperimentKalman } from "./experiments/experimentKalman.ts";
import { runExperimentKalmanAdaptive } from "./experiments/experimentKalmanAdaptive.ts";
// import { runExperimentDScenarios } from "./experiments/experimentD.ts";
// import { runExperimentE } from "./experiments/experimentE.ts";

function writePublicCsv(filename: string, header: string, rows: string[]) {
	const outDir = path.join(process.cwd(), "public", "data");
	if (!fs.existsSync(outDir)) {
		fs.mkdirSync(outDir, { recursive: true });
	}
	const fullPath = path.join(outDir, filename);
	fs.writeFileSync(fullPath, header + rows.join("\n"));
	console.log(`${filename} written to public/data/`);
}

function cleanupLegacyOutputs() {
	const outDir = path.join(process.cwd(), "public", "data");
	if (fs.existsSync(outDir)) {
		for (const entry of fs.readdirSync(outDir)) {
			if (/^experiments_.*\.csv$/.test(entry)) {
				fs.rmSync(path.join(outDir, entry));
			}
		}
	}
}

function txPerNodePerMin(totalTx: number, nodeCount: number, timeSeconds: number): string {
	if (!Number.isFinite(totalTx) || !Number.isFinite(nodeCount) || !Number.isFinite(timeSeconds)) return "";
	if (nodeCount <= 0) return "";
	if (timeSeconds <= 0) return "";
	return String(totalTx / nodeCount / (timeSeconds / 60));
}

export function main() {
	cleanupLegacyOutputs();



	console.log("Starting Experiment Kalman...");
	{
		const R = 25;
		const Q = 1;
		const std = 10;
		const n = 5;
		const rows = runExperimentKalman(R, Q, std, n);
		writePublicCsv(
			`experiments_kalman.csv`,
			"time_s,rmse_gps_m,rmse_ekf_m,rmse_ekf_tuned_m,r_untuned,q_untuned,r_tuned,q_tuned,std,n\n",
			rows.map((r) => [r.timeSeconds, r.rmseGps, r.rmseEkf, r.rmseEkfTuned, R, Q, std*std, 0.01, std, n].join(","))
		);
	}

	console.log("Starting Experiment Kalman Adaptive...");
	{
		const R = 25;
		const Q = 1;
		const std = 10;
		const n = 5;
		const rows = runExperimentKalmanAdaptive(R, Q, std, n);
		writePublicCsv(
			`experiments_kalman_adaptive.csv`,
			"time_s,rmse_gps_m,rmse_kalman_m,rmse_adaptive_m,r_fixed,q_fixed,r_adaptive_init,q_adaptive_init,std,n\n",
			rows.map((r) => [r.timeSeconds, r.rmseGps, r.rmseKalman, r.rmseAdaptive, std*std, 0.01, R, Q, std, n].join(","))
		);
	}
}
const isMain = () => import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain()) {
	main();
}
