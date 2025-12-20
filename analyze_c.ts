
import fs from 'fs';
import Papa from 'papaparse';

const file = fs.readFileSync('public/data/experiments_C_all.csv', 'utf8');
const data = Papa.parse(file, { header: true, dynamicTyping: true, skipEmptyLines: true }).data;

const scenarios = ["none_moving", "few_moving", "many_moving"];
const nodeCounts = [5, 10, 20, 35, 50];

console.log("Scenario | Nodes | Median RMSE (m) | Median Tx/Node/Min");
console.log("---|---|---|---");

for (const scenario of scenarios) {
    for (const nc of nodeCounts) {
        const subset = data.filter(d => d.scenario === scenario && d.node_count === nc && d.time_s > 100); // Filter stabilization
        if (subset.length === 0) continue;

        const rmses = subset.map(d => d.rmse_aligned_m).sort((a, b) => a - b);
        const medianRmse = rmses[Math.floor(rmses.length / 2)];
        
        const txs = subset.map(d => d.tx_per_node_per_min).sort((a, b) => a - b);
        const medianTx = txs[Math.floor(txs.length / 2)];

        console.log(`${scenario} | ${nc} | ${medianRmse.toFixed(3)} | ${medianTx.toFixed(0)}`);
    }
}
