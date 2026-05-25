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
  {
    id: "K",
    name: "Kalman Filter",
    file: [
      "/data/experiments_kalman[0].csv",
      "/data/experiments_kalman[1].csv",
      "/data/experiments_kalman[2].csv",
      "/data/experiments_kalman[3].csv",
      "/data/experiments_kalman[4].csv",
      "/data/experiments_kalman[5].csv",
    ],
  },
  { id: "KA", name: "Kalman Adaptive", file: "/data/experiments_kalman_adaptive.csv" },
];

export function AnalysisDashboard() {
  const [activeExp, setActiveExp] = useState(EXPERIMENTS[0]);
  const [data, setData] = useState<any[] | any[][]>([]);
  const [loading, setLoading] = useState(false);

  // Filters
  const [filterScenarioA, setFilterScenarioA] = useState("few_moving");
  const [filterNoiseA, setFilterNoiseA] = useState("0.1");
  const [filterScenarioC, setFilterScenarioC] = useState("none_moving");
  const [useLogScaleC] = useState(false);
  const [filterScenarioD, setFilterScenarioD] = useState("many_moving");
  const [filterScenarioE, setFilterScenarioE] = useState("many_moving");

  // Axis controls
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
    const fileEntry = (activeExp as any).file;
    if (Array.isArray(fileEntry)) {
      Promise.all(fileEntry.map((f: string) => fetch(f).then((r) => r.text())))
        .then((texts) => {
          const parsed = texts.map((txt) => Papa.parse(txt, { header: true, dynamicTyping: true, skipEmptyLines: true }).data);
          setData(parsed);
          setLoading(false);
        })
        .catch((err) => {
          console.error("Failed to load CSVs", err);
          setData([]);
          setLoading(false);
        });
    } else if (typeof fileEntry === "string") {
      fetch(fileEntry)
        .then((r) => r.text())
        .then((txt) => {
          const parsed = Papa.parse(txt, { header: true, dynamicTyping: true, skipEmptyLines: true }).data;
          setData(parsed as any[]);
          setLoading(false);
        })
        .catch((err) => {
          console.error("Failed to load CSV", err);
          setData([]);
          setLoading(false);
        });
    } else {
      setData([]);
      setLoading(false);
    }
  }, [activeExp]);

  const renderPlot = () => {
    if (loading) return <div>Loading data...</div>;
    if (!data || (Array.isArray(data) && (data as any[]).length === 0)) return <div>No data found. Ensure experiments ran successfully.</div>;

    // If data is an array of arrays -> kalman multi-files
    const isMulti = Array.isArray(data) && data.length > 0 && Array.isArray((data as any)[0]);
    const flat = isMulti ? (data as any).flat() : (data as any);

    if (activeExp.id === "A") {
      const subset = (flat as any[]).filter((d: any) => d.scenario === filterScenarioA && Math.abs(d.noise_sigma - parseFloat(filterNoiseA)) < 0.001);
      if (subset.length === 0) return <div>No matching data for filters.</div>;
      const t = subset.map((d: any) => d.time_s);
      return (
        <div className="flex flex-col gap-8">
          <div className="bg-white p-4 rounded shadow">
            <Plot
              data={[
                { x: t, y: subset.map((d: any) => d.baseline_rmse_aligned_m), type: "scatter", mode: "lines", name: "Baseline (Periodic)", line: { dash: "dash", width: 2 } },
                { x: t, y: subset.map((d: any) => d.icum_rmse_aligned_m), type: "scatter", mode: "lines", name: "Distributed (ETM)", line: { color: "#d62728", width: 3 } },
              ]}
              layout={{ title: { text: `Convergence: Distributed vs Baseline (10 Nodes, ${filterScenarioA}, ${filterNoiseA}m noise)` }, xaxis: { title: { text: "Time (s)" }, range: getAxisRange(xMin, xMax) }, yaxis: { title: { text: "Aligned RMSE (m)" }, range: getAxisRange(yMin, yMax) }, width: 800, height: 500 }}
            />
          </div>
        </div>
      );
    }

    if (activeExp.id === "B") {
      const nodeCounts = Array.from(new Set((flat as any[]).map((d: any) => d.node_count))).sort((a: any, b: any) => a - b);
      const traces = nodeCounts.map((nc: any) => {
        const subset = (flat as any[]).filter((d: any) => d.node_count === nc);
        return {
          x: subset.map((d: any) => d.uwb_sigma_m),
          y: subset.map((d: any) => d.rmse_aligned_median_m),
          type: "scatter",
          mode: "lines+markers",
          name: `N=${nc}`,
        };
      });
      return (
        <div className="bg-white p-4 rounded shadow">
          <Plot data={traces as any} layout={{ title: { text: "Theoretical Lower Bound: Noise vs Redundancy" }, xaxis: { title: { text: "UWB Noise Sigma (m)" } }, yaxis: { title: { text: "Aligned RMSE (m)" } }, width: 800, height: 500 }} />
        </div>
      );
    }

    if (activeExp.id === "C") {
      const nodeCounts = Array.from(new Set((flat as any[]).map((d: any) => d.node_count))).sort((a: any, b: any) => a - b);
      const traces = nodeCounts.map((nc: any) => {
        const subset = (flat as any[]).filter((d: any) => d.node_count === nc && d.scenario === filterScenarioC);
        const timeMap = new Map<number, { sum: number; count: number }>();
        subset.forEach((d: any) => {
          const t = d.time_s;
          if (!timeMap.has(t)) timeMap.set(t, { sum: 0, count: 0 });
          const entry = timeMap.get(t)!;
          entry.sum += d.rmse_aligned_m;
          entry.count++;
        });
        const sortedTimes = Array.from(timeMap.keys()).sort((a, b) => a - b);
        const meanRmse = sortedTimes.map((t) => timeMap.get(t)!.sum / timeMap.get(t)!.count);
        return { x: sortedTimes, y: meanRmse, type: "scatter", mode: "lines", name: `N=${nc}` };
      });
      return (
        <div className="flex flex-col gap-8">
          <div className="bg-white p-4 rounded shadow">
            <Plot data={traces as any} layout={{ title: { text: "Scalability: Drift by Network Size" }, xaxis: { title: { text: "Time (s)" } }, yaxis: { title: { text: "Aligned RMSE (m)" }, type: useLogScaleC ? "log" : "linear" }, width: 800, height: 500 }} />
          </div>
        </div>
      );
    }

    if (activeExp.id === "D") {
      const subset = (flat as any[]).filter((d: any) => d.scenario === filterScenarioD);
      if (subset.length === 0) return <div>No matching data for filters.</div>;
      return (
        <div className="bg-white p-4 rounded shadow">
          <Plot data={[{ x: subset.map((d: any) => d.time_s), y: subset.map((d: any) => d.cloud_rmse_m), type: "scatter", mode: "lines", name: "Cloud RMSE" }]} layout={{ title: { text: `Cloud-side Fusion Accuracy (Exp D)` }, xaxis: { title: { text: "Time (s)" } }, yaxis: { title: { text: "Aligned RMSE (m)" } }, width: 800, height: 500 }} />
        </div>
      );
    }

    if (activeExp.id === "E") {
      const subset = (flat as any[]).filter((d: any) => d.scenario === filterScenarioE);
      if (subset.length === 0) return <div>No matching data for filters.</div>;
      const baseline = subset.filter((d: any) => d.policy === "baseline");
      const icum = subset.filter((d: any) => d.policy === "icum");
      return (
        <div className="bg-white p-4 rounded shadow">
          <Plot data={[{ x: baseline.map((d: any) => d.time_s), y: baseline.map((d: any) => d.rmse_aligned_m), type: "scatter", mode: "lines", name: "Baseline" }, { x: icum.map((d: any) => d.time_s), y: icum.map((d: any) => d.rmse_aligned_m), type: "scatter", mode: "lines", name: "ETM" }]} layout={{ title: { text: `Policy Performance: Aligned RMSE (Exp E)` }, xaxis: { title: { text: "Time (s)" } }, yaxis: { title: { text: "Aligned RMSE (m)" } }, width: 800, height: 500 }} />
        </div>
      );
    }

    if (activeExp.id === "K") {
      // multiple files -> data is array of arrays
      if (isMulti) {
        const datasets: any[][] = data as any;
        const filePaths: string[] = (activeExp as any).file as string[];

        // compute averages and percent differences per dataset
        const stats = datasets.map((ds) => {
          const avgGps = ds.length > 0 ? ds.reduce((s: number, d: any) => s + (d.rmse_gps_m ?? 0), 0) / ds.length : 0;
          const avgEkf = ds.length > 0 ? ds.reduce((s: number, d: any) => s + (d.rmse_ekf_m ?? 0), 0) / ds.length : 0;
          const avgTuned = ds.length > 0 ? ds.reduce((s: number, d: any) => s + (d.rmse_ekf_tuned_m ?? 0), 0) / ds.length : 0;
          const pNormal = avgGps > 0 ? ((avgGps - avgEkf) / avgGps) * 100 : 0;
          const pAdaptive = avgGps > 0 ? ((avgGps - avgTuned) / avgGps) * 100 : 0;
          return { avgGps, avgEkf, avgTuned, pNormal, pAdaptive };
        });

        return (
          <div className="flex flex-col gap-6">
            <div style={{ display: 'flex', flexDirection: 'row', gap: '0.75rem', overflowX: 'auto', whiteSpace: 'nowrap', paddingBottom: '0.5rem' }}>
              {stats.map((s, i) => {
                const signNormal = s.pNormal >= 0 ? "+" : "";
                const signAdaptive = s.pAdaptive >= 0 ? "+" : "";
                return (
                  <div key={`hdr-${i}`} className="bg-white p-2 rounded border text-sm" style={{ flexShrink: 0, minWidth: 176 }}>
                    <div className="font-semibold">Experiment {i}</div>
                    <div className="flex justify-between"><div className="text-xs text-gray-600">Normal:</div><div className="font-mono" style={{ color: s.pNormal >= 0 ? '#2B8F00' : '#8F1900' }}>{signNormal}{s.pNormal.toFixed(1)}%</div></div>
                    <div className="flex justify-between"><div className="text-xs text-gray-600">Adaptive:</div><div className="font-mono" style={{ color: s.pAdaptive >= 0 ? '#2B8F00' : '#8F1900' }}>{signAdaptive}{s.pAdaptive.toFixed(1)}%</div></div>
                  </div>
                );
              })}
            </div>

            {datasets.map((ds, idx) => {
              const t = ds.map((d: any) => d.time_s);
              const { avgGps, avgEkf, avgTuned } = stats[idx];
              const sampleN = ds && ds[0] && ds[0].n !== undefined ? ds[0].n : null;
              const filename = filePaths && filePaths[idx] ? filePaths[idx].split('/').pop() : `file_${idx}`;
              return (
                <div key={idx} className="bg-white p-4 rounded shadow">
                  <div className="flex gap-4">
                    <div className="flex-1">
                      <Plot data={[{ x: t, y: ds.map((d: any) => d.rmse_gps_m), type: "scatter", mode: "lines", name: "Noisy GPS", line: { dash: "dash", color: "blue" } }, { x: t, y: ds.map((d: any) => d.rmse_ekf_m), type: "scatter", mode: "lines", name: "Kalman — production", line: { color: "green" } }, { x: t, y: ds.map((d: any) => d.rmse_ekf_tuned_m), type: "scatter", mode: "lines", name: "Kalman — tuned", line: { color: "orange" } }]} layout={{ title: { text: `Kalman: ${filename}` }, xaxis: { title: { text: "Time (s)" } }, yaxis: { title: { text: "RMSE (m)" } }, width: 800, height: 400 }} />
                    </div>
                    <div className="w-56 flex flex-col gap-2 bg-gray-50 p-3 rounded border">
                      <div className="text-xs text-gray-500">Source file</div>
                      <div className="text-sm font-mono text-gray-800 break-words">{filename}</div>
                      <div className="text-sm text-gray-500 mt-2">Sample n</div>
                      <div className="text-lg font-mono text-purple-700">{sampleN !== null ? String(sampleN) : "—"}</div>
                      <div className="text-sm text-gray-500 mt-2">Avg Noisy GPS</div>
                      <div className="text-lg font-mono text-blue-600">{avgGps.toFixed(3)} m</div>
                      <div className="text-sm text-gray-500">Avg Kalman</div>
                      <div className="text-lg font-mono text-green-600">{avgEkf.toFixed(3)} m</div>
                      <div className="text-sm text-gray-500">Avg Kalman Tuned</div>
                      <div className="text-lg font-mono text-orange-500">{avgTuned.toFixed(3)} m</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      }

      // single-file fallback
      const single = data as any[];
      const avgGps = single.length > 0 ? single.reduce((s: number, d: any) => s + (d.rmse_gps_m ?? 0), 0) / single.length : 0;
      const avgEkf = single.length > 0 ? single.reduce((s: number, d: any) => s + (d.rmse_ekf_m ?? 0), 0) / single.length : 0;
      const avgTuned = single.length > 0 ? single.reduce((s: number, d: any) => s + (d.rmse_ekf_tuned_m ?? 0), 0) / single.length : 0;
      const filename = (activeExp as any).file ? String((activeExp as any).file).split('/').pop() : 'kalman_single.csv';
      return (
        <div className="bg-white p-4 rounded shadow">
          <div className="flex gap-4">
            <div className="flex-1">
              <Plot data={[{ x: single.map((d: any) => d.time_s), y: single.map((d: any) => d.rmse_gps_m), type: "scatter", mode: "lines", name: "Noisy GPS" }, { x: single.map((d: any) => d.time_s), y: single.map((d: any) => d.rmse_ekf_m), type: "scatter", mode: "lines", name: "Kalman" }, { x: single.map((d: any) => d.time_s), y: single.map((d: any) => d.rmse_ekf_tuned_m), type: "scatter", mode: "lines", name: "Kalman Tuned" }]} layout={{ title: { text: `Kalman: ${filename}` }, xaxis: { title: { text: "Time (s)" } }, yaxis: { title: { text: "RMSE (m)" } }, width: 800, height: 500 }} />
            </div>
            <div className="w-56 flex flex-col gap-2 bg-gray-50 p-3 rounded border">
              <div className="text-sm text-gray-500">Source file</div>
              <div className="text-sm font-mono text-gray-800 break-words">{filename}</div>
              <div className="text-sm text-gray-500 mt-2">Avg Noisy GPS</div>
              <div className="text-lg font-mono text-blue-600">{avgGps.toFixed(3)} m</div>
              <div className="text-sm text-gray-500">Avg Kalman</div>
              <div className="text-lg font-mono text-green-600">{avgEkf.toFixed(3)} m</div>
              <div className="text-sm text-gray-500">Avg Kalman Tuned</div>
              <div className="text-lg font-mono text-orange-500">{avgTuned.toFixed(3)} m</div>
            </div>
          </div>
        </div>
      );
    }

    return <div>Plotting for {activeExp.name} not implemented yet.</div>;
  };

  return (
    <div className="p-6 bg-gray-100 min-h-screen">
      <h1 className="text-2xl font-bold mb-6">Scientific Results Analysis</h1>

      <div className="flex gap-4 mb-6">
        {EXPERIMENTS.map((exp) => (
          <button key={exp.id} onClick={() => setActiveExp(exp)} className={`px-4 py-2 rounded ${activeExp.id === exp.id ? "bg-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"}`}>
            {exp.name}
          </button>
        ))}
      </div>

      {activeExp.id === "A" && (
        <div className="flex gap-4 mb-4 bg-white p-4 rounded items-center">
          <span className="font-bold text-sm">Filters:</span>
          <select value={filterScenarioA} onChange={(e) => setFilterScenarioA(e.target.value)} className="border p-2 rounded">
            <option value="none_moving">None Moving</option>
            <option value="few_moving">Few Moving (10%)</option>
            <option value="many_moving">Many Moving (50%)</option>
          </select>
          <select value={filterNoiseA} onChange={(e) => setFilterNoiseA(e.target.value)} className="border p-2 rounded">
            <option value="0">0m (Perfect)</option>
            <option value="0.1">0.1m (Standard)</option>
            <option value="0.5">0.5m (Noisy)</option>
          </select>
        </div>
      )}

      {activeExp.id === "C" && (
        <div className="flex gap-4 mb-4 bg-white p-4 rounded items-center">
          <span className="font-bold text-sm">Scenario:</span>
          <select value={filterScenarioC} onChange={(e) => setFilterScenarioC(e.target.value)} className="border p-2 rounded">
            <option value="none_moving">Static</option>
            <option value="few_moving">Few Moving (10%)</option>
            <option value="many_moving">Many Moving (50%)</option>
          </select>
        </div>
      )}

      {activeExp.id === "D" && (
        <div className="flex gap-4 mb-4 bg-white p-4 rounded items-center">
          <span className="font-bold text-sm">Scenario:</span>
          <select value={filterScenarioD} onChange={(e) => setFilterScenarioD(e.target.value)} className="border p-2 rounded">
            <option value="none_moving">Static</option>
            <option value="few_moving">Few Moving (30%)</option>
            <option value="many_moving">Many Moving (70%)</option>
          </select>
        </div>
      )}

      {activeExp.id === "E" && (
        <div className="flex gap-4 mb-4 bg-white p-4 rounded items-center">
          <span className="font-bold text-sm">Scenario:</span>
          <select value={filterScenarioE} onChange={(e) => setFilterScenarioE(e.target.value)} className="border p-2 rounded">
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
          <input type="number" placeholder="Min" value={xMin} onChange={(e) => setXMin(e.target.value)} className="border p-1 rounded w-20 text-sm" />
          <input type="number" placeholder="Max" value={xMax} onChange={(e) => setXMax(e.target.value)} className="border p-1 rounded w-20 text-sm" />
        </div>
        <div className="flex gap-2 items-center ml-4">
          <label className="text-xs text-gray-500">Y-Range:</label>
          <input type="number" placeholder="Min" value={yMin} onChange={(e) => setYMin(e.target.value)} className="border p-1 rounded w-20 text-sm" />
          <input type="number" placeholder="Max" value={yMax} onChange={(e) => setYMax(e.target.value)} className="border p-1 rounded w-20 text-sm" />
        </div>
        <button onClick={() => { setXMin(""); setXMax(""); setYMin(""); setYMax(""); }} className="ml-4 px-2 py-1 text-xs bg-gray-200 rounded hover:bg-gray-300">Reset Range</button>
      </div>

      {renderPlot()}
    </div>
  );
}
