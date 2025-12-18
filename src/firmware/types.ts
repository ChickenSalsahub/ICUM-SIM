import { Packet } from "../types";

export interface Vector3 {
	x: number;
	y: number;
	z: number;
}

export interface ImuSample {
	accel: Vector3; // m/s^2
	gyro: Vector3; // rad/s
}

export interface NeighborObservation {
	id: number;
	rangeMeters: number;
	angleRad?: number; // bearing from self -> neighbor
	timestamp: number;
}

export interface NodePoseEstimate {
	x: number;
	y: number;
}

export interface INodeHAL {
	// Inputs (from world -> firmware)
	getIMU(): ImuSample;
	pollRadio(): Packet[]; // returns packets currently in the RX buffer
	getBatteryVoltage(): number; // volts
	getTimeMs(): number;

	// Outputs (from firmware -> world)
	radioSend(packet: Packet): void;
	log(msg: string): void;
}

export interface FirmwareConfig {
	accelMoveThresholdG: number;
	isolationNoAckMs: number;
	neighborTimeoutMs: number;
	// ICUM sensing policy: when enabled, stationary+stable nodes avoid periodic ranging
	// and only range on IMU/topology events (with an optional maintenance interval).
	eventDrivenSensing?: boolean;
	// HELLO cadence controls (ms). If unset, firmware defaults are used.
	helloIntervalMovingMs?: number;
	helloIntervalIdleMs?: number;
	// Ranging cadence controls (ms). If unset, firmware defaults are used.
	rangingIntervalMovingMs?: number;
	rangingIntervalIdleMs?: number;
	// When eventDrivenSensing is enabled, allow an optional very-slow maintenance poll.
	// Set to 0 or undefined to disable.
	rangingMaintenanceMs?: number;
	lambdaDistance: number;
	lambdaAngle: number;
	learningRate: number;
}

export interface FirmwareSnapshot {
	id: number;
	role: string;
	state: "STATIONARY" | "MOVING" | "ISOLATED";
	lteCapable?: boolean;
	batteryV: number;
	estPosition: NodePoseEstimate;
	neighbors: NeighborObservation[];
	leaderId: number | null;
	lastAckMs: number;
}
