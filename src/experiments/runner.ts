import { pathToFileURL } from "url";
import { EXPERIMENT_WORLD_BOUNDS_M } from "./lib/types.ts";
import { writeCsv } from "./lib/csv.ts";
import { runExperimentAScenarios } from "./experiments/experimentA.ts";
import { runExperimentB } from "./experiments/experimentB.ts";
import { runExperimentCScenarios } from "./experiments/experimentC.ts";
import { runExperimentDScenarios } from "./experiments/experimentD.ts";
import { runExperimentE } from "./experiments/experimentE.ts";

export function main() {
	console.log(
		`World bounds enabled: x=[${EXPERIMENT_WORLD_BOUNDS_M.minX}, ${EXPERIMENT_WORLD_BOUNDS_M.maxX}] y=[${EXPERIMENT_WORLD_BOUNDS_M.minY}, ${EXPERIMENT_WORLD_BOUNDS_M.maxY}]`
	);

	// Option 1: scenario-aware outputs are the defaults.
	writeCsv(
		"experiments_A.csv",
		"Scenario,Time,Baseline_Tx,Baseline_RMSE,ETM_Tx,ETM_RMSE\n",
		runExperimentAScenarios().map((r) =>
			[r.scenario, r.timeSeconds, r.baselineTx, r.baselineRmse, r.etmTx, r.etmRmse].join(",")
		)
	);

	const headerB = "NodeCount,Noise,RMSE,MAE\n";
	writeCsv(
		"experiments_B.csv",
		headerB,
		runExperimentB().map((r) => [r.nodeCount, r.noiseSigma, r.rmse, r.mae].join(","))
	);

	writeCsv(
		"experiments_C.csv",
		"Scenario,Time,Nodes,TxPerNodePerMin,ALE,ConvergenceMs\n",
		runExperimentCScenarios().map((r) =>
			[r.scenario, r.timeSeconds, r.nodes, r.txPerNodePerMin, r.ale, r.convergenceMs ?? ""].join(",")
		)
	);

	writeCsv(
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
	writeCsv(
		"experiments_E.csv",
		headerE,
		runExperimentE().map((r) => [r.scenario, r.policy, r.seed, r.timeSeconds, r.txTotal, r.rmse].join(","))
	);
}
const isMain = () => import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain()) {
	main();
}
