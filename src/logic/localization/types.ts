import { Pose2D } from "../math/VectorUtils";

export interface IGlobalPosition {
	lat: number;
	lng: number;
	alt?: number;
}

export interface IRangeMeasurement {
	peerId: number;
	range: number; // meters
	aoa?: number; // Angle of Arrival in radians
	stdDev?: number; // measurement uncertainty
	timestamp: number;
}

export interface IOdometryMeasurement {
	dx: number; // meters
	dy: number; // meters
	dTheta: number; // radians
	timestamp: number;
}

export interface INodeState {
	id: number;
	pose: Pose2D;
	isAnchor: boolean;
	globalPos?: IGlobalPosition;
	lastUpdate: number;
}
