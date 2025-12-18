import type { SimulationRunner } from "../../engine/SimulationRunner.ts";
import { MOTION_START_MS, MOTION_STOP_MS, type MotionScenarioName } from "./types.ts";

/**
 * Applies the shared motion scenario used across multiple experiments.
 *
 * Design goal:
 * - Create a controlled "burst" of motion between MOTION_START_MS and MOTION_STOP_MS.
 * - Use velocities that are comfortably detectable by the simulator's synthetic IMU.
 *
 * IMPORTANT: We only touch velocities at the motion start/stop boundaries to keep
 * runs deterministic and easy to reason about.
 */
export function applyMotionScenario(runner: SimulationRunner, scenario: MotionScenarioName, tMs: number) {
	if (scenario === "none_moving") return;

	const moving = tMs >= MOTION_START_MS && tMs < MOTION_STOP_MS;
	const nodeIds = new Set(runner.getNodeIds());

	if (!moving) {
		// Only force-stop at the transition boundaries to avoid redundant updates
		if (tMs === MOTION_STOP_MS || tMs === MOTION_START_MS - 1000) {
			for (const id of nodeIds) {
				runner.setNodeVelocity(id, { vx: 0, vy: 0 });
			}
		}
		return;
	}

	// Circular motion parameters
	const speedCombined = 1.2; // m/s - realistic walking speed
	const radius = 5; // meters
	const omega = speedCombined / radius; // rad/s

	const movingIds = scenario === "few_moving" 
		? [2, 3, 4] 
		: [2, 3, 4, 5, 6, 7, 8];

	const elapsedSec = (tMs - MOTION_START_MS) / 1000;

	for (const id of movingIds) {
		if (!nodeIds.has(id)) continue;
		
		// Different phase for each node so they don't move in sync
		const phase = (id * Math.PI) / 4; 
		const angle = phase + omega * elapsedSec;

		const vx = speedCombined * Math.cos(angle);
		const vy = speedCombined * Math.sin(angle);

		// Flip direction for some nodes to add variety
		const dir = id % 2 === 0 ? 1 : -1;
		
		runner.setNodeVelocity(id, { vx: vx * dir, vy: vy * dir });
	}
}
