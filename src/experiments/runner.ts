import fs from "node:fs";
import { pathToFileURL } from "url";
import { EXPERIMENT_WORLD_BOUNDS_M } from "./lib/types.ts";
import { writeCsv } from "./lib/csv.ts";
import { runExperimentAScenariosWithOptions } from "./experiments/experimentA.ts";
import { runExperimentB, runExperimentBRaw, runExperimentBSummary } from "./experiments/experimentB.ts";
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
	// Keep the repo root clean: we only keep report-friendly "*_clean.csv" outputs.
	for (const entry of fs.readdirSync(repoRoot)) {
		if (!/^experiments_.*\.csv$/.test(entry)) continue;
		if (entry.includes("_clean")) continue;
		fs.rmSync(entry);
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
			// Report-friendly A output: fewer columns + clearer names + units.
			// Note: we prefer anchor-free metrics (rigid-aligned) for multi-agent localization.
			const filenameClean = `experiments_A_${scenarioToFilenameToken(scenario)}_noise${fmtNoiseForFilename(
				uwbNoiseSigma
			)}_clean.csv`;
			writeCsv(
				filenameClean,
				"scenario,time_s,baseline_tx_total,baseline_tx_per_node_per_min,baseline_rmse_aligned_m,baseline_mae_aligned_m,icum_tx_total,icum_tx_per_node_per_min,icum_rmse_aligned_m,icum_mae_aligned_m\n",
				scenarioRows.map((r) =>
					[
						r.scenario,
						r.timeSeconds,
						r.baselineTx,
						txPerNodePerMin(r.baselineTx, 10, r.timeSeconds),
						r.baselineRmseAligned,
						r.baselineMaeAligned,
						r.etmTx,
						txPerNodePerMin(r.etmTx, 10, r.timeSeconds),
						r.etmRmseAligned,
						r.etmMaeAligned,
					].join(",")
				)
			);
		}
	}

	const b = runExperimentB();
	const bRaw = runExperimentBRaw();
	const bSummary = runExperimentBSummary();

	// Experiment B (clean): anchor-free metrics only.
	const headerBClean = "node_count,uwb_sigma_m,rmse_aligned_m,mae_aligned_m,pairwise_dist_mae_m\n";
	writeCsv(
		"experiments_B_clean.csv",
		headerBClean,
		b.map((r) => [r.nodeCount, r.noiseSigma, r.rmseAligned, r.maeAligned, r.pairwiseDistMae].join(","))
	);

	const headerBRawClean = "node_count,uwb_sigma_m,seed,rmse_aligned_m,mae_aligned_m,pairwise_dist_mae_m\n";
	writeCsv(
		"experiments_B_raw_clean.csv",
		headerBRawClean,
		bRaw.map((r) => [r.nodeCount, r.noiseSigma, r.seed, r.rmseAligned, r.maeAligned, r.pairwiseDistMae].join(","))
	);

	// Cleaner summary: median + IQR only for the anchor-free metrics most used in the report.
	const headerBSummaryClean =
		"node_count,uwb_sigma_m,n_seeds,rmse_aligned_median_m,rmse_aligned_p25_m,rmse_aligned_p75_m,mae_aligned_median_m,mae_aligned_p25_m,mae_aligned_p75_m,pairwise_dist_mae_median_m,pairwise_dist_mae_p25_m,pairwise_dist_mae_p75_m\n";
	writeCsv(
		"experiments_B_summary_clean.csv",
		headerBSummaryClean,
		bSummary.map((r) =>
			[
				r.nodeCount,
				r.noiseSigma,
				r.n,
				r.rmseAligned_median,
				r.rmseAligned_p25,
				r.rmseAligned_p75,
				r.maeAligned_median,
				r.maeAligned_p25,
				r.maeAligned_p75,
				r.pairwiseDistMae_median,
				r.pairwiseDistMae_p25,
				r.pairwiseDistMae_p75,
			].join(",")
		)
	);

	{
		const rows = runExperimentCScenarios();
		const byScenario = groupBy(rows, (r) => r.scenario);
		for (const [scenario, scenarioRows] of byScenario.entries()) {
			// Report-friendly C output: clearer names + units.
			writeCsv(
				`experiments_C_${scenarioToFilenameToken(scenario)}_clean.csv`,
				"scenario,time_s,node_count,tx_per_node_per_min,ale_aligned_m,convergence_stable_ms,t_eps_ms\n",
				scenarioRows.map((r) =>
					[r.scenario, r.timeSeconds, r.nodes, r.txPerNodePerMin, r.ale, r.convergenceMs ?? "", r.tEpsMs ?? ""].join(
						","
					)
				)
			);
		}
	}

	{
		const rows = runExperimentDScenarios();
		const byScenario = groupBy(rows, (r) => r.scenario);
		for (const [scenario, scenarioRows] of byScenario.entries()) {
			// Report-friendly D output: clearer names + units.
			writeCsv(
				`experiments_D_${scenarioToFilenameToken(scenario)}_clean.csv`,
				"scenario,time_s,node_count,cloud_rmse_m,cloud_coverage_nodes\n",
				scenarioRows.map((r) =>
					[
						r.scenario,
						r.timeSeconds,
						r.nodes,
						r.cloudRmse,
						r.cloudCoverage,
					].join(",")
				)
			);
		}
	}

	{
		const rows = runExperimentE();
		const byScenario = groupBy(rows, (r) => r.scenario);
		for (const [scenario, scenarioRows] of byScenario.entries()) {
			const byPolicy = groupBy(scenarioRows, (r) => r.policy);
			for (const [policy, policyRows] of byPolicy.entries()) {
				// Report-friendly E output: minimal, easy-to-explain columns.
				writeCsv(
					`experiments_E_${scenarioToFilenameToken(scenario)}_${policyToFilenameToken(policy)}_clean.csv`,
					"scenario,policy,seed,time_s,tx_total,tx_per_node_per_min,rmse_m\n",
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
