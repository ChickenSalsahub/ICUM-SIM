
// @ts-ignore
declare module "react-plotly.js";

import { useEffect, useState } from "react";
import Plot from "react-plotly.js";
import Papa from "papaparse";

const EXPERIMENTS = [
	{ id: "A", name: "Comparison (Exp A)", file: "/data/experiments_A_all.csv" },
	{ id: "B", name: "Baseline (Exp B)", file: "/data/experiments_B_summary_clean.csv" },
	{ id: "C", name: "Scalability (Exp C)", file: "/data/experiments_C_all.csv" },
	{ id: "D", name: "Cloud (Exp D)", file: "/data/experiments_D_all.csv" },
];

export function AnalysisDashboard() {
	const [activeExp, setActiveExp] = useState(EXPERIMENTS[0]);
	const [data, setData] = useState<any[]>([]);
	const [loading, setLoading] = useState(false);

	// Filters for Exp A
	const [filterScenarioA, setFilterScenarioA] = useState("few_moving");
	const [filterNoiseA, setFilterNoiseA] = useState("0.1");

    // Filters for Exp C
    const [filterScenarioC, setFilterScenarioC] = useState("none_moving");

	useEffect(() => {
		setLoading(true);
		fetch(activeExp.file)
			.then((res) => res.text())
			.then((csvText) => {
				const result = Papa.parse(csvText, { header: true, dynamicTyping: true, skipEmptyLines: true });
				setData(result.data);
				setLoading(false);
			})
			.catch((err) => {
				console.error("Failed to load CSV", err);
				setLoading(false);
			});
	}, [activeExp]);

	const renderPlot = () => {
		if (loading) return <div>Loading data...</div>;
		if (!data || data.length === 0) return <div>No data found. Ensure experiments ran successfully.</div>;

		if (activeExp.id === "A") {
			// Distributed vs Baseline
			// Filter
			const subset = data.filter(
				(d: any) => d.scenario === filterScenarioA && Math.abs(d.noise_sigma - parseFloat(filterNoiseA)) < 0.001
			);

            if (subset.length === 0) return <div>No matching data for filters.</div>;

			const t = subset.map((d: any) => d.time_s);
			return (
				<div className="flex flex-col gap-8">
					<div className="bg-white p-4 rounded shadow">
						<Plot
							data={[
								{
									x: t,
									y: subset.map((d: any) => d.baseline_rmse_aligned_m),
									type: "scatter",
									mode: "lines",
									name: "Baseline (Periodic)",
									line: { dash: "dash", width: 2 },
								},
								{
									x: t,
									y: subset.map((d: any) => d.icum_rmse_aligned_m),
									type: "scatter",
									mode: "lines",
									name: "Distributed (ETM)",
									line: { color: "#d62728", width: 3 },
								},
							]}
							layout={{
								title: { text: `Convergence: Distributed vs Baseline (${filterScenarioA}, ${filterNoiseA}m noise)` },
								xaxis: { title: { text: "Time (s)", font: { color: "black" } }, automargin: true },
								yaxis: { title: { text: "Aligned RMSE (m)", font: { color: "black" } }, automargin: true },
								width: 800,
								height: 500,
                                margin: { l: 60, r: 20, b: 60, t: 80 }
							}}
                            config={{ toImageButtonOptions: { format: 'svg', filename: 'convergence_plot', height: 500, width: 800, scale: 1 } }}
						/>
					</div>
                    <div className="bg-white p-4 rounded shadow">
						<Plot
							data={[
								{
									x: t,
									y: subset.map((d: any) => d.baseline_tx_total),
									type: "scatter",
									mode: "lines",
									name: "Baseline Tx",
                                    line: { dash: "dash" },
								},
								{
									x: t,
									y: subset.map((d: any) => d.icum_tx_total),
									type: "scatter",
									mode: "lines",
									name: "ETM Tx",
                                    line: { color: "green" },
								},
							]}
							layout={{
								title: { text: `Network Load (Cumulative Packets)` },
								xaxis: { title: { text: "Time (s)", font: { color: "black" } }, automargin: true },
								yaxis: { title: { text: "Total Tx Packets", font: { color: "black" } }, automargin: true },
								width: 800,
								height: 500,
                                margin: { l: 60, r: 20, b: 60, t: 80 }
							}}
                            config={{ toImageButtonOptions: { format: 'svg', filename: 'energy_plot', height: 500, width: 800, scale: 1 } }}
						/>
					</div>
                    <div className="bg-white p-4 rounded shadow">
						<Plot
							data={[
								{
									x: t,
									y: subset.map((d: any) => d.baseline_tx_per_node_per_min),
									type: "scatter",
									mode: "lines",
									name: "Baseline Rate",
                                    line: { dash: "dash" },
								},
								{
									x: t,
									y: subset.map((d: any) => d.icum_tx_per_node_per_min),
									type: "scatter",
									mode: "lines",
									name: "ETM Rate",
                                    line: { color: "green" },
								},
							]}
							layout={{
								title: { text: "Average Message Rate (Tx/Node/Min)" },
								xaxis: { title: { text: "Time (s)", font: { color: "black" } }, automargin: true },
								yaxis: { title: { text: "Tx / Node / Min", font: { color: "black" } }, automargin: true },
								width: 800,
								height: 500,
                                margin: { l: 60, r: 20, b: 60, t: 80 }
							}}
                            config={{ toImageButtonOptions: { format: 'svg', filename: 'rate_plot', height: 500, width: 800, scale: 1 } }}
						/>
					</div>
				</div>
			);
		}

        if (activeExp.id === "B") {
            // Baseline Limits
            return (
                <div className="bg-white p-4 rounded shadow">
                    <Plot
                        data={[
                            {
                                x: data.map((d: any) => d.uwb_sigma_m),
                                y: data.map((d: any) => d.rmse_aligned_median_m),
                                error_y: {
                                    type: 'data',
                                    array: data.map((d: any) => d.rmse_aligned_p75_m - d.rmse_aligned_median_m),
                                    arrayminus: data.map((d: any) => d.rmse_aligned_median_m - d.rmse_aligned_p25_m),
                                    visible: true
                                },
                                type: "scatter",
                                mode: "lines+markers",
                                name: "Median RMSE",
                            }
                        ]}
                        layout={{
                            title: { text: "Theoretical Lower Bound (Exp B - 10 Nodes)" },
                            xaxis: { title: { text: "UWB Noise Sigma (m)", font: { color: "black" } }, automargin: true },
                            yaxis: { title: { text: "Aligned RMSE (m)", font: { color: "black" } }, automargin: true },
                            width: 800,
                            height: 500,
                            margin: { l: 60, r: 20, b: 60, t: 80 }
                        }}
                        config={{ toImageButtonOptions: { format: 'svg', filename: 'baseline_plot', height: 500, width: 800, scale: 1 } }}
                    />
                </div>
            )
        }

            if (activeExp.id === "C") {
                // Scalability
                const nodeCounts = Array.from(new Set(data.map((d:any) => d.node_count))).sort((a:any,b:any) => a-b);
                const traces = nodeCounts.map((nc: any) => {
                    const subset = data.filter((d:any) => d.node_count === nc && d.scenario === filterScenarioC);
                    return {
                        x: subset.map((d:any) => d.time_s),
                        y: subset.map((d:any) => d.rmse_m),
                        type: "scatter",
                        mode: "lines",
                        name: `N=${nc}`
                    };
                });

             return (
                <div className="bg-white p-4 rounded shadow">
                    <Plot
                        data={traces as any}
                        layout={{
                            title: { text: "Scalability: Drift by Network Size" },
                            xaxis: { title: { text: "Time (s)", font: { color: "black" } }, automargin: true },
                            yaxis: { title: { text: "RMSE (m)", font: { color: "black" } }, type: "log", automargin: true },
                            width: 800,
                            height: 500,
                            margin: { l: 60, r: 20, b: 60, t: 80 }
                        }}
                        config={{ toImageButtonOptions: { format: 'svg', filename: 'scalability_plot', height: 500, width: 800, scale: 1 } }}
                    />
                </div>
            )
        }

		return <div>Plotting for {activeExp.name} not implemented yet in this preview.</div>;
	};

	return (
		<div className="p-6 bg-gray-100 min-h-screen">
			<h1 className="text-2xl font-bold mb-6">Scientific Results Analysis</h1>

			<div className="flex gap-4 mb-6">
				{EXPERIMENTS.map((exp) => (
					<button
						key={exp.id}
						onClick={() => setActiveExp(exp)}
						className={`px-4 py-2 rounded ${
							activeExp.id === exp.id ? "bg-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
						}`}
					>
						{exp.name}
					</button>
				))}
			</div>

			{activeExp.id === "A" && (
				<div className="flex gap-4 mb-4 bg-white p-4 rounded items-center">
					<span className="font-bold text-sm">Filters:</span>
					<select
						value={filterScenarioA}
						onChange={(e) => setFilterScenarioA(e.target.value)}
						className="border p-2 rounded"
					>
                        <option value="none_moving">None Moving</option>
						<option value="few_moving">Few Moving (10%)</option>
						<option value="many_moving">Many Moving (50%)</option>
					</select>
					<select
						value={filterNoiseA}
						onChange={(e) => setFilterNoiseA(e.target.value)}
						className="border p-2 rounded"
					>
						<option value="0">0m (Perfect)</option>
						<option value="0.1">0.1m (Standard)</option>
						<option value="0.5">0.5m (Noisy)</option>
					</select>
				</div>

			)}

            {activeExp.id === "C" && (
                <div className="flex gap-4 mb-4 bg-white p-4 rounded items-center">
                    <span className="font-bold text-sm">Scenario:</span>
                    <select
                        value={filterScenarioC}
                        onChange={(e) => setFilterScenarioC(e.target.value)}
                        className="border p-2 rounded"
                    >
                        <option value="none_moving">Static</option>
                        <option value="few_moving">Few Moving (10%)</option>
                        <option value="many_moving">Many Moving (50%)</option>
                    </select>
                </div>
            )}

			{renderPlot()}
		</div>
	);
}
