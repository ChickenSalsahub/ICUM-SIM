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
	lambdaDistance: number;
	lambdaAngle: number;
	learningRate: number;
}

export interface FirmwareSnapshot {
	id: number;
	role: string;
	state: "STATIONARY" | "MOVING" | "ISOLATED";
	batteryV: number;
	estPosition: NodePoseEstimate;
	neighbors: NeighborObservation[];
	leaderId: number | null;
	lastAckMs: number;
}
