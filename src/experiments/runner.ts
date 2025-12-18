import { pathToFileURL } from "url";
import { EXPERIMENT_WORLD_BOUNDS_M } from "./lib/types.ts";
import { writeCsv } from "./lib/csv.ts";
import { runExperimentAScenariosWithOptions } from "./experiments/experimentA.ts";
import { runExperimentB } from "./experiments/experimentB.ts";
import { runExperimentCScenarios } from "./experiments/experimentC.ts";
import { runExperimentDScenarios } from "./experiments/experimentD.ts";
import { runExperimentE } from "./experiments/experimentE.ts";

function fmtNoiseForFilename(noiseSigma: number): string {
	// Keep filenames stable and easy to sort.
	return noiseSigma.toFixed(2);
}

export function main() {
	console.log(
		`World bounds enabled: x=[${EXPERIMENT_WORLD_BOUNDS_M.minX}, ${EXPERIMENT_WORLD_BOUNDS_M.maxX}] y=[${EXPERIMENT_WORLD_BOUNDS_M.minY}, ${EXPERIMENT_WORLD_BOUNDS_M.maxY}]`
	);

	// Experiment A: compare baseline periodic vs ETM across a few noise levels.
	const noiseSigmasA = [0, 0.05, 0.2];
	for (const uwbNoiseSigma of noiseSigmasA) {
		const filename = `experiments_A_noise${fmtNoiseForFilename(uwbNoiseSigma)}.csv`;
		writeCsv(
			filename,
			"Scenario,Time,Baseline_Tx,Baseline_RMSE,ETM_Tx,ETM_RMSE,Baseline_MAE,Baseline_RMSE_Aligned,Baseline_MAE_Aligned,Baseline_PairwiseDist_MAE,ETM_MAE,ETM_RMSE_Aligned,ETM_MAE_Aligned,ETM_PairwiseDist_MAE\n",
			runExperimentAScenariosWithOptions({ uwbNoiseSigma }).map((r) =>
				[
					r.scenario,
					r.timeSeconds,
					r.baselineTx,
					r.baselineRmse,
					r.etmTx,
					r.etmRmse,
					r.baselineMae,
					r.baselineRmseAligned,
					r.baselineMaeAligned,
					r.baselinePairwiseDistMae,
					r.etmMae,
					r.etmRmseAligned,
					r.etmMaeAligned,
					r.etmPairwiseDistMae,
				].join(",")
			)
		);
	}

	const headerB = "NodeCount,Noise,RMSE,MAE,RMSE_Aligned,MAE_Aligned,PairwiseDist_MAE\n";
	writeCsv(
		"experiments_B.csv",
		headerB,
		runExperimentB().map((r) =>
			[r.nodeCount, r.noiseSigma, r.rmse, r.mae, r.rmseAligned, r.maeAligned, r.pairwiseDistMae].join(",")
		)
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
