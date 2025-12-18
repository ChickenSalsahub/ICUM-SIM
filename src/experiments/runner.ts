import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "url";
import { EXPERIMENT_WORLD_BOUNDS_M } from "./lib/types.ts";
import { runExperimentAScenariosWithOptions } from "./experiments/experimentA.ts";
import { runExperimentB, runExperimentBRaw, runExperimentBSummary } from "./experiments/experimentB.ts";
import { runExperimentCScenarios } from "./experiments/experimentC.ts";
import { runExperimentDScenarios } from "./experiments/experimentD.ts";
import { runExperimentE } from "./experiments/experimentE.ts";

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

	console.log(
		`World bounds enabled: x=[${EXPERIMENT_WORLD_BOUNDS_M.minX}, ${EXPERIMENT_WORLD_BOUNDS_M.maxX}] y=[${EXPERIMENT_WORLD_BOUNDS_M.minY}, ${EXPERIMENT_WORLD_BOUNDS_M.maxY}]`
	);

	// Experiment A: compare baseline periodic vs ETM across a few noise levels.
	{
		const noiseSigmasA = [0, 0.1, 0.5];
		const allRows: any[] = [];

		for (const uwbNoiseSigma of noiseSigmasA) {
			const rows = runExperimentAScenariosWithOptions({ uwbNoiseSigma });
			for (const r of rows) {
				allRows.push({ ...r, uwbNoiseSigma });
			}
		}

		writePublicCsv(
			"experiments_A_all.csv",
			"scenario,noise_sigma,time_s,baseline_tx_total,baseline_tx_per_node_per_min,baseline_rmse_aligned_m,baseline_mae_aligned_m,icum_tx_total,icum_tx_per_node_per_min,icum_rmse_aligned_m,icum_mae_aligned_m\n",
			allRows.map((r) =>
				[
					r.scenario,
					r.uwbNoiseSigma,
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

	const b = runExperimentB();
	const bRaw = runExperimentBRaw();
	const bSummary = runExperimentBSummary();

	// Experiment B (clean): anchor-free metrics only.
	const headerBClean = "node_count,uwb_sigma_m,rmse_aligned_m,mae_aligned_m,pairwise_dist_mae_m\n";
	writePublicCsv(
		"experiments_B_clean.csv",
		headerBClean,
		b.map((r) => [r.nodeCount, r.noiseSigma, r.rmseAligned, r.maeAligned, r.pairwiseDistMae].join(","))
	);

	const headerBRawClean = "node_count,uwb_sigma_m,seed,rmse_aligned_m,mae_aligned_m,pairwise_dist_mae_m\n";
	writePublicCsv(
		"experiments_B_raw_clean.csv",
		headerBRawClean,
		bRaw.map((r) => [r.nodeCount, r.noiseSigma, r.seed, r.rmseAligned, r.maeAligned, r.pairwiseDistMae].join(","))
	);

	// Cleaner summary: median + IQR only for the anchor-free metrics most used in the report.
	const headerBSummaryClean =
		"node_count,uwb_sigma_m,n_seeds,rmse_aligned_median_m,rmse_aligned_p25_m,rmse_aligned_p75_m,mae_aligned_median_m,mae_aligned_p25_m,mae_aligned_p75_m,pairwise_dist_mae_median_m,pairwise_dist_mae_p25_m,pairwise_dist_mae_p75_m\n";
	writePublicCsv(
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
		writePublicCsv(
			`experiments_C_all.csv`,
			"scenario,time_s,node_count,tx_per_node_per_min,rmse_aligned_m\n",
			rows.map((r) =>
				[
					r.scenario,
					r.timeSeconds,
					r.nodes,
					r.txPerNodePerMin,
					r.rmse,
				].join(",")
			)
		);
	}

	{
		const rows = runExperimentDScenarios();
		writePublicCsv(
			`experiments_D_all.csv`,
			"scenario,time_s,node_count,cloud_rmse_m,cloud_coverage_nodes\n",
			rows.map((r) =>
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

	{
		const rows = runExperimentE();
		writePublicCsv(
			`experiments_E_all.csv`,
			"scenario,policy,seed,time_s,tx_total,tx_per_node_per_min,rmse_aligned_m\n",
			rows.map((r) =>
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
const isMain = () => import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain()) {
	main();
}
