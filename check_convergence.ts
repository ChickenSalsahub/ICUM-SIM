
import fs from 'fs';
import Papa from 'papaparse';

const file = fs.readFileSync('public/data/experiments_C_all.csv', 'utf8');
const data = Papa.parse(file, { header: true, dynamicTyping: true, skipEmptyLines: true }).data;

// Analyze N=50, many_moving around the 300s mark
const subset = data.filter((d: any) => 
    d.scenario === "many_moving" && 
    d.node_count === 50 && 
    d.time_s >= 280 && 
    d.time_s <= 400
).sort((a: any, b: any) => a.time_s - b.time_s);

console.log("Time | RMSE | Tx Rate");
subset.forEach((d: any) => {
    if (d.time_s % 10 === 0) {
        console.log(`${d.time_s} | ${d.rmse_aligned_m.toFixed(4)} | ${d.tx_per_node_per_min.toFixed(1)}`);
    }
});
