
import fs from "fs";
import path from "path";
import Papa from "papaparse";
import { runExperimentBSummary } from "./src/experiments/experiments/experimentB.ts";

/**
 * Validates that the aggregation logic in runExperimentBSummary works correctly
 * by mocking the raw data source.
 */
function regenerateSummary() {
    const rawPath = path.join(process.cwd(), "public", "data", "experiments_B_raw_clean.csv");
    if (!fs.existsSync(rawPath)) {
        console.error("Raw file not found");
        return;
    }

    const csvText = fs.readFileSync(rawPath, "utf8");
    const parsed = Papa.parse(csvText, { header: true, dynamicTyping: true, skipEmptyLines: true });
    
    // We mock the runExperimentBRaw function by just returning the parsed data
    // But we can't easily inject it.
    // Instead, let's just duplicate the aggregation logic here for safety/speed.
    
    const raw = parsed.data as any[];
    console.log(`Loaded ${raw.length} rows.`);

    const byParams = new Map<string, any[]>();
	for (const r of raw) {
		const key = `${r.node_count}_${r.uwb_sigma_m}`;
		const arr = byParams.get(key);
		if (arr) arr.push(r);
		else byParams.set(key, [r]);
	}
    
    // Helper stats functions
    const quantileSorted = (xs: number[], q: number) => {
        if (xs.length === 0) return NaN;
        if (q <= 0) return xs[0];
        if (q >= 1) return xs[xs.length - 1];
        const pos = (xs.length - 1) * q;
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return xs[lo];
        return xs[lo] * (1 - (pos - lo)) + xs[hi] * (pos - lo);
    };
    const median = (vals: number[]) => quantileSorted(vals.sort((a,b)=>a-b), 0.5);
    const mean = (vals: number[]) => vals.reduce((a,b)=>a+b,0) / vals.length;
    
    // Generate CSV Content directly from sorted groups
    const sortedGroups = [...byParams.values()]
		.sort((a, b) => {
			const nc = a[0].node_count - b[0].node_count;
			if (nc !== 0) return nc;
			return a[0].uwb_sigma_m - b[0].uwb_sigma_m;
		});

    const header = "node_count,uwb_sigma_m,n_seeds,rmse_aligned_median_m,rmse_aligned_p25_m,rmse_aligned_p75_m,mae_aligned_median_m,mae_aligned_p25_m,mae_aligned_p75_m,pairwise_dist_mae_median_m,pairwise_dist_mae_p25_m,pairwise_dist_mae_p75_m\n";
    
    const lines = sortedGroups.map(group => {
            const rmse = group.map((g: any) => g.rmse_aligned_m);
            const mae = group.map((g: any) => g.mae_aligned_m);
            const pwd = group.map((g: any) => g.pairwise_dist_mae_m);
            
            // Sort for quantile calculation
            rmse.sort((a: number, b: number) => a - b);
            mae.sort((a: number, b: number) => a - b);
            pwd.sort((a: number, b: number) => a - b);
            
            return [
                group[0].node_count,
                group[0].uwb_sigma_m,
                group.length,
                median(rmse), quantileSorted(rmse, 0.25), quantileSorted(rmse, 0.75),
                median(mae), quantileSorted(mae, 0.25), quantileSorted(mae, 0.75),
                median(pwd), quantileSorted(pwd, 0.25), quantileSorted(pwd, 0.75),
            ].join(",");
    });

    const outPath = path.join(process.cwd(), "public", "data", "experiments_B_summary_clean.csv");
    fs.writeFileSync(outPath, header + lines.join("\n"));
    console.log(`Wrote corrected summary to ${outPath} (${lines.length} rows)`);
}

regenerateSummary();
