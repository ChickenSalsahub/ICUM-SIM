
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
	{ id: "E", name: "Efficiency (Exp E)", file: "/data/experiments_E_all.csv" },
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
    const [useLogScaleC, setUseLogScaleC] = useState(false);

	// Filters for Exp D
	const [filterScenarioD, setFilterScenarioD] = useState("many_moving");

	// Filters for Exp E
	const [filterScenarioE, setFilterScenarioE] = useState("many_moving");

	// Axis range controls
	const [xMin, setXMin] = useState<string>("");
	const [xMax, setXMax] = useState<string>("");
	const [yMin, setYMin] = useState<string>("");
	const [yMax, setYMax] = useState<string>("");

	const getAxisRange = (min: string, max: string) => {
		const mn = parseFloat(min);
		const mx = parseFloat(max);
		if (Number.isFinite(mn) && Number.isFinite(mx)) return [mn, mx];
		return undefined;
	};

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
								title: { text: `Convergence: Distributed vs Baseline (10 Nodes, ${filterScenarioA}, ${filterNoiseA}m noise)` },
								xaxis: { title: { text: "Time (s)", font: { color: "black" } }, range: getAxisRange(xMin, xMax), automargin: true },
								yaxis: { title: { text: "Aligned RMSE (m)", font: { color: "black" } }, range: getAxisRange(yMin, yMax), automargin: true },
								width: 800,
								height: 500,
                                margin: { l: 60, r: 20, b: 60, t: 80 }
							}}
						/>
						<p className="mt-2 text-sm text-gray-600 italic">
							This plot compares the localization convergence of the periodic baseline vs the Event-Triggered Messaging (ETM) policy. Both should converge to a similar low RMSE, but ETM uses significantly fewer packets.
						</p>
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
								title: { text: `Network Load: Cumulative Packets (10 Nodes)` },
								xaxis: { title: { text: "Time (s)", font: { color: "black" } }, range: getAxisRange(xMin, xMax), automargin: true },
								yaxis: { title: { text: "Total Tx Packets", font: { color: "black" } }, range: getAxisRange(yMin, yMax), automargin: true },
								width: 800,
								height: 500,
                                margin: { l: 60, r: 20, b: 60, t: 80 }
							}}
                            config={{ toImageButtonOptions: { format: 'svg', filename: 'energy_plot', height: 500, width: 800, scale: 1 } }}
						/>
						<p className="mt-2 text-sm text-gray-600 italic">
							Cumulative packet count over time. Shows the energy efficiency of ETM compared to the fixed-rate baseline.
						</p>
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
								title: { text: "Average Message Rate: Tx/Node/Min (10 Nodes)" },
								xaxis: { title: { text: "Time (s)", font: { color: "black" } }, range: getAxisRange(xMin, xMax), automargin: true },
								yaxis: { title: { text: "Tx / Node / Min", font: { color: "black" } }, range: getAxisRange(yMin, yMax), automargin: true },
								width: 800,
								height: 500,
                                margin: { l: 60, r: 20, b: 60, t: 80 }
							}}
                            config={{ toImageButtonOptions: { format: 'svg', filename: 'rate_plot', height: 500, width: 800, scale: 1 } }}
						/>
						<p className="mt-2 text-sm text-gray-600 italic">
							Instantaneous message rate per node. ETM should show high rates during motion and near-zero rates when stationary.
						</p>
					</div>
				</div>
			);
		}

        if (activeExp.id === "B") {
            // Baseline Limits
            // Group by node count
            const nodeCounts = Array.from(new Set(data.map((d: any) => d.node_count))).sort((a: any, b: any) => a - b);
            const traces = nodeCounts.map((nc: any) => {
                const subset = data.filter((d: any) => d.node_count === nc);
                return {
                    x: subset.map((d: any) => d.uwb_sigma_m),
                    y: subset.map((d: any) => d.rmse_aligned_median_m),
                    error_y: {
                        type: 'data',
                        array: subset.map((d: any) => d.rmse_aligned_p75_m - d.rmse_aligned_median_m),
                        arrayminus: subset.map((d: any) => d.rmse_aligned_median_m - d.rmse_aligned_p25_m),
                        visible: true
                    },
                    type: "scatter",
                    mode: "lines+markers",
                    name: `N=${nc}`,
                };
            });

            return (
                <div className="bg-white p-4 rounded shadow">
                    <Plot
                        data={traces as any}
                        layout={{
                            title: { text: "Theoretical Lower Bound: Noise vs Redundancy" },
                            xaxis: { title: { text: "UWB Noise Sigma (m)", font: { color: "black" } }, range: getAxisRange(xMin, xMax), automargin: true },
                            yaxis: { title: { text: "Aligned RMSE (m)", font: { color: "black" } }, range: getAxisRange(yMin, yMax), automargin: true },
                            width: 800,
                            height: 500,
                            margin: { l: 60, r: 20, b: 60, t: 80 }
                        }}
                        config={{ toImageButtonOptions: { format: 'svg', filename: 'baseline_plot', height: 500, width: 800, scale: 1 } }}
                    />
                    <p className="mt-2 text-sm text-gray-600 italic">
                        Shows how redundancy improves accuracy. N=15 (more links) should have much lower error than N=3 (minimal links) for the same noise level.
                    </p>
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
                        y: subset.map((d:any) => d.rmse_aligned_m),
                        type: "scatter",
                        mode: "lines",
                        name: `N=${nc}`
                    };
                });

             return (
                <div className="flex flex-col gap-8">
                    <div className="bg-white p-4 rounded shadow">
                        <div className="flex justify-between items-center mb-2">
                             <h3 className="font-bold text-lg">Position Error (RMSE)</h3>
                             <label className="flex items-center gap-2 text-sm text-gray-600">
                                <input
                                    type="checkbox"
                                    checked={useLogScaleC}
                                    onChange={(e) => setUseLogScaleC(e.target.checked)}
                                    className="rounded"
                                />
                                Use Log Scale
                             </label>
                        </div>
                        <Plot
                            data={traces as any}
                            layout={{
                                title: { text: "Scalability: Drift by Network Size (5-50 Nodes)" },
                                xaxis: { title: { text: "Time (s)", font: { color: "black" } }, range: getAxisRange(xMin, xMax), automargin: true },
                                yaxis: { title: { text: "Aligned RMSE (m)", font: { color: "black" } }, type: useLogScaleC ? "log" : "linear", range: getAxisRange(yMin, yMax), automargin: true },
                                width: 800,
                                height: 500,
                                margin: { l: 60, r: 20, b: 60, t: 80 }
                            }}
                            config={{ toImageButtonOptions: { format: 'svg', filename: 'scalability_plot', height: 500, width: 800, scale: 1 } }}
                        />
                        <p className="mt-2 text-sm text-gray-600 italic">
                            Measures how the network's structural drift scales as the number of nodes increases from 5 to 50.
                        </p>
                    </div>

                    <div className="bg-white p-4 rounded shadow">
                        <Plot
                            data={
                                nodeCounts.map((nc: any) => {
                                    const subset = data.filter((d:any) => d.node_count === nc && d.scenario === filterScenarioC);
                                    return {
                                        x: subset.map((d:any) => d.time_s),
                                        y: subset.map((d:any) => d.tx_per_node_per_min),
                                        type: "scatter",
                                        mode: "lines",
                                        name: `N=${nc}`
                                    };
                                }) as any
                            }
                            layout={{
                                title: { text: "Scalability: Message Rate by Network Size" },
                                xaxis: { title: { text: "Time (s)", font: { color: "black" } }, range: getAxisRange(xMin, xMax), automargin: true },
                                yaxis: { title: { text: "Tx / Node / Min", font: { color: "black" } }, range: getAxisRange(yMin, yMax), automargin: true },
                                width: 800,
                                height: 500,
                                margin: { l: 60, r: 20, b: 60, t: 80 }
                            }}
                            config={{ toImageButtonOptions: { format: 'svg', filename: 'scalability_rate_plot', height: 500, width: 800, scale: 1 } }}
                        />
                        <p className="mt-2 text-sm text-gray-600 italic">
                             Measures the average message rate required per node to maintain formation. As N increases, the contention might increase, but the rate per node should ideally remain stable or scale linearly.
                        </p>
                    </div>
                </div>
            )
        }

        if (activeExp.id === "D") {
            // Cloud Tracking
            const subset = data.filter((d: any) => d.scenario === filterScenarioD);
            if (subset.length === 0) return <div>No matching data for filters.</div>;

            return (
                <div className="bg-white p-4 rounded shadow">
                    <Plot
                        data={[
                            {
                                x: subset.map((d: any) => d.time_s),
                                y: subset.map((d: any) => d.cloud_rmse_m),
                                type: "scatter",
                                mode: "lines",
                                name: "Cloud RMSE",
                                line: { color: "purple" }
                            }
                        ]}
                        layout={{
                            title: { text: `Cloud-side Fusion Accuracy (Exp D - 12 Nodes)` },
                            xaxis: { title: { text: "Time (s)", font: { color: "black" } }, range: getAxisRange(xMin, xMax), automargin: true },
                            yaxis: { title: { text: "Aligned RMSE (m)", font: { color: "black" } }, range: getAxisRange(yMin, yMax), automargin: true },
                            width: 800,
                            height: 500,
                            margin: { l: 60, r: 20, b: 60, t: 80 }
                        }}
                        config={{ toImageButtonOptions: { format: 'svg', filename: 'cloud_plot', height: 500, width: 800, scale: 1 } }}
                    />
                    <p className="mt-2 text-sm text-gray-600 italic">
                        Evaluates the accuracy of the cloud-side global optimizer as it fuses asynchronous uplinks from the distributed cluster.
                    </p>
                </div>
            )
        }

        if (activeExp.id === "E") {
            // Efficiency (multiple seeds might exist, usually 1 in current runner)
            const subset = data.filter((d: any) => d.scenario === filterScenarioE);
             if (subset.length === 0) return <div>No matching data for filters.</div>;

            // Separate by policy
            const baseline = subset.filter((d: any) => d.policy === "baseline");
            const icum = subset.filter((d: any) => d.policy === "icum");

            return (
                <div className="flex flex-col gap-8">
                    <div className="bg-white p-4 rounded shadow">
                        <Plot
                            data={[
                                {
                                    x: baseline.map((d: any) => d.time_s),
                                    y: baseline.map((d: any) => d.rmse_aligned_m),
                                    type: "scatter",
                                    mode: "lines",
                                    name: "Baseline",
                                    line: { dash: "dash" }
                                },
                                {
                                    x: icum.map((d: any) => d.time_s),
                                    y: icum.map((d: any) => d.rmse_aligned_m),
                                    type: "scatter",
                                    mode: "lines",
                                    name: "ETM",
                                    line: { color: "orange" }
                                }
                            ]}
                            layout={{
                                title: { text: `Policy Performance: Aligned RMSE (Exp E - 10 Nodes)` },
                                xaxis: { title: { text: "Time (s)", font: { color: "black" } }, range: getAxisRange(xMin, xMax), automargin: true },
                                yaxis: { title: { text: "Aligned RMSE (m)", font: { color: "black" } }, range: getAxisRange(yMin, yMax), automargin: true },
                                width: 800,
                                height: 500,
                                margin: { l: 60, r: 20, b: 60, t: 80 }
                            }}
                            config={{ toImageButtonOptions: { format: 'svg', filename: 'efficiency_rmse', height: 500, width: 800, scale: 1 } }}
                        />
                        <p className="mt-2 text-sm text-gray-600 italic">
                            Direct comparison of Aligned RMSE for different messaging policies across multiple randomized trials.
                        </p>
                    </div>
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

            {activeExp.id === "D" && (
                <div className="flex gap-4 mb-4 bg-white p-4 rounded items-center">
                    <span className="font-bold text-sm">Scenario:</span>
                    <select
                        value={filterScenarioD}
                        onChange={(e) => setFilterScenarioD(e.target.value)}
                        className="border p-2 rounded"
                    >
                        <option value="none_moving">Static</option>
                        <option value="few_moving">Few Moving (30%)</option>
                        <option value="many_moving">Many Moving (70%)</option>
                    </select>
                </div>
            )}

            {activeExp.id === "E" && (
                <div className="flex gap-4 mb-4 bg-white p-4 rounded items-center">
                    <span className="font-bold text-sm">Scenario:</span>
                    <select
                        value={filterScenarioE}
                        onChange={(e) => setFilterScenarioE(e.target.value)}
                        className="border p-2 rounded"
                    >
                        <option value="none_moving">Static</option>
                        <option value="few_moving">Few Moving (30%)</option>
                        <option value="many_moving">Many Moving (70%)</option>
                    </select>
                </div>
            )}
			<div className="flex gap-4 mb-4 bg-white p-4 rounded items-center">
				<span className="font-bold text-sm">Axis Intervals:</span>
				<div className="flex gap-2 items-center">
					<label className="text-xs text-gray-500">X-Range:</label>
					<input
						type="number"
						placeholder="Min"
						value={xMin}
						onChange={(e) => setXMin(e.target.value)}
						className="border p-1 rounded w-20 text-sm"
					/>
					<input
						type="number"
						placeholder="Max"
						value={xMax}
						onChange={(e) => setXMax(e.target.value)}
						className="border p-1 rounded w-20 text-sm"
					/>
				</div>
				<div className="flex gap-2 items-center ml-4">
					<label className="text-xs text-gray-500">Y-Range:</label>
					<input
						type="number"
						placeholder="Min"
						value={yMin}
						onChange={(e) => setYMin(e.target.value)}
						className="border p-1 rounded w-20 text-sm"
					/>
					<input
						type="number"
						placeholder="Max"
						value={yMax}
						onChange={(e) => setYMax(e.target.value)}
						className="border p-1 rounded w-20 text-sm"
					/>
				</div>
				<button
					onClick={() => {
						setXMin("");
						setXMax("");
						setYMin("");
						setYMax("");
					}}
					className="ml-4 px-2 py-1 text-xs bg-gray-200 rounded hover:bg-gray-300"
				>
					Reset Range
				</button>
			</div>

			{renderPlot()}
		</div>
	);
}
