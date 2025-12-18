
import { runExperimentAScenariosWithOptions } from "./src/experiments/experiments/experimentA.ts";

const scenarios = ["none_moving", "few_moving", "many_moving"];
const rows = runExperimentAScenariosWithOptions({ uwbNoiseSigma: 0.1 });

// Group by scenario and check last state
for (const scenario of scenarios) {
    const scenarioRows = rows.filter(r => r.scenario === scenario);
        const lastRow = scenarioRows[scenarioRows.length - 1];
    
    console.log(`Scenario: ${scenario}`);
    console.log(`  Initial Baseline RMSE Aligned: ${scenarioRows[0].baselineRmseAligned.toFixed(3)}`);
    console.log(`  Final Baseline RMSE Aligned:   ${lastRow.baselineRmseAligned.toFixed(3)}`);
    console.log(`  Initial ETM RMSE Aligned:      ${scenarioRows[0].etmRmseAligned.toFixed(3)}`);
    console.log(`  Final ETM RMSE Aligned:        ${lastRow.etmRmseAligned.toFixed(3)}`);
    
    // Find the peak RMSE during motion (between 60s and 120s)
    const motionRows = scenarioRows.filter(r => r.timeSeconds >= 60 && r.timeSeconds <= 120);
    const peakBaseline = Math.max(...motionRows.map(r => r.baselineRmseAligned));
    console.log(`  Peak Baseline RMSE during motion: ${peakBaseline.toFixed(3)}`);

    // Let's run a custom simulation to inspect the nodes at the end
    if (scenario === "many_moving" || scenario === "none_moving") {
        const { SimulationRunner } = await import("./src/engine/SimulationRunner.ts");
        const { applyMotionScenario } = await import("./src/experiments/lib/motion.ts");
        const { seedNodes, makeSeed, seededRng } = await import("./src/experiments/lib/seed.ts");
        const { EXPERIMENT_WORLD_BOUNDS_M } = await import("./src/experiments/lib/types.ts");
        
        const baseline = new SimulationRunner({
            uwbNoiseSigma: 0.1,
            uwbRangeMeters: 15,
            packetLoss: 0.1,
            worldBounds: EXPERIMENT_WORLD_BOUNDS_M,
            seed: 101,
            firmwareConfig: {
                eventDrivenSensing: false,
                helloIntervalMovingMs: 500,
                helloIntervalIdleMs: 500,
                rangingIntervalMovingMs: 500,
                rangingIntervalIdleMs: 500,
                neighborTimeoutMs: 5_000,
                learningRate: 0.8,
            },
        });
        const layout = makeSeed(10, seededRng(101));
        seedNodes(baseline, layout);

        const simSeconds = 600;
        const logEveryMs = 1_000;
        for (let t = 0; t <= simSeconds * 1000; t += logEveryMs) {
            applyMotionScenario(baseline, scenario as any, t);
            baseline.step(logEveryMs);
        }

        const finalSnap = baseline.snapshot();
        console.log(`  Final Node States (${scenario}):`);
        for (const n of finalSnap.nodes) {
            const neighbors = n.firmware.neighbors.length;
            const state = n.firmware.state;
            const truePos = { x: n.trueX, y: n.trueY };
            const estPos = n.firmware.estPosition;
            const err = Math.sqrt((estPos.x - truePos.x)**2 + (estPos.y - truePos.y)**2);
            console.log(`    Node ${n.id}: state=${state}, neighbors=${neighbors}, err=${err.toFixed(2)}m at (${truePos.x.toFixed(1)}, ${truePos.y.toFixed(1)})`);
        }

        console.log(`  Distance Matrix (${scenario}):`);
        const nodes = finalSnap.nodes;
        for (let i = 0; i < nodes.length; i++) {
            let row = `    Node ${nodes[i].id}: `;
            for (let j = 0; j < nodes.length; j++) {
                const dist = Math.sqrt((nodes[i].trueX - nodes[j].trueX)**2 + (nodes[i].trueY - nodes[j].trueY)**2);
                if (i === j) row += "  -  ";
                else if (dist > 15) row += ` [${dist.toFixed(0)}] `;
                else row += `  ${dist.toFixed(0)}  `;
            }
            console.log(row);
        }
    }
}
