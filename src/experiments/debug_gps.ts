
import { SimulationRunner } from "../engine/SimulationRunner.ts";
import { PacketType } from "../types/index.ts";

export function runGpsDataTest() {
    console.log("Starting GPS Data Test...");
    let gpsReportFound = false;

    const runner = new SimulationRunner({
        firmwareConfig: {
            gpsCapable: true,
            helloIntervalIdleMs: 100, // Speed up everything
            helloIntervalMovingMs: 100,
        }
    });

    runner.setHooks({
        onTx: (evt) => {
            if (evt.packet.type === PacketType.UPLINK) {
                console.log("Uplink packet detected:", JSON.stringify(evt.packet.payload));
                const payload = evt.packet.payload as any;
                if (payload.reports) {
                    for (const r of payload.reports) {
                        if (r.gpsReport) {
                            console.log("SUCCESS: Found GPS Report:", r.gpsReport);
                            gpsReportFound = true;
                        } else {
                            console.log("Report without GPS:", r);
                        }
                    }
                }
            }
        }
    });

    // Add a single node. It starts STATIONARY.
    // It has no neighbors, so it should eventually go ISOLATED if we tick enough?
    // Wait, isolation happens if `disconnected` (lastAckMs > timeout).
    // Initial state is STATIONARY.
    // It will tick. `lastAckMs` is 0. `now` increases.
    // eventually `now - lastAckMs > isolationNoAckMs`.
    
    // Let's set isolation timeout short.
    runner.addNode(1, { x: 100, y: 100 }, { vx: 0, vy: 0 }, 3.7, true); // LTE capable (so it sends uplinks)

    // Force isolation by manually tweaking config or just waiting.
    // Default isolationNoAckMs is 30_000.
    
    // We need to run for > 30s.
    const steps = 35 * 10; // 35 seconds at 100ms/step
    for (let i = 0; i < steps; i++) {
        runner.step(100);
        if (gpsReportFound) break;
    }

    if (gpsReportFound) {
        console.log("TEST PASSED: GPS Report transmitted.");
    } else {
        console.error("TEST FAILED: No GPS Report found.");
    }
}

runGpsDataTest();
