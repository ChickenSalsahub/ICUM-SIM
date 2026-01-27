export type NodeType = "HARDWARE_GW" | "TRACKER";

export enum NodeRole {
	ROOT = "ROOT",
	LEADER = "LEADER",
	RELAY = "RELAY",
	IDLE = "IDLE",
	ISOLATED = "ISOLATED",
}

export enum PacketType {
	HELLO = "HELLO",
	DATA = "DATA",
	ELECTION = "ELECTION",
	PANIC = "PANIC",
	UPLINK = "UPLINK",
	UWB_BLINK = "UWB_BLINK",
	BLE_ACK = "BLE_ACK",
}

export interface Packet {
	id: string;
	type: PacketType;
	srcId: number;
	destId: number;
	payload: any;
	timestamp: number;
}

export interface VisualPacket {
	id: string;
	packet: Packet;
	x: number;
	y: number;
	startX: number;
	startY: number;
	targetId: number;
	sourceId?: number; // Optional source ID for dynamic link tracking
	progress: number;
	speed: number;
	style: "LINE" | "RING";
	maxRadius?: number;
}

export interface NeighborEntry {
	id: number;
	role: NodeRole;
	battery: number;
	hopsToGw: number;
	lastSeen: number;
	rssi: number;
	leaderId?: number;
	leaderBat?: number;
	degree?: number;
	hasBackhaul?: boolean;
	parentId?: number;
	neighborCount?: number;
	status?: "MOVING" | "STATIONARY";
	// Optional: measured range from UWB simulation (meters)
	rangeMeters?: number;
	aoa?: number; // Angle of Arrival
	aod?: number; // Angle of Departure (sender -> receiver)
	timeOfFlightSeconds?: number; // Measured flight time for diagnostics
}

export interface OdometrySample {
	dx: number; // meters since last sample
	dy: number; // meters since last sample
	dTheta: number; // radians since last sample
	timestamp: number; // milliseconds
}

export interface HardwareInterface {
	// Radio
	radioSend(packet: Packet): void;

	// System
	getTimeMs(): number;
	getRandom(): number; // For backoff
	isMoving(): boolean; // Virtual IMU
	getOdometryMeters?: () => OdometrySample; // Virtual IMU displacement since last tick

	// Debug/Serial
	log(message: string): void;

	// Callbacks (Firmware registers these)
	onRx?: (packet: Packet) => void;
	onTxComplete?: () => void;
}

export interface NodeConfig {
	uwbRange: number;
	isolationTimeout: number;
	movingSpeed: number;
	showRange: boolean;
	maxLeaders: number;
	minClusterSize: number;
}

export interface LogEntry {
	id: string;
	time: string;
	msg: string;
	type: "INFO" | "SUCCESS" | "WARN" | "ERROR";
	category: "CLOUD" | "PACKET" | "SYS";
}

// --- NEW: WALLS ---
export interface Wall {
	id: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

// Ranging types
export interface RangingResult {
	success: boolean; // whether ranging succeeded (in-range & LOS)
	trueDistanceMeters: number; // true geometric distance
	measuredDistanceMeters: number; // measured distance including noise
	timeOfFlightSeconds?: number; // simulated TOF
	aoa?: number; // Angle of Arrival in radians (relative to receiver's heading)
	aod?: number; // Angle of Departure in radians (relative to sender's heading)
	los: boolean; // line-of-sight
	error?: string;
}

export interface RangingOptions {
	pixelsPerMeter: number;
	maxRangeMeters: number;
	walls?: Wall[];
}

export interface RangingEngine {
	measure: (
		sender: { id: number; x: number; y: number },
		receiver: { id: number; x: number; y: number },
		opts: RangingOptions,
	) => RangingResult;
}
