import fs from "node:fs";
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

function scenarioToFilenameToken(scenario: string): string {
	// e.g. "none_moving" -> "nonemoving" (matches paper/report-friendly filenames)
	return scenario.replaceAll("_", "");
}

function policyToFilenameToken(policy: string): string {
	// Keep policy tokens stable and filesystem-friendly.
	return policy
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "");
}

function groupBy<T>(items: T[], keyFn: (t: T) => string): Map<string, T[]> {
	const m = new Map<string, T[]>();
	for (const item of items) {
		const k = keyFn(item);
		const arr = m.get(k);
		if (arr) arr.push(item);
		else m.set(k, [item]);
	}
	return m;
}

function cleanupLegacyOutputs(repoRoot: string) {
	for (const entry of fs.readdirSync(repoRoot)) {
		if (/^experiments_A_noise\d+\.\d{2}\.csv$/.test(entry)) {
			fs.rmSync(entry);
		}
	}

	for (const filename of ["experiments_C.csv", "experiments_D.csv", "experiments_E.csv"]) {
		if (fs.existsSync(filename)) fs.rmSync(filename);
	}
}

function txPerNodePerMin(totalTx: number, nodeCount: number, timeSeconds: number): string {
	if (!Number.isFinite(totalTx) || !Number.isFinite(nodeCount) || !Number.isFinite(timeSeconds)) return "";
	if (nodeCount <= 0) return "";
	if (timeSeconds <= 0) return "";
	return String(totalTx / nodeCount / (timeSeconds / 60));
}

export function main() {
	cleanupLegacyOutputs(process.cwd());

	console.log(
		`World bounds enabled: x=[${EXPERIMENT_WORLD_BOUNDS_M.minX}, ${EXPERIMENT_WORLD_BOUNDS_M.maxX}] y=[${EXPERIMENT_WORLD_BOUNDS_M.minY}, ${EXPERIMENT_WORLD_BOUNDS_M.maxY}]`
	);

	// Experiment A: compare baseline periodic vs ETM across a few noise levels.
	const noiseSigmasA = [0, 0.05, 0.2];
	for (const uwbNoiseSigma of noiseSigmasA) {
		const rows = runExperimentAScenariosWithOptions({ uwbNoiseSigma });
		const byScenario = groupBy(rows, (r) => r.scenario);
		for (const [scenario, scenarioRows] of byScenario.entries()) {
			const filename = `experiments_A_${scenarioToFilenameToken(scenario)}_noise${fmtNoiseForFilename(
				uwbNoiseSigma
			)}.csv`;
			writeCsv(
				filename,
				"Scenario,Time,Baseline_Tx,Baseline_TxPerNodePerMin,Baseline_RMSE,ETM_Tx,ETM_TxPerNodePerMin,ETM_RMSE,Baseline_MAE,Baseline_RMSE_Aligned,Baseline_MAE_Aligned,Baseline_PairwiseDist_MAE,ETM_MAE,ETM_RMSE_Aligned,ETM_MAE_Aligned,ETM_PairwiseDist_MAE\n",
				scenarioRows.map((r) =>
					[
						r.scenario,
						r.timeSeconds,
						r.baselineTx,
						txPerNodePerMin(r.baselineTx, 10, r.timeSeconds),
						r.baselineRmse,
						r.etmTx,
						txPerNodePerMin(r.etmTx, 10, r.timeSeconds),
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
	}

	const headerB = "NodeCount,Noise,RMSE,MAE,RMSE_Aligned,MAE_Aligned,PairwiseDist_MAE\n";
	writeCsv(
		"experiments_B.csv",
		headerB,
		runExperimentB().map((r) =>
			[r.nodeCount, r.noiseSigma, r.rmse, r.mae, r.rmseAligned, r.maeAligned, r.pairwiseDistMae].join(",")
		)
	);

	{
		const rows = runExperimentCScenarios();
		const byScenario = groupBy(rows, (r) => r.scenario);
		for (const [scenario, scenarioRows] of byScenario.entries()) {
			writeCsv(
				`experiments_C_${scenarioToFilenameToken(scenario)}.csv`,
				"Scenario,Time,Nodes,TxPerNodePerMin,ALE,ConvergenceMs\n",
				scenarioRows.map((r) =>
					[r.scenario, r.timeSeconds, r.nodes, r.txPerNodePerMin, r.ale, r.convergenceMs ?? ""].join(",")
				)
			);
		}
	}

	{
		const rows = runExperimentDScenarios();
		const byScenario = groupBy(rows, (r) => r.scenario);
		for (const [scenario, scenarioRows] of byScenario.entries()) {
			writeCsv(
				`experiments_D_${scenarioToFilenameToken(scenario)}.csv`,
				"Scenario,Time,Nodes,CloudBaseline_RMSE,CloudRobust_RMSE,CoverageBaseline,CoverageRobust\n",
				scenarioRows.map((r) =>
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
		}
	}

	{
		const rows = runExperimentE();
		const headerE = "Scenario,Policy,Seed,Time,TxTotal,TxPerNodePerMin,RMSE\n";
		const byScenario = groupBy(rows, (r) => r.scenario);
		for (const [scenario, scenarioRows] of byScenario.entries()) {
			const byPolicy = groupBy(scenarioRows, (r) => r.policy);
			for (const [policy, policyRows] of byPolicy.entries()) {
				writeCsv(
					`experiments_E_${scenarioToFilenameToken(scenario)}_${policyToFilenameToken(policy)}.csv`,
					headerE,
					policyRows.map((r) =>
						[
							r.scenario,
							r.policy,
							r.seed,
							r.timeSeconds,
							r.txTotal,
							txPerNodePerMin(r.txTotal, 10, r.timeSeconds),
							r.rmse,
						].join(",")
					)
				);
			}
		}
	}
}
const isMain = () => import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain()) {
	main();
}
