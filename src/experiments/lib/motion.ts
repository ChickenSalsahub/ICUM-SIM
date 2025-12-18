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
		// Stop nodes if we are past the motion window or just before it starts.
		// We use a small window check to avoid setting velocity 0 every single tick
		// while still ensuring it happens at the transitions even with different dtMs.
		const isAtEnd = tMs >= MOTION_STOP_MS && tMs < MOTION_STOP_MS + 2000;
		const isAtStart = tMs >= MOTION_START_MS - 2000 && tMs < MOTION_START_MS;
		
		if (isAtEnd || isAtStart) {
			for (const id of nodeIds) {
				runner.setNodeVelocity(id, { vx: 0, vy: 0 });
			}
		}
		return;
	}

	const allNodeIds = Array.from(nodeIds).sort((a, b) => a - b);
	const gatewayId = allNodeIds[0]; // Assume first node is gateway
	const candidates = allNodeIds.filter(id => id !== gatewayId);

	// Select how many nodes to move
	let movingCount = 0;
	if (scenario === "few_moving") {
		movingCount = Math.max(1, Math.floor(candidates.length * 0.3));
	} else if (scenario === "many_moving") {
		movingCount = Math.max(1, Math.floor(candidates.length * 0.7));
	}
	
	const movingIds = candidates.slice(0, movingCount);

	const elapsedSec = (tMs - MOTION_START_MS) / 1000;

	for (const id of movingIds) {
		// Circular motion parameters
		const speedCombined = 1.2; // m/s - realistic walking speed
		// Varied radius based on ID so they don't overlap perfectly
		// Tighter radius (1-3m) to keep nodes within their local clusters
		const radius = 1 + (id % 3); 
		const omega = speedCombined / radius; // rad/s

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
