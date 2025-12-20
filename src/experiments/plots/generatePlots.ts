import fs from "node:fs";
import path from "node:path";

type Row = Record<string, string>;

type CsvTable = {
	headers: string[];
	rows: Row[];
};

function readText(filePath: string): string {
	return fs.readFileSync(filePath, "utf8");
}

// Minimal CSV parser suitable for our numeric experiment outputs.
// Supports quoted fields and commas inside quotes.
function parseCsv(text: string): CsvTable {
	const lines = text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.split("\n")
		.filter((l) => l.trim().length > 0);
	if (lines.length === 0) {
		return { headers: [], rows: [] };
	}

	const parseLine = (line: string): string[] => {
		const out: string[] = [];
		let cur = "";
		let inQuotes = false;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (ch === '"') {
				const next = line[i + 1];
				if (inQuotes && next === '"') {
					cur += '"';
					i++;
					continue;
				}
				inQuotes = !inQuotes;
				continue;
			}
			if (ch === "," && !inQuotes) {
				out.push(cur);
				cur = "";
				continue;
			}
			cur += ch;
		}
		out.push(cur);
		return out.map((s) => s.trim());
	};

	const headers = parseLine(lines[0]);
	const rows: Row[] = [];
	for (const line of lines.slice(1)) {
		const values = parseLine(line);
		const row: Row = {};
		for (let i = 0; i < headers.length; i++) {
			row[headers[i]] = values[i] ?? "";
		}
		rows.push(row);
	}
	return { headers, rows };
}

function num(row: Row, key: string): number {
	const raw = row[key];
	if (raw === undefined) return Number.NaN;
	const v = Number(raw);
	return Number.isFinite(v) ? v : Number.NaN;
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

function writeHtml(outPath: string, title: string, plotlyDataJson: string, plotlyLayoutJson: string) {
	const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
      header { padding: 12px 16px; border-bottom: 1px solid rgba(0,0,0,0.08); }
      h1 { font-size: 16px; margin: 0; }
      #plot { width: 100vw; height: calc(100vh - 50px); }
    </style>
  </head>
  <body>
    <header><h1>${escapeHtml(title)}</h1></header>
    <div id="plot"></div>
    <script src="https://cdn.plot.ly/plotly-2.30.0.min.js"></script>
    <script>
      const data = ${plotlyDataJson};
      const layout = ${plotlyLayoutJson};
      const config = {
        responsive: true,
        displaylogo: false,
        toImageButtonOptions: { format: 'svg', filename: '${escapeJsFilename(title)}', scale: 2 }
      };
      Plotly.newPlot('plot', data, layout, config);
    </script>
  </body>
</html>`;
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, html, "utf8");
}

function baseLayout(title: string): any {
	return {
		title,
		template: "plotly_white",
		legend: { orientation: "h" },
		margin: { l: 60, r: 30, t: 70, b: 60 },
	};
}

function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function escapeJsFilename(s: string): string {
	return s
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function buildIndexHtml(outDir: string, items: { file: string; label: string }[]) {
	const links = items.map((i) => `<li><a href="${encodeURI(i.file)}">${escapeHtml(i.label)}</a></li>`).join("\n");

	const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ICUM-SIM Experiment Plots</title>
    <style>
      body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
      main { padding: 16px; }
      h1 { font-size: 18px; margin: 0 0 8px; }
    </style>
  </head>
  <body>
    <main>
      <h1>ICUM-SIM Experiment Plots</h1>
      <p>Open any plot, then use Plotly's camera icon to export SVG/PNG.</p>
      <ul>
        ${links}
      </ul>
    </main>
  </body>
</html>`;

	fs.writeFileSync(path.join(outDir, "index.html"), html, "utf8");
}

function listCsvFilesMatching(repoRoot: string, re: RegExp): string[] {
	return fs
		.readdirSync(repoRoot)
		.filter((f) => re.test(f))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function plotExperimentA(opts: { repoRoot: string; outDir: string }) {
	// A produces one CSV per (scenario, noise): experiments_A_<scenario>_noise<xx>_clean.csv
	const files = listCsvFilesMatching(opts.repoRoot, /^experiments_A_[a-z]+_noise\d+\.\d{2}_clean\.csv$/);
	const outputs: { file: string; label: string }[] = [];

	for (const csvName of files) {
		const csvPath = path.join(opts.repoRoot, csvName);
		const t = parseCsv(readText(csvPath));
		const rows = t.rows;
		if (rows.length === 0) continue;
		const scenario = rows[0]?.["scenario"] ?? "";
		const sorted = [...rows].sort((a, b) => num(a, "time_s") - num(b, "time_s"));
		const x = sorted.map((r) => num(r, "time_s"));
		const traces: any[] = [
			{
				x,
				y: sorted.map((r) => num(r, "baseline_mae_aligned_m")),
				mode: "lines",
				name: "Baseline",
				line: { width: 2 },
				xaxis: "x",
				yaxis: "y",
			},
			{
				x,
				y: sorted.map((r) => num(r, "icum_mae_aligned_m")),
				mode: "lines",
				name: "ICUM",
				line: { width: 2 },
				xaxis: "x",
				yaxis: "y",
			},
			{
				x,
				y: sorted.map((r) => num(r, "baseline_tx_total")),
				mode: "lines",
				name: "Baseline",
				showlegend: false,
				line: { width: 2 },
				xaxis: "x2",
				yaxis: "y2",
			},
			{
				x,
				y: sorted.map((r) => num(r, "icum_tx_total")),
				mode: "lines",
				name: "ICUM",
				showlegend: false,
				line: { width: 2 },
				xaxis: "x2",
				yaxis: "y2",
			},
		];

		const tag = csvName.replace("experiments_A_", "").replace("_clean.csv", "");
		const title = `Experiment A — ${scenario} — ${tag}`;
		const layout: any = {
			...baseLayout(title),
			grid: { rows: 2, columns: 1, pattern: "independent" },
			xaxis: { title: "Time (s)" },
			yaxis: { title: "MAE aligned (m)", rangemode: "tozero" },
			xaxis2: { title: "Time (s)" },
			yaxis2: { title: "Tx total (count)", rangemode: "tozero" },
		};

		const outFile = `experimentA_${escapeJsFilename(tag)}.html`;
		writeHtml(path.join(opts.outDir, outFile), title, JSON.stringify(traces), JSON.stringify(layout));
		outputs.push({ file: outFile, label: title });
	}

	return outputs;
}

function plotExperimentB(opts: { repoRoot: string; outDir: string }) {
	const csvPath = path.join(opts.repoRoot, "experiments_B_clean.csv");
	if (!fs.existsSync(csvPath)) return [];
	const t = parseCsv(readText(csvPath));

	// Report-friendly: one metric per chart.
	const byNodeCount = groupBy(t.rows, (r) => r["node_count"] ?? "");

	const buildTraces = (yKey: string, label: string) => {
		const traces: any[] = [];
		for (const [nodeCount, rows] of byNodeCount.entries()) {
			const sorted = [...rows].sort((a, b) => num(a, "uwb_sigma_m") - num(b, "uwb_sigma_m"));
			traces.push({
				x: sorted.map((r) => num(r, "uwb_sigma_m")),
				y: sorted.map((r) => num(r, yKey)),
				mode: "lines+markers",
				name: `N=${nodeCount}`,
			});
		}
		const title = `Experiment B — ${label} vs Noise`;
		const layout: any = {
			...baseLayout(title),
			xaxis: { title: "UWB noise sigma (m)" },
			yaxis: { title: `${label} (m)`, rangemode: "tozero" },
		};
		return { traces, title, layout };
	};

	const pages: { file: string; label: string }[] = [];
	{
		const { traces, title, layout } = buildTraces("mae_aligned_m", "MAE aligned");
		const outFile = "experimentB_maeAligned.html";
		writeHtml(path.join(opts.outDir, outFile), title, JSON.stringify(traces), JSON.stringify(layout));
		pages.push({ file: outFile, label: title });
	}
	{
		const { traces, title, layout } = buildTraces("pairwise_dist_mae_m", "Pairwise dist MAE");
		const outFile = "experimentB_pairwise.html";
		writeHtml(path.join(opts.outDir, outFile), title, JSON.stringify(traces), JSON.stringify(layout));
		pages.push({ file: outFile, label: title });
	}

	return pages;
}

function plotExperimentC(opts: { repoRoot: string; outDir: string }) {
	const files = listCsvFilesMatching(opts.repoRoot, /^experiments_C_[a-z]+_clean\.csv$/);
	const pages: { file: string; label: string }[] = [];
	for (const csvName of files) {
		const t = parseCsv(readText(path.join(opts.repoRoot, csvName)));
		if (t.rows.length === 0) continue;
		const scenario = t.rows[0]?.["scenario"] ?? csvName.replace("experiments_C_", "").replace("_clean.csv", "");

		const byNodes = groupBy(t.rows, (r) => r["node_count"] ?? "");
		const points = Array.from(byNodes.entries()).map(([nodes, samples]) => {
			const best = [...samples].sort((a, b) => num(b, "time_s") - num(a, "time_s"))[0];
			return {
				nodes: Number(nodes),
				ale: num(best, "ale_aligned_m"),
				tx: num(best, "tx_per_node_per_min"),
				convMs: num(best, "convergence_stable_ms"),
			};
		});
		points.sort((a, b) => a.nodes - b.nodes);

		const traces: any[] = [
			{
				x: points.map((p) => p.nodes),
				y: points.map((p) => p.ale),
				mode: "lines+markers",
				name: "ALE",
				xaxis: "x",
				yaxis: "y",
			},
			{
				x: points.map((p) => p.nodes),
				y: points.map((p) => p.tx),
				mode: "lines+markers",
				name: "Tx / node / min",
				xaxis: "x2",
				yaxis: "y2",
			},
			{
				x: points.map((p) => p.nodes),
				y: points.map((p) => (Number.isFinite(p.convMs) ? p.convMs / 1000 : Number.NaN)),
				mode: "lines+markers",
				name: "Convergence time (s)",
				xaxis: "x3",
				yaxis: "y3",
			},
		];

		const title = `Experiment C — ${scenario}`;
		const layout: any = {
			...baseLayout(title),
			grid: { rows: 3, columns: 1, pattern: "independent" },
			xaxis: { title: "Nodes" },
			yaxis: { title: "ALE (m)", rangemode: "tozero" },
			xaxis2: { title: "Nodes" },
			yaxis2: { title: "Tx / node / min", rangemode: "tozero" },
			xaxis3: { title: "Nodes" },
			yaxis3: { title: "Convergence time (s)", rangemode: "tozero" },
		};

		const outFile = `experimentC_${escapeJsFilename(scenario)}.html`;
		writeHtml(path.join(opts.outDir, outFile), title, JSON.stringify(traces), JSON.stringify(layout));
		pages.push({ file: outFile, label: title });
	}

	return pages;
}

function plotExperimentD(opts: { repoRoot: string; outDir: string }) {
	const files = listCsvFilesMatching(opts.repoRoot, /^experiments_D_[a-z]+_clean\.csv$/);
	const pages: { file: string; label: string }[] = [];
	for (const csvName of files) {
		const t = parseCsv(readText(path.join(opts.repoRoot, csvName)));
		if (t.rows.length === 0) continue;
		const scenario = t.rows[0]?.["scenario"] ?? csvName.replace("experiments_D_", "").replace("_clean.csv", "");
		const sorted = [...t.rows].sort((a, b) => num(a, "time_s") - num(b, "time_s"));
		const x = sorted.map((r) => num(r, "time_s"));
		const traces: any[] = [
			{
				x,
				y: sorted.map((r) => num(r, "cloud_baseline_rmse_m")),
				mode: "lines",
				name: "Baseline",
				xaxis: "x",
				yaxis: "y",
			},
			{
				x,
				y: sorted.map((r) => num(r, "cloud_robust_rmse_m")),
				mode: "lines",
				name: "Robust",
				xaxis: "x",
				yaxis: "y",
			},
			{
				x,
				y: sorted.map((r) => num(r, "coverage_baseline_nodes")),
				mode: "lines",
				name: "Baseline",
				showlegend: false,
				xaxis: "x2",
				yaxis: "y2",
			},
			{
				x,
				y: sorted.map((r) => num(r, "coverage_robust_nodes")),
				mode: "lines",
				name: "Robust",
				showlegend: false,
				xaxis: "x2",
				yaxis: "y2",
			},
		];

		const title = `Experiment D — ${scenario}`;
		const layout: any = {
			...baseLayout(title),
			grid: { rows: 2, columns: 1, pattern: "independent" },
			xaxis: { title: "Time (s)" },
			yaxis: { title: "Cloud RMSE (m)", rangemode: "tozero" },
			xaxis2: { title: "Time (s)" },
			yaxis2: { title: "Coverage (nodes)", rangemode: "tozero" },
		};

		const outFile = `experimentD_${escapeJsFilename(scenario)}.html`;
		writeHtml(path.join(opts.outDir, outFile), title, JSON.stringify(traces), JSON.stringify(layout));
		pages.push({ file: outFile, label: title });
	}

	return pages;
}

function plotExperimentE(opts: { repoRoot: string; outDir: string }) {
	// E produces one CSV per (scenario, policy): experiments_E_<scenario>_<policy>_clean.csv
	const files = listCsvFilesMatching(opts.repoRoot, /^experiments_E_[a-z]+_[a-z0-9]+_clean\.csv$/);
	const pages: { file: string; label: string }[] = [];

	const byScenario = new Map<string, string[]>();
	for (const csvName of files) {
		const t = parseCsv(readText(path.join(opts.repoRoot, csvName)));
		if (t.rows.length === 0) continue;
		const scenario = t.rows[0]?.["scenario"] ?? "";
		if (!scenario) continue;
		const arr = byScenario.get(scenario);
		if (arr) arr.push(csvName);
		else byScenario.set(scenario, [csvName]);
	}

	for (const [scenario, scenarioFiles] of Array.from(byScenario.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
		const policyToRmse = new Map<string, number>();
		const policyToTx = new Map<string, number>();

		for (const csvName of scenarioFiles) {
			const t = parseCsv(readText(path.join(opts.repoRoot, csvName)));
			if (t.rows.length === 0) continue;
			const rows = t.rows;
			const policy = rows[0]?.["policy"] ?? "";
			if (!policy) continue;

			// Choose last time sample per seed, then average across seeds.
			const bySeed = groupBy(rows, (r) => r["seed"] ?? "");
			const finalPerSeed = Array.from(bySeed.values()).map(
				(seedRows) => [...seedRows].sort((a, b) => num(b, "time_s") - num(a, "time_s"))[0]
			);
			const rmseVals = finalPerSeed.map((r) => num(r, "rmse_m")).filter(Number.isFinite);
			const txVals = finalPerSeed.map((r) => num(r, "tx_total")).filter(Number.isFinite);

			policyToRmse.set(policy, avg(rmseVals));
			policyToTx.set(policy, avg(txVals));
		}

		const policies = Array.from(policyToRmse.keys()).sort();
		const rmseByPolicy = policies.map((p) => policyToRmse.get(p) ?? Number.NaN);
		const txByPolicy = policies.map((p) => policyToTx.get(p) ?? Number.NaN);

		const traces: any[] = [
			{ x: policies, y: rmseByPolicy, type: "bar", name: "RMSE (m)", xaxis: "x", yaxis: "y" },
			{ x: policies, y: txByPolicy, type: "bar", name: "Tx total", xaxis: "x2", yaxis: "y2", showlegend: false },
		];

		const title = `Experiment E — ${scenario}`;
		const layout: any = {
			...baseLayout(title),
			grid: { rows: 2, columns: 1, pattern: "independent" },
			xaxis: { title: "Policy" },
			yaxis: { title: "RMSE (m)", rangemode: "tozero" },
			xaxis2: { title: "Policy" },
			yaxis2: { title: "Tx total", rangemode: "tozero" },
		};

		const outFile = `experimentE_${escapeJsFilename(scenario)}.html`;
		writeHtml(path.join(opts.outDir, outFile), title, JSON.stringify(traces), JSON.stringify(layout));
		pages.push({ file: outFile, label: title });
	}

	return pages;
}

function avg(values: number[]): number {
	if (values.length === 0) return Number.NaN;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

function main() {
	const repoRoot = process.cwd();
	const outDir = path.join(repoRoot, "docs", "plots");
	if (fs.existsSync(outDir)) {
		for (const entry of fs.readdirSync(outDir)) {
			if (entry.endsWith(".html")) {
				fs.rmSync(path.join(outDir, entry));
			}
		}
	}

	const items: { file: string; label: string }[] = [];
	items.push(...plotExperimentA({ repoRoot, outDir }));
	items.push(...plotExperimentB({ repoRoot, outDir }));
	items.push(...plotExperimentC({ repoRoot, outDir }));
	items.push(...plotExperimentD({ repoRoot, outDir }));
	items.push(...plotExperimentE({ repoRoot, outDir }));

	buildIndexHtml(outDir, items);
	console.log(`Wrote ${items.length} plots to ${outDir}`);
	console.log(`Open ${path.join(outDir, "index.html")} in a browser.`);
}

main();
