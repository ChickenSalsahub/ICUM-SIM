
import fs from 'fs';
import Papa from 'papaparse';

const file = fs.readFileSync('public/data/experiments_C_all.csv', 'utf8');
const data = Papa.parse(file, { header: true, dynamicTyping: true, skipEmptyLines: true }).data;

// N=50, many_moving should show activity during 240-300s
const subset = data.filter(d => 
    d.scenario === "many_moving" && 
    d.node_count === 50 && 
    d.time_s >= 200 && 
    d.time_s <= 350
).sort((a, b) => a.time_s - b.time_s);

console.log("Time (s) | Tx Rate");
subset.forEach(d => {
    if (d.time_s % 20 === 0) { // Sample every 20s
        console.log(`${d.time_s} | ${d.tx_per_node_per_min}`);
    }
});
