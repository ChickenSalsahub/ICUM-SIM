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
	if (tMs !== MOTION_START_MS && tMs !== MOTION_STOP_MS) return;

	const moving = tMs === MOTION_START_MS;
	const nodeIds = new Set(runner.getNodeIds());
	const setVel = (id: number, v: { vx: number; vy: number }) => {
		if (!nodeIds.has(id)) return;
		runner.setNodeVelocity(id, v);
	};

	// Velocity palette (m/s).
	const palette: Array<{ id: number; v: { vx: number; vy: number } }> = [
		{ id: 2, v: { vx: 0.5, vy: 0.0 } },
		{ id: 3, v: { vx: 0.0, vy: 0.5 } },
		{ id: 4, v: { vx: -0.35, vy: 0.35 } },
		{ id: 5, v: { vx: 0.25, vy: -0.4 } },
		{ id: 6, v: { vx: -0.45, vy: 0.1 } },
		{ id: 7, v: { vx: 0.15, vy: 0.45 } },
		{ id: 8, v: { vx: -0.2, vy: -0.35 } },
	];

	const subset = scenario === "few_moving" ? palette.slice(0, 3) : palette; // 2-4 vs 2-8
	for (const { id, v } of subset) {
		setVel(id, moving ? v : { vx: 0, vy: 0 });
	}
}
