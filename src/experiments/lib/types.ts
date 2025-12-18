import type { SimulationRunner } from "../../engine/SimulationRunner.ts";

/**
 * Motion scenario name used across experiments.
 *
 * Keep these stable: they become CSV values.
 */
export type MotionScenarioName = "none_moving" | "few_moving" | "many_moving";

/**
 * A small helper interface for time-stepped experiments.
 */
export interface TimeSteppedExperimentOptions {
	/** Total simulated duration in seconds. */
	simSeconds: number;
	/** Log/sample period (ms) for CSV rows. */
	logEveryMs: number;
}

/**
 * Shared experiment constants.
 */
export const EXPERIMENT_AREA_SIZE_M = { width: 50, height: 50 } as const;
export const EXPERIMENT_WORLD_BOUNDS_M = {
	minX: 0,
	maxX: EXPERIMENT_AREA_SIZE_M.width,
	minY: 0,
	maxY: EXPERIMENT_AREA_SIZE_M.height,
} as const;

export const MOTION_START_MS = 60_000;
export const MOTION_STOP_MS = 120_000;

export type SeededNode = { id: number; x: number; y: number };

export type RunnerSnapshot = ReturnType<SimulationRunner["snapshot"]>;
