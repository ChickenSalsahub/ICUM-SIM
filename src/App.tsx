// @ts-ignore
declare module "react-plotly.js";

import React, { useState, useEffect, useCallback, useRef } from "react";

import {
	Play,
	Pause,
	Wifi,
	Activity,
	Plus,
	Trash2,
	Zap,
	Database,
	XCircle,
	Search,
	Radio,
	MessageSquare,
	Scale,
	TrendingDown,
	BrickWall,
	Wrench,
	NotebookPen,
} from "lucide-react";
import { AnalysisDashboard } from "./components/AnalysisDashboard";
import { CloudBackend, type CloudBackendOptions, type CloudEvent, FusedRecord } from "./logic/CloudBackend";
import { computeCloudStructureStatsMeters } from "./logic/metrics/CloudTopologyMetrics";
import { DraggableWindow } from "./components/DraggableWindow";
import { NodeConfig, NodeRole, NodeType, Packet, PacketType, VisualPacket, Wall } from "./types";
import { SimulationRunner } from "./engine/SimulationRunner";
import type { FirmwareConfig, NeighborObservation } from "./firmware/types";
import { createRollingMeanConvergenceTracker } from "./experiments/lib/convergence";
import { getLatestPerNode, NodeLocation, updateEKFCanvasState, buildRelativePositions, EKFCanvas } from "./kalman"
import { number } from "mathjs";

const PIXELS_PER_METER = 20;
// Convergence tracker instance (cloud backend)
const cloudConvergenceTracker = createRollingMeanConvergenceTracker({
	samplePeriodMs: 1000,
	windowMs: 30_000,
	stableDelta: 0.05,
	stableHoldMs: 5_000,
});

function computeCloudConvergence(fusedRecords: import("./logic/CloudBackend").FusedRecord[], cloudStats: any) {
	// Build RMSE history from fused records
	const rmseHistory: Array<{ t: number; v: number }> = [];
	for (const r of fusedRecords) {
		if (typeof r.position?.x === "number" && typeof r.position?.y === "number") {
			const t = r.timestamp;
			const v = cloudStats?.aligned.rmse ?? NaN;
			rmseHistory.push({ t, v });
		}
	}
	// Feed the tracker with the latest N samples (simulate time progression)
	for (const pt of rmseHistory.slice(-40)) cloudConvergenceTracker.update(pt.t, pt.v);
	const state = cloudConvergenceTracker.getState();
	return {
		converged: state.convergenceStableMs !== undefined,
		convergenceText: state.convergenceStableMs !== undefined ? "CONVERGED" : "NOT CONVERGED",
		convergenceColor: state.convergenceStableMs !== undefined ? "#4ade80" : "#f87171",
	};
}
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 800;

// Keep UI arena consistent with experiment bounds (0..50m in both axes).
const ARENAHEADER = "Arena (50m × 30m)";
const OFFSET_X_PX = 60; // Increased to make room for axis labels
const OFFSET_Y_PX = 60;
const WORLD_BOUNDS_M = { minX: 0, maxX: 50, minY: 0, maxY: 30 };
const WORLD_BOUNDS_PX = {
	minX: WORLD_BOUNDS_M.minX * PIXELS_PER_METER + OFFSET_X_PX,
	maxX: WORLD_BOUNDS_M.maxX * PIXELS_PER_METER + OFFSET_X_PX,
	minY: WORLD_BOUNDS_M.minY * PIXELS_PER_METER + OFFSET_Y_PX,
	maxY: WORLD_BOUNDS_M.maxY * PIXELS_PER_METER + OFFSET_Y_PX,
};

type Pose2D = { x: number; y: number; theta: number };

type UiGlobalPosition = { lat: number; lng: number; alt?: number };

class UiNode {
	public id: number;
	public type: NodeType;
	public x: number;
	public y: number;
	public spawnX: number;
	public spawnY: number;
	public targetX: number;
	public targetY: number;
	public battery: number;
	public role: NodeRole = NodeRole.IDLE;
	// User-controlled motion mode (drives velocity in the engine).
	public motionMode: "MOVING" | "STATIONARY" = "STATIONARY";
	// Firmware-reported state (derived from IMU/connectivity).
	public firmwareState: "MOVING" | "STATIONARY" | "ISOLATED" = "STATIONARY";
	public nextHop: number | null = null;
	public neighbors: Map<number, any> = new Map();

	// UI-only flags
	public isDragging = false;
	public isGossiping = false;
	public isElecting = false;
	public isolationTimer = 0;
	public orbitCenterX: number;
	public orbitCenterY: number;
	public orbitRadiusM: number;
	public orbitAngleRad: number;
	public orbitAngularSpeedRadPerSec: number;
	public orbitDirection: 1 | -1;
	public wanderHeadingRad: number;
	public wanderTurnRateRadPerSec: number;
	public wanderSpeedMps: number;
	public wanderChangeTimerMs: number;
	public wanderChangeIntervalMs: number;

	public globalPos: UiGlobalPosition | null = null;
	private localGraph: Map<number, Pose2D> = new Map();
	private estLocal: { x: number; y: number } | null = null;

	constructor(id: number, type: NodeType, x: number, y: number) {
		this.id = id;
		this.type = type;
		this.x = x;
		this.y = y;
		this.spawnX = x;
		this.spawnY = y;
		this.targetX = x;
		this.targetY = y;
		this.battery = 100;
		this.orbitCenterX = x;
		this.orbitCenterY = y;
		this.orbitRadiusM = 1.5;
		this.orbitAngleRad = 0;
		this.orbitAngularSpeedRadPerSec = 0;
		this.orbitDirection = 1;
		this.wanderHeadingRad = Math.random() * Math.PI * 2;
		this.wanderTurnRateRadPerSec = (Math.random() * 2 - 1) * 0.6;
		this.wanderSpeedMps = 1.0;
		this.wanderChangeIntervalMs = 4_000;
		this.wanderChangeTimerMs = Math.random() * this.wanderChangeIntervalMs;
	}

	public toggleMode() {
		this.motionMode = this.motionMode === "MOVING" ? "STATIONARY" : "MOVING";
		if (this.motionMode === "MOVING") {
			this.wanderHeadingRad = Math.random() * Math.PI * 2;
			this.wanderTurnRateRadPerSec = (Math.random() * 2 - 1) * 0.8;
			this.wanderSpeedMps = 0.6 + Math.random() * 0.8;
			this.wanderChangeIntervalMs = 2_000 + Math.random() * 4_000;
			this.wanderChangeTimerMs = this.wanderChangeIntervalMs;
		}
	}

	public setGlobalPosition(lat: number, lng: number) {
		this.globalPos = { lat, lng };
	}

	public getEstimatedGlobalPosition() {
		return this.globalPos;
	}

	public getEstimatedLocalPosition() {
		return this.estLocal;
	}

	public getLocalGraph() {
		return this.localGraph;
	}

	public updateFromEngine(opts: {
		engineTimeMs?: number;
		firmwareRole?: string;
		firmwareState?: "STATIONARY" | "MOVING" | "ISOLATED";
		estPosition?: { x: number; y: number };
		neighbors?: Array<{ id: number; rangeMeters: number; angleRad?: number; timestamp?: number }>;
	}) {
		// Role semantics: keep HARDWARE_GW as ROOT for UI coloring.
		if (this.type === "HARDWARE_GW") {
			this.role = NodeRole.ROOT;
		} else {
			const r = opts.firmwareRole;
			this.role =
				r === "LEADER"
					? NodeRole.LEADER
					: r === "RELAY"
						? NodeRole.RELAY
						: r === "ISOLATED"
							? NodeRole.ISOLATED
							: NodeRole.IDLE;
		}

		if (opts.firmwareState) this.firmwareState = opts.firmwareState;
		if (opts.estPosition) this.estLocal = { ...opts.estPosition };

		// Build a minimal local graph for the ghost overlay:
		// self at its firmware-estimated pose, neighbors placed via range+bearing in the same frame.
		// This makes the (0,0) origin marker meaningful again.
		this.localGraph = new Map();
		const selfPose: Pose2D = {
			x: opts.estPosition?.x ?? 0,
			y: opts.estPosition?.y ?? 0,
			theta: 0,
		};
		this.localGraph.set(this.id, selfPose);
		const engineNow = opts.engineTimeMs;
		const staleAfterMs = 2_000;
		const freshNeighbors = (opts.neighbors ?? []).filter((n) => {
			if (engineNow === undefined || n.timestamp === undefined) return true;
			return engineNow - n.timestamp <= staleAfterMs;
		});

		this.neighbors = new Map();
		for (const n of freshNeighbors) {
			const angle = n.angleRad ?? 0;
			const nx = selfPose.x + Math.cos(angle) * n.rangeMeters;
			const ny = selfPose.y + Math.sin(angle) * n.rangeMeters;
			this.localGraph.set(n.id, {
				x: nx,
				y: ny,
				theta: 0,
			});
			this.neighbors.set(n.id, {
				id: n.id,
				role: NodeRole.IDLE,
				battery: 0,
				hopsToGw: 999,
				lastSeen: Date.now(),
				rssi: -60,
				rangeMeters: n.rangeMeters,
				aoa: n.angleRad,
			});
		}
	}
}

interface Link {
	source: UiNode;
	target: UiNode;
	dist: number;
}

const doIntersect = (
	p1: { x: number; y: number },
	q1: { x: number; y: number },
	p2: { x: number; y: number },
	q2: { x: number; y: number },
) => {
	const orientation = (p: any, q: any, r: any) => {
		const val = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
		if (val === 0) return 0;
		return val > 0 ? 1 : 2;
	};
	const o1 = orientation(p1, q1, p2);
	const o2 = orientation(p1, q1, q2);
	const o3 = orientation(p2, q2, p1);
	const o4 = orientation(p2, q2, q1);
	if (o1 !== o2 && o3 !== o4) return true;
	return false;
};

// Note: absolute error metrics are only meaningful if the cloud solution is anchored to the world.
// For anchor-free topology, prefer the aligned and pairwise-distance metrics below.

const App: React.FC = () => {
	const [viewMode, setViewMode] = useState<"SIM" | "ANALYSIS">("SIM");
	const [nodes, setNodes] = useState<UiNode[]>([]);
	const [links, setLinks] = useState<Link[]>([]);

	const [packets, setPackets] = useState<Packet[]>([]);
	const [visualPackets, setVisualPackets] = useState<VisualPacket[]>([]);
	const [fusedRecordsBaseline, setFusedRecordsBaseline] = useState<FusedRecord[]>([]);
	const [cloudEventsBaseline, setCloudEventsBaseline] = useState<CloudEvent[]>([]);

	const fusedRecords = fusedRecordsBaseline;
	const cloudEvents = cloudEventsBaseline;

	const [walls, setWalls] = useState<Wall[]>([]);
	const [isDrawingWall, setIsDrawingWall] = useState(false);
	const [wallStart, setWallStart] = useState<{ x: number; y: number } | null>(null);
	const [wallEnd, setWallEnd] = useState<{ x: number; y: number } | null>(null);

	const [energyHistory, setEnergyHistory] = useState<number[]>(new Array(50).fill(100));

	const [showCloudLogs, setShowCloudLogs] = useState(false);
	const [showPacketSniffer, setShowPacketSniffer] = useState(false);
	const [showBatteryMonitor, setShowBatteryMonitor] = useState(false);
	const [showFilterConfiguration, setShowFilterConfiguration] = useState(false);
	const [cloudViewMode, setCloudViewMode] = useState<"RAW" | "DATA" | "TOPOLOGY">("TOPOLOGY");

	const [packetFilter, setPacketFilter] = useState<string>("ALL");
	const [tick, setTick] = useState(0);
	const [isPlaying, setIsPlaying] = useState(true);
	const ekfTimeRef = useRef<number>(0);

	const exportSnifferPackets = useCallback(() => {
		const filtered = packets.filter((p) => packetFilter === "ALL" || p.type === packetFilter);
		const header = ["timestamp", "type", "payloadType", "srcId", "destId", "payload"].join(",");
		const csvEscape = (v: unknown) => {
			const s = String(v ?? "");
			return `"${s.replace(/"/g, '""')}"`;
		};
		const rows = filtered.map((p) => {
			const payloadType =
				p.type === PacketType.DATA && p.payload && typeof p.payload === "object" && "type" in p.payload
					? String((p.payload as { type?: unknown }).type ?? "DATA")
					: "";
			return [
				csvEscape(p.timestamp),
				csvEscape(p.type),
				csvEscape(payloadType),
				csvEscape(p.srcId),
				csvEscape(p.destId),
				csvEscape(JSON.stringify(p.payload ?? null)),
			].join(",");
		});

		const csv = [header, ...rows].join("\n");
		const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		a.href = url;
		a.download = `packet-sniffer_${packetFilter}_${ts}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	}, [packets, packetFilter]);

	const [config, setConfig] = useState<NodeConfig>({
		uwbRange: 15,
		isolationTimeout: 5,
		movingSpeed: 0.4,
		showRange: false,
		maxLeaders: 1,
		minClusterSize: 5,
	});

	const [simTuning, setSimTuning] = useState({
		uwbNoiseSigmaMeters: 0.0,
		uwbAngleNoiseStdDeg: 0.0,
		packetLoss: 0.0,
	});

	const [firmwareTuning, setFirmwareTuning] = useState<FirmwareConfig>({
		accelMoveThresholdG: 0.5,
		isolationNoAckMs: 30_000,
		neighborTimeoutMs: 20_000,
		eventDrivenSensing: true,
		helloIntervalMovingMs: 1_000,
		helloIntervalIdleMs: 10_000,
		rangingIntervalMovingMs: 1_000,
		rangingIntervalIdleMs: 10_000,
		rangingMaintenanceMs: 0,
		lambdaDistance: 1.0,
		lambdaAngle: 0.5,
		learningRate: 0.2,
	});
	const isEventDriven = firmwareTuning.eventDrivenSensing !== false;

	const [cloudTuning, setCloudTuning] = useState<CloudBackendOptions>({
		distanceSigma: 0.15,
		angleSigma: (20 * Math.PI) / 180,
		warmupIterations: 15,
		finalIterations: 50,
		pruneClusterAfterMs: 60_000,
	});

	const nodesRef = useRef<UiNode[]>([]);
	const runnerRef = useRef<SimulationRunner | null>(null);
	const cloudBackendBaselineRef = useRef<CloudBackend>(new CloudBackend({ ...cloudTuning, mode: "passive" }));
	const visualPacketsRef = useRef<VisualPacket[]>([]);
	const wallsRef = useRef<Wall[]>([]);
	const animationRef = useRef<number | undefined>(undefined);
	const lastTimeRef = useRef<number>(0);
	const energyTimerRef = useRef<number>(0);
	const lastCloudTickRef = useRef<number>(0);
	const simNowMsRef = useRef<number>(0);

	const [uplinkStats, setUplinkStats] = useState({
		totalBatches: 0,
		totalReports: 0,
		lastSenderId: -1,
		lastBatchSize: 0,
		lastUplinkTimeMs: 0,
	});

	const [openWindows, setOpenWindows] = useState<number[]>([]);
	const [windowOrder, setWindowOrder] = useState<number[]>([]);
	const draggedNodeIdRef = useRef<number | null>(null);
	const dragStartPosRef = useRef({ x: 0, y: 0 });
	const dragOffsetRef = useRef({ x: 0, y: 0 });
	const svgRef = useRef<SVGSVGElement>(null);

	const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: number } | null>(null);

	const ensureRunner = useCallback(() => {
		if (runnerRef.current) return runnerRef.current;
		const runner = new SimulationRunner({
			uwbRangeMeters: config.uwbRange,
			uwbNoiseSigma: simTuning.uwbNoiseSigmaMeters,
			uwbAngleNoiseStdRad: (simTuning.uwbAngleNoiseStdDeg * Math.PI) / 180,
			packetLoss: simTuning.packetLoss,
			firmwareConfig: firmwareTuning,
			worldBounds: WORLD_BOUNDS_M,
		});
		runnerRef.current = runner;
		return runner;
	}, [
		config.uwbRange,
		simTuning.packetLoss,
		simTuning.uwbAngleNoiseStdDeg,
		simTuning.uwbNoiseSigmaMeters,
		firmwareTuning,
	]);

	const applyFirmwareTuning = useCallback(
		(override?: FirmwareConfig) => {
			// Firmware config only applies at node creation time. Rebuild the runner and re-add nodes.
			const prevNodes = nodesRef.current;
			const fwCfg = override ?? firmwareTuning;
			const runner = new SimulationRunner({
				uwbRangeMeters: config.uwbRange,
				uwbNoiseSigma: simTuning.uwbNoiseSigmaMeters,
				uwbAngleNoiseStdRad: (simTuning.uwbAngleNoiseStdDeg * Math.PI) / 180,
				packetLoss: simTuning.packetLoss,
				firmwareConfig: fwCfg,
				worldBounds: WORLD_BOUNDS_M,
			});
			runnerRef.current = runner;
			for (const n of prevNodes) {
				runner.addNode(
					n.id,
					{ x: (n.x - OFFSET_X_PX) / PIXELS_PER_METER, y: (n.y - OFFSET_Y_PX) / PIXELS_PER_METER },
					{ vx: 0, vy: 0 },
					3.7,
					n.type === "HARDWARE_GW",
				);
			}
		},
		[
			config.uwbRange,
			firmwareTuning,
			simTuning.packetLoss,
			simTuning.uwbAngleNoiseStdDeg,
			simTuning.uwbNoiseSigmaMeters,
		],
	);

	const applyCloudTuning = useCallback(() => {
		cloudBackendBaselineRef.current = new CloudBackend({ ...cloudTuning, mode: "passive" });
		setFusedRecordsBaseline([]);
		setCloudEventsBaseline([]);
	}, [cloudTuning]);

	useEffect(() => {
		nodesRef.current = nodes;
	}, [nodes]);
	useEffect(() => {
		wallsRef.current = walls;
	}, [walls]);

	useEffect(() => {
		const initial: UiNode[] = [];
		setNodes(initial);
		nodesRef.current = initial;
	}, []);

	const capturePacket = useCallback((p: Packet) => {
		setPackets((prev) => [p, ...prev].slice(0, 50));
	}, []);

	const ingestUplinkToCloud = useCallback(
		(opts: { packet: Packet; senderId: number; senderPos: { x: number; y: number }; nowMs: number }) => {
			const { packet, senderId, senderPos, nowMs } = opts;
			if (packet.type !== PacketType.UPLINK) return;
			if (!packet.payload || typeof packet.payload !== "object") return;
			if ((packet.payload as { type?: unknown }).type !== "UPLINK_BATCH") return;
			const reports = (packet.payload as { reports?: unknown }).reports;
			if (!Array.isArray(reports) || reports.length === 0) return;

			setUplinkStats((prev) => ({
				totalBatches: prev.totalBatches + 1,
				totalReports: prev.totalReports + reports.length,
				lastSenderId: senderId,
				lastBatchSize: reports.length,
				lastUplinkTimeMs: nowMs,
			}));

			const baselineCloud = cloudBackendBaselineRef.current;
			let recordedBackendEvents = false;

			const rawEvents = (packet.payload as { events?: unknown }).events;
			if (Array.isArray(rawEvents)) {
				for (const raw of rawEvents) {
					if (!raw || typeof raw !== "object") continue;
					const e = raw as any;
					const timestamp = Number(e.timestamp);
					if (!Number.isFinite(timestamp)) continue;
					const kind = typeof e.kind === "string" ? e.kind : "EVENT";
					const level = e.level === "WARN" || e.level === "ERROR" ? e.level : "INFO";
					const nodeId = Number(e.nodeId);
					baselineCloud.recordEvent({
						timestamp,
						level,
						kind,
						nodeId: Number.isFinite(nodeId) ? nodeId : undefined,
						message: typeof e.message === "string" ? e.message : String(e.message ?? kind),
					});
					recordedBackendEvents = true;
				}
			}

			for (const raw of reports) {
				if (!raw || typeof raw !== "object") continue;
				const r = raw as any;
				const nodeId = Number(r.nodeId);
				if (!Number.isFinite(nodeId)) continue;

				const neighborsRaw = r.neighbors;
				const neighbors = Array.isArray(neighborsRaw)
					? neighborsRaw
							.map((n: any) => ({
								id: Number(n?.id),
								range: Number(n?.range),
								aoa: n?.aoa,
							}))
							.filter((n: any) => Number.isFinite(n.id) && Number.isFinite(n.range))
					: [];

				const currentNodeGlobalPos = nodesRef.current.find((n) => n.id === nodeId)?.globalPos

				const report: any = {
					nodeId,
					timestamp: nowMs,
					battery: Number(r.batteryV ?? 0),
					status: r.status === "MOVING" ? "MOVING" : "STATIONARY",
					estX: Number.isFinite(r.estX) ? r.estX : undefined,
					estY: Number.isFinite(r.estY) ? r.estY : undefined,
					lat: currentNodeGlobalPos ? currentNodeGlobalPos?.lat : undefined,
					lng: currentNodeGlobalPos ? currentNodeGlobalPos?.lng : undefined,
					neighbors,
				};

				// Anchor only when the uplink sender is also the origin and is LTE-capable.
				// This is the "supernode" concept in the cloud solver.
				if (Boolean(r.lteCapable) && nodeId === senderId) {
					report.x = senderPos.x;
					report.y = senderPos.y;
				}

				baselineCloud.ingest(report);

			}

			if (recordedBackendEvents) {
				setCloudEventsBaseline([...baselineCloud.getEvents()]);
			}

			const nodeLocations: Record<string, NodeLocation> = (getLatestPerNode(baselineCloud.db)[0].positions)
			const originNode = (getLatestPerNode(baselineCloud.db)[0])

			if (originNode.origin) {
				let locations: NodeLocation[] = [];
				for (const node of Object.entries(nodeLocations)) {
					locations.push({
						nodeId: parseInt(node[0]), 
						kalmanLat: node[1].kalmanLat, 
						kalmanLng: node[1].kalmanLng, 
						lat: node[1].lat, 
						lng: node[1].lng
					})
				}

				const now = performance.now();
				if ((now - ekfTimeRef.current) > 1100) {
					ekfTimeRef.current = now;
					updateEKFCanvasState(
						locations, 
						originNode.origin.lat,
						originNode.origin.lng
					);
				}
			}
		},
		[],
	);

	const gameLoop = useCallback(
		(timestamp: number) => {
			if (!lastTimeRef.current) lastTimeRef.current = timestamp;
			if (!lastTimeRef.current) lastTimeRef.current = timestamp;
			const deltaTime = (timestamp - lastTimeRef.current) / 1000;
			lastTimeRef.current = timestamp;

			if (!isPlaying) {
				animationRef.current = requestAnimationFrame(gameLoop);
				return;
			}

			const currentNodes = nodesRef.current;
			const currentWalls = wallsRef.current;
			const rangePx = config.uwbRange * PIXELS_PER_METER;

			// 1. VISUAL PACKETS
			let newVisuals = visualPacketsRef.current
				.map((vp) => {
					vp.progress += vp.speed * deltaTime;

					if (vp.style === "LINE") {
						const targetNode = currentNodes.find((n) => n.id === vp.targetId);
						const sourceNode = currentNodes.find((n) => n.id === vp.sourceId);

						let sx = vp.startX;
						let sy = vp.startY;
						let tx = vp.x; // default to prev
						let ty = vp.y;

						// If source exists, track its current position for sliding link effect
						if (sourceNode) {
							sx = sourceNode.x;
							sy = sourceNode.y;
						}

						if (targetNode) {
							// Interpolate between current source and current target
							tx = sx + (targetNode.x - sx) * vp.progress;
							ty = sy + (targetNode.y - sy) * vp.progress;
						} else {
							// Fallback if target is gone
							tx = sx + (vp.x - vp.startX) * vp.progress;
						}

						vp.x = tx;
						vp.y = ty;
						// ANCHOR IMPLEMENTATION
						if(sourceNode?.globalPos && targetNode?.motionMode == "MOVING") {
							//console.log(sourceNode, targetNode)
							const dist = Math.sqrt((sourceNode.x - targetNode.x)**2+(sourceNode.y - targetNode.y)**2) / PIXELS_PER_METER

							let AoA = Array.from(sourceNode.neighbors.values()).find(node => node.id === targetNode.id)?.aoa ?? 0;

							const sourceLat = sourceNode.globalPos.lat * Math.PI / 180
							const sourceLng = sourceNode.globalPos.lng * Math.PI / 180
							const delta = dist / 6371000

							const targetLat = (Math.asin(Math.sin(sourceLat) * Math.cos(delta) + Math.cos(sourceLat) * Math.sin(delta) * Math.cos(AoA))) * 180 / Math.PI
							const targetLng = (sourceLng + Math.atan2(Math.sin(AoA) * Math.sin(delta) * Math.cos(sourceLat), Math.cos(delta) - Math.sin(sourceLat) * Math.sin(targetLat)))  * 180 / Math.PI

							targetNode.setGlobalPosition(targetLat, targetLng)
						}
						
						// Check wall intersection
						for (const w of currentWalls) {
							if (doIntersect({ x: sx, y: sy }, { x: vp.x, y: vp.y }, { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 })) {
								return null;
							}
						}
					} else if (vp.style === "RING") {
						const sourceNode = currentNodes.find((n) => n.id === vp.sourceId);
						if (sourceNode) {
							vp.x = sourceNode.x;
							vp.y = sourceNode.y;
						}
					}
					return vp;
				})
				.filter((vp): vp is VisualPacket => vp !== null && vp.progress < 1.0);

			// 2. ENGINE STEP (physics + firmware + RF)
			const runner = ensureRunner();
			runner.setUwbRangeMeters(config.uwbRange);
			runner.setPacketLoss(simTuning.packetLoss);
			runner.setUwbNoiseSigma(simTuning.uwbNoiseSigmaMeters);
			runner.setUwbAngleNoiseStdRad((simTuning.uwbAngleNoiseStdDeg * Math.PI) / 180);
			runner.setWalls(
				currentWalls.map((w) => ({
					...w,
					x1: (w.x1 - OFFSET_X_PX) / PIXELS_PER_METER,
					y1: (w.y1 - OFFSET_Y_PX) / PIXELS_PER_METER,
					x2: (w.x2 - OFFSET_X_PX) / PIXELS_PER_METER,
					y2: (w.y2 - OFFSET_Y_PX) / PIXELS_PER_METER,
				})),
			);

			runner.setHooks({
				onTx: ({ timeMs, senderId, packet, senderPos }) => {
					capturePacket(packet);
					ingestUplinkToCloud({ packet, senderId, senderPos, nowMs: timeMs });
					if (packet.type === PacketType.PANIC) {
						const baselineCloud = cloudBackendBaselineRef.current;
						baselineCloud.recordPanic({ timestamp: timeMs, nodeId: senderId });
						setCloudEventsBaseline([...baselineCloud.getEvents()]);
					}
					if (packet.destId === -1) {
						newVisuals.push({
							id: Math.random().toString(),
							packet,
							x: senderPos.x * PIXELS_PER_METER + OFFSET_X_PX,
							y: senderPos.y * PIXELS_PER_METER + OFFSET_Y_PX,
							startX: senderPos.x * PIXELS_PER_METER + OFFSET_X_PX,
							startY: senderPos.y * PIXELS_PER_METER + OFFSET_Y_PX,
							targetId: -1,
							progress: 0,
							speed: packet.type === PacketType.DATA ? 2.5 : 2.0,
							style: "RING",
							maxRadius: rangePx,
							sourceId: senderId,
						});
					}
				},
				onDeliver: ({ packet, senderId, recipientId, senderPos }) => {
					if (packet.destId !== -1) {
						newVisuals.push({
							id: Math.random().toString(),
							packet,
							x: senderPos.x * PIXELS_PER_METER + OFFSET_X_PX,
							y: senderPos.y * PIXELS_PER_METER + OFFSET_Y_PX,
							startX: senderPos.x * PIXELS_PER_METER + OFFSET_X_PX,
							startY: senderPos.y * PIXELS_PER_METER + OFFSET_Y_PX,
							targetId: recipientId,
							progress: 0,
							speed: 2.5,
							style: "LINE",
							sourceId: packet.srcId,
						});
						return;
					}

					if (packet.payload?.type === "RANGING_POLL") {
						newVisuals.push({
							id: Math.random().toString(),
							packet,
							x: senderPos.x * PIXELS_PER_METER + OFFSET_X_PX,
							y: senderPos.y * PIXELS_PER_METER + OFFSET_Y_PX,
							startX: senderPos.x * PIXELS_PER_METER + OFFSET_X_PX,
							startY: senderPos.y * PIXELS_PER_METER + OFFSET_Y_PX,
							targetId: recipientId,
							progress: 0,
							speed: 2.5,
							style: "LINE",
							sourceId: senderId,
						});
					}
				},
			});

			// Drive desired motion via velocities; engine integrates true position.
			let totalBat = 0;
			for (const node of currentNodes) {
				node.isDragging = node.id === draggedNodeIdRef.current;
				if (node.role === NodeRole.ISOLATED) node.isolationTimer += deltaTime;
				else node.isolationTimer = 0;

				// Sync current UI pose into engine (dragging or external edits).
				runner.setNodePose(node.id, {
					x: (node.x - OFFSET_X_PX) / PIXELS_PER_METER,
					y: (node.y - OFFSET_Y_PX) / PIXELS_PER_METER,
				});

				// Map UI battery percent (0..100) to a plausible Li-ion voltage range.
				// This voltage is what firmware uses for leader election.
				const batteryV = 3.0 + 1.2 * Math.max(0, Math.min(1, node.battery / 100));
				runner.setNodeBatteryV(node.id, batteryV);

				let vxMps = 0;
				let vyMps = 0;
				if (node.motionMode === "MOVING" && !node.isDragging) {
					// Random-walk motion: constant speed with slow heading drift.
					node.battery = Math.max(0, node.battery - 0.01 * deltaTime);
					const dtSec = deltaTime;
					node.wanderChangeTimerMs -= deltaTime * 1000;
					if (node.wanderChangeTimerMs <= 0) {
						node.wanderHeadingRad = Math.random() * Math.PI * 2;
						node.wanderTurnRateRadPerSec = (Math.random() * 2 - 1) * 0.8;
						node.wanderSpeedMps = 0.6 + Math.random() * 0.8;
						node.wanderChangeIntervalMs = 2_000 + Math.random() * 4_000;
						node.wanderChangeTimerMs = node.wanderChangeIntervalMs;
					}
					const jitter = (Math.random() * 2 - 1) * 0.1;
					node.wanderHeadingRad += (node.wanderTurnRateRadPerSec + jitter) * dtSec;
					vxMps = Math.cos(node.wanderHeadingRad) * node.wanderSpeedMps;
					vyMps = Math.sin(node.wanderHeadingRad) * node.wanderSpeedMps;

					// If next step would exit bounds, reflect heading back into the world.
					const vxPxPerSec = vxMps * PIXELS_PER_METER;
					const vyPxPerSec = vyMps * PIXELS_PER_METER;
					const nextX = node.x + vxPxPerSec * dtSec;
					const nextY = node.y + vyPxPerSec * dtSec;
					const margin = 18; // node radius
					const hitX = nextX < WORLD_BOUNDS_PX.minX + margin || nextX > WORLD_BOUNDS_PX.maxX - margin;
					const hitY = nextY < WORLD_BOUNDS_PX.minY + margin || nextY > WORLD_BOUNDS_PX.maxY - margin;
					if (hitX || hitY) {
						let dx = Math.cos(node.wanderHeadingRad);
						let dy = Math.sin(node.wanderHeadingRad);
						if (hitX) dx = -dx;
						if (hitY) dy = -dy;
						node.wanderHeadingRad = Math.atan2(dy, dx);
						vxMps = Math.cos(node.wanderHeadingRad) * node.wanderSpeedMps;
						vyMps = Math.sin(node.wanderHeadingRad) * node.wanderSpeedMps;
					}
				}
				runner.setNodeVelocity(node.id, { vx: vxMps, vy: vyMps });
				totalBat += node.battery;
			}

			runner.step(deltaTime * 1000);
			const snap = runner.snapshot();
			const nowMs = snap.timeMs;
			simNowMsRef.current = nowMs;
			for (const sn of snap.nodes) {
				const node = currentNodes.find((n) => n.id === sn.id);
				if (!node) continue;
				if (!node.isDragging) {
					node.x = sn.x * PIXELS_PER_METER + OFFSET_X_PX;
					node.y = sn.y * PIXELS_PER_METER + OFFSET_Y_PX;
					// keep target position unless we auto-rerolled it above
				}
				node.updateFromEngine({
					engineTimeMs: nowMs,
					firmwareRole: sn.firmware.role,
					firmwareState: sn.firmware.state,
					estPosition: sn.firmware.estPosition,
					neighbors: sn.firmware.neighbors.map((nb: NeighborObservation) => ({
						id: nb.id,
						rangeMeters: nb.rangeMeters,
						angleRad: nb.angleRad,
						timestamp: nb.timestamp,
					})),
				});
			}

			visualPacketsRef.current = newVisuals;
			setVisualPackets(newVisuals);

			// 3. LINKS
			const newLinks: Link[] = [];
			currentNodes.forEach((n1) => {
				currentNodes.forEach((n2) => {
					if (n1.id >= n2.id) return;
					const dist = Math.sqrt(Math.pow(n1.x - n2.x, 2) + Math.pow(n1.y - n2.y, 2));
					if (dist <= rangePx) {
						let blocked = false;
						for (const w of currentWalls) {
							if (doIntersect({ x: n1.x, y: n1.y }, { x: n2.x, y: n2.y }, { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 })) {
								blocked = true;
								break;
							}
						}
						if (!blocked) newLinks.push({ source: n1, target: n2, dist });
					}
				});
			});
			setLinks(newLinks);

			// 4. CLOUD BACKEND (baseline + robust; ingest is driven by firmware uplink packets)
			if (nowMs - lastCloudTickRef.current > 250) {
				lastCloudTickRef.current = nowMs;
				const baselineCloud = cloudBackendBaselineRef.current;
				if (baselineCloud.tick(nowMs)) setFusedRecordsBaseline([...baselineCloud.getRecords()]);
			}

			// 6. ENERGY
			energyTimerRef.current += deltaTime;
			if (energyTimerRef.current > 1.0) {
				const avgBat = currentNodes.length > 0 ? totalBat / currentNodes.length : 0;
				setEnergyHistory((prev) => [...prev.slice(1), avgBat]);
				energyTimerRef.current = 0;
			}

			setTick((t) => t + 1);
			setNodes([...currentNodes]);
			animationRef.current = requestAnimationFrame(gameLoop);
		},
		[isPlaying, config, simTuning, capturePacket, ensureRunner, ingestUplinkToCloud],
	);

	useEffect(() => {
		animationRef.current = requestAnimationFrame(gameLoop);
		return () => {
			if (animationRef.current) cancelAnimationFrame(animationRef.current);
		};
	}, [gameLoop]);

	// --- INTERACTION ---
	const handleMouseDown = (e: React.MouseEvent, nodeId: number | "bg") => {
		e.stopPropagation();
		if (e.button !== 0) return;
		if (!svgRef.current) return;

		const rect = svgRef.current.getBoundingClientRect();
		const scaleX = CANVAS_WIDTH / rect.width;
		const scaleY = CANVAS_HEIGHT / rect.height;
		const mouseX = (e.clientX - rect.left) * scaleX;
		const mouseY = (e.clientY - rect.top) * scaleY;

		if (nodeId !== "bg") {
			if (isDrawingWall) return;
			const node = nodesRef.current.find((n) => n.id === nodeId);
			if (node) {
				draggedNodeIdRef.current = nodeId as number;
				dragStartPosRef.current = { x: mouseX, y: mouseY };
				dragOffsetRef.current = { x: mouseX - node.x, y: mouseY - node.y };
			}
		} else {
			if (isDrawingWall) {
				// Start Drawing Wall
				setWallStart({ x: mouseX, y: mouseY });
				setWallEnd({ x: mouseX, y: mouseY });
			}
		}
	};

	const handleMouseMove = (e: React.MouseEvent) => {
		if (!svgRef.current) return;
		const rect = svgRef.current.getBoundingClientRect();
		const scaleX = CANVAS_WIDTH / rect.width;
		const scaleY = CANVAS_HEIGHT / rect.height;
		const mouseX = (e.clientX - rect.left) * scaleX;
		const mouseY = (e.clientY - rect.top) * scaleY;

		// Dragging Wall Preview
		if (isDrawingWall && wallStart) {
			setWallEnd({ x: mouseX, y: mouseY });
		}

		// Dragging Node
		if (draggedNodeIdRef.current !== null) {
			const node = nodesRef.current.find((n) => n.id === draggedNodeIdRef.current);
			if (node) {
				const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
				node.x = clamp(mouseX - dragOffsetRef.current.x, WORLD_BOUNDS_PX.minX, WORLD_BOUNDS_PX.maxX);
				node.y = clamp(mouseY - dragOffsetRef.current.y, WORLD_BOUNDS_PX.minY, WORLD_BOUNDS_PX.maxY);
				node.targetX = node.x;
				node.targetY = node.y;
				const runner = runnerRef.current;
				if (runner) {
					runner.setNodePose(node.id, {
						x: (node.x - OFFSET_X_PX) / PIXELS_PER_METER,
						y: (node.y - OFFSET_Y_PX) / PIXELS_PER_METER,
					});
					runner.setNodeVelocity(node.id, { vx: 0, vy: 0 });
				}
				setNodes([...nodesRef.current]);
			}
		}
	};

	const handleMouseUp = (e: React.MouseEvent) => {
		const rect = svgRef.current?.getBoundingClientRect();
		if (!rect) return;
		const scaleX = CANVAS_WIDTH / rect.width;
		const scaleY = CANVAS_HEIGHT / rect.height;
		const mouseX = (e.clientX - rect.left) * scaleX;
		const mouseY = (e.clientY - rect.top) * scaleY;

		// Finish Wall Drawing
		if (isDrawingWall && wallStart) {
			// Prevent tiny accidental clicks
			const dist = Math.sqrt(Math.pow(mouseX - wallStart.x, 2) + Math.pow(mouseY - wallStart.y, 2));
			if (dist > 10) {
				const newWall: Wall = {
					id: Math.random().toString(),
					x1: wallStart.x,
					y1: wallStart.y,
					x2: mouseX,
					y2: mouseY,
				};
				setWalls((prev) => [...prev, newWall]);
			}
			setWallStart(null);
			setWallEnd(null);
		}

		// Finish Node Dragging
		if (draggedNodeIdRef.current !== null) {
			const distMoved = Math.sqrt(
				Math.pow(mouseX - dragStartPosRef.current.x, 2) + Math.pow(mouseY - dragStartPosRef.current.y, 2),
			);
			if (distMoved < 5) {
				const node = nodesRef.current.find((n) => n.id === draggedNodeIdRef.current);
				if (node) node.toggleMode();
			}
			draggedNodeIdRef.current = null;
		}
	};

	// Actions
	const spawn = (type: NodeType) => {
		const maxId = nodesRef.current.length > 0 ? Math.max(...nodesRef.current.map((n) => n.id)) : 0;
		const x = WORLD_BOUNDS_PX.minX + Math.random() * (WORLD_BOUNDS_PX.maxX - WORLD_BOUNDS_PX.minX);
		const y = WORLD_BOUNDS_PX.minY + Math.random() * (WORLD_BOUNDS_PX.maxY - WORLD_BOUNDS_PX.minY);
		const n = new UiNode(maxId + 1, type, x, y);
		const runner = ensureRunner();
		runner.addNode(
			n.id,
			{ x: (x - OFFSET_X_PX) / PIXELS_PER_METER, y: (y - OFFSET_Y_PX) / PIXELS_PER_METER },
			{ vx: 0, vy: 0 },
			3.7,
			type === "HARDWARE_GW",
		);
		setNodes((prev) => [...prev, n]);
		nodesRef.current = [...nodesRef.current, n];
	};
	/*
	const clearType = (type: NodeType) => {
		const newNodes = nodesRef.current.filter((n) => n.type !== type);
		setNodes(newNodes);
		nodesRef.current = newNodes;
		setOpenWindows([]);
	};
	*/
	const nukeAll = () => {
		setNodes([]);
		nodesRef.current = [];
		runnerRef.current = null;
		simNowMsRef.current = 0;
		setUplinkStats({
			totalBatches: 0,
			totalReports: 0,
			lastSenderId: -1,
			lastBatchSize: 0,
			lastUplinkTimeMs: 0,
		});
		cloudBackendBaselineRef.current = new CloudBackend();
		setFusedRecordsBaseline([]);
		setCloudEventsBaseline([]);
		setOpenWindows([]);
		setWalls([]);
	};
	const openNodeWindow = (id: number) => {
		if (!openWindows.includes(id)) {
			setOpenWindows((prev) => [...prev, id]);
			setWindowOrder((prev) => [...prev, id]);
		} else focusWindow(id);
	};
	const closeNodeWindow = (id: string | number) => setOpenWindows((prev) => prev.filter((w) => w !== id));
	const focusWindow = (id: string | number) =>
		setWindowOrder((prev) => [...prev.filter((w) => w !== Number(id)), Number(id)]);
	const getNodeColor = (n: UiNode) => {
		if (n.role === NodeRole.ISOLATED && n.isolationTimer > config.isolationTimeout) return "#ef4444";
		if (n.role === NodeRole.ISOLATED) return "#f59e0b";
		if (n.role === NodeRole.ROOT) return "#a855f7";
		if (n.role === NodeRole.LEADER) return "#ec4899";
		return "#22c55e";
	};
	const getPacketColor = (type: PacketType) => {
		switch (type) {
			case PacketType.HELLO:
				return "#38bdf8";
			case PacketType.DATA:
				return "#4ade80";
			case PacketType.UPLINK:
				return "#ec4899";
			case PacketType.ELECTION:
				return "#a855f7";
			case PacketType.PANIC:
				return "#ef4444";
			default:
				return "#cbd5e1";
		}
	};
	const styles = {
		container: {
			display: "flex",
			height: "100vh",
			width: "100vw",
			backgroundColor: "#0f172a",
			color: "#f1f5f9",
			fontFamily: "sans-serif",
			overflow: "hidden",
			userSelect: "none" as const,
		},
		sidebar: {
			width: "320px",
			backgroundColor: "#1e293b",
			borderRight: "1px solid #334155",
			padding: "20px",
			boxSizing: "border-box" as const,
			height: "100%",
			overflowY: "auto" as const,
			overflowX: "hidden" as const,
			display: "flex",
			flexDirection: "column" as const,
			gap: "15px",
			zIndex: 10,
			boxShadow: "4px 0 15px rgba(0,0,0,0.3)",
		},
		main: { flex: 1, backgroundColor: "#020617", position: "relative" as const, overflow: "hidden" },
		panel: {
			backgroundColor: "rgba(15, 23, 42, 0.5)",
			padding: "12px",
			borderRadius: "8px",
			border: "1px solid #334155",
			display: "flex",
			flexDirection: "column" as const,
			gap: "8px",
		},
		btn: {
			padding: "8px",
			borderRadius: "4px",
			border: "none",
			cursor: "pointer",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			color: "white",
			gap: "6px",
			fontSize: "11px",
			fontWeight: "bold",
			transition: "0.2s",
		},
		label: {
			fontSize: "10px",
			color: "#94a3b8",
			textTransform: "uppercase" as const,
			letterSpacing: "0.5px",
			fontWeight: "bold",
		},
		inspectorRow: {
			display: "flex",
			justifyContent: "space-between",
			padding: "8px 12px",
			borderBottom: "1px solid #1e293b",
			fontSize: "11px",
			fontFamily: "monospace",
		},
	};

	const handleSetGlobalPosition = () => {
		if (!contextMenu) return;
		const latStr = prompt("Enter Latitude (e.g. 52.5200):", "52.5200");
		const lngStr = prompt("Enter Longitude (e.g. 13.4050):", "13.4050");
		if (latStr && lngStr) {
			const lat = parseFloat(latStr);
			const lng = parseFloat(lngStr);
			if (!isNaN(lat) && !isNaN(lng)) {
				const node = nodesRef.current.find((n) => n.id === contextMenu.nodeId);
				if (node) {
					node.setGlobalPosition(lat, lng);
				}
			}
		}
		setContextMenu(null);
	};


	const handleSetBatteryLife = () => {
		if (!contextMenu) return;
		const pctStr = prompt("Enter battery percentage (0-100):");
		if (!pctStr) {
			setContextMenu(null);
			return;
		}
		const pct = parseFloat(pctStr);
		if (!Number.isFinite(pct)) {
			setContextMenu(null);
			return;
		}
		const node = nodesRef.current.find((n) => n.id === contextMenu.nodeId);
		if (node) {
			node.battery = Math.max(0, Math.min(100, Math.round(pct)));
		}
		setContextMenu(null);
	};

	// --- RENDER ---
	if (viewMode === "ANALYSIS") {
		return (
			<div
				style={{ width: "100vw", height: "100vh", backgroundColor: "white", overflow: "auto", position: "relative" }}
			>
				<button
					onClick={() => setViewMode("SIM")}
					style={{
						position: "fixed",
						top: "1rem",
						right: "1rem",
						zIndex: 50,
						display: "flex",
						alignItems: "center",
						gap: "0.5rem",
						padding: "0.5rem 1rem",
						backgroundColor: "#1f2937",
						color: "white",
						borderRadius: "0.25rem",
						border: "none",
						cursor: "pointer",
						boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.1)",
					}}
				>
					<Activity size={18} /> Back to Simulator
				</button>
				<AnalysisDashboard />
			</div>
		);
	}

	return (
		<>
			<style>{`body { margin: 0; padding: 0; overflow: hidden; box-sizing: border-box; }`}</style>
			<div
				style={styles.container}
				onMouseUp={handleMouseUp}
				onMouseMove={handleMouseMove}
				onMouseDown={(e) => handleMouseDown(e, "bg")}
			>
				<div style={{ position: "absolute", top: 16, right: 16, zIndex: 9999 }}>
					<button
						onClick={() => setViewMode("ANALYSIS")}
						style={{
							display: "flex",
							alignItems: "center",
							gap: "8px",
							padding: "8px 16px",
							backgroundColor: "#4f46e5",
							color: "white",
							borderRadius: "6px",
							border: "none",
							cursor: "pointer",
							boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
						}}
					>
						<Database size={18} /> View Analysis
					</button>
				</div>
				<div style={styles.sidebar}>
					<div>
						<h1 style={{ margin: 0, color: "#38bdf8", fontSize: "22px", fontWeight: "900" }}>MESH SIM v21</h1>
						<p style={{ margin: 0, color: "#64748b", fontSize: "11px" }}>Energy & Obstacle Physics</p>
					</div>

					<div style={styles.panel}>
						<span style={styles.label}>Control</span>
						<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
							<button style={{ ...styles.btn, backgroundColor: "#334155" }} onClick={() => spawn("TRACKER")}>
								<Plus size={14} /> Tracker
							</button>
							<button style={{ ...styles.btn, backgroundColor: "#334155" }} onClick={() => spawn("HARDWARE_GW")}>
								<Wifi size={14} /> GW
							</button>
						</div>
						<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
							<button style={{ ...styles.btn, backgroundColor: "#b91c1c" }} onClick={nukeAll}>
								<XCircle size={14} /> Clear
							</button>
							<button
								style={{ ...styles.btn, backgroundColor: isPlaying ? "#eab308" : "#22c55e" }}
								onClick={() => setIsPlaying(!isPlaying)}
							>
								{isPlaying ? <Pause size={14} /> : <Play size={14} />} {isPlaying ? "Pause" : "Run"}
							</button>
						</div>
					</div>

					<div style={styles.panel}>
						<span style={styles.label}>Tools</span>
						<button
							style={{ ...styles.btn, backgroundColor: isDrawingWall ? "#a855f7" : "#334155" }}
							onClick={() => setIsDrawingWall(!isDrawingWall)}
						>
							<BrickWall size={14} /> {isDrawingWall ? "Finish Drawing" : "Draw Walls"}
						</button>
						<button style={{ ...styles.btn, backgroundColor: "#334155" }} onClick={() => setWalls([])}>
							<Trash2 size={14} /> Clear Walls
						</button>
					</div>

					<div style={styles.panel}>
						<span style={styles.label}>Telemetry</span>
						<button
							style={{ ...styles.btn, backgroundColor: showCloudLogs ? "#3b82f6" : "#334155" }}
							onClick={() => setShowCloudLogs(!showCloudLogs)}
						>
							<Database size={14} /> Cloud Database
						</button>
						<button
							style={{ ...styles.btn, backgroundColor: showPacketSniffer ? "#8b5cf6" : "#334155" }}
							onClick={() => setShowPacketSniffer(!showPacketSniffer)}
						>
							<Radio size={14} /> Packet Sniffer
						</button>
						<button
							style={{ ...styles.btn, backgroundColor: showBatteryMonitor ? "#10b981" : "#334155" }}
							onClick={() => setShowBatteryMonitor(!showBatteryMonitor)}
						>
							<TrendingDown size={14} /> Battery Monitor
						</button>
					</div>

					<div style={styles.panel}>
						<span style={styles.label}>Kalman Filter</span>
						<button
							style={{ ...styles.btn, backgroundColor: showFilterConfiguration ? "#3b82f6" : "#334155" }}
							onClick={() => setShowFilterConfiguration(!showFilterConfiguration)}
						>
							<Wrench size={14} /> Filter Configuration
						</button>
					</div>

					<div style={styles.panel}>
						<span style={styles.label}>Configuration</span>
						<div style={{ fontSize: "10px", color: "#94a3b8", lineHeight: 1.2 }}>
							Top sliders apply live. Firmware/Cloud changes may require <b>Apply</b>.
						</div>

						<div style={{ fontSize: "10px", color: "#cbd5e1", fontWeight: 600 }}>UWB Max Range</div>
						<input
							type="range"
							min="5"
							max="30"
							value={config.uwbRange}
							onChange={(e) => setConfig({ ...config, uwbRange: Number(e.target.value) })}
							title="Max radio/UWB interaction distance (meters)"
							style={{ width: "100%" }}
						/>
						<div style={{ fontSize: "9px", color: "#cbd5e1", textAlign: "right" }}>{config.uwbRange} m</div>
						<div style={{ fontSize: "9px", color: "#64748b" }}>Higher range increases links and chatter.</div>

						<div style={{ fontSize: "10px", color: "#cbd5e1", fontWeight: 600, marginTop: 6 }}>Movement Speed</div>
						<input
							type="range"
							min="0.1"
							max="3.0"
							step="0.1"
							value={config.movingSpeed}
							onChange={(e) => setConfig({ ...config, movingSpeed: Number(e.target.value) })}
							title="UI motion multiplier for nodes in MOVING mode"
							style={{ width: "100%" }}
						/>
						<div style={{ fontSize: "9px", color: "#cbd5e1", textAlign: "right" }}>{config.movingSpeed}x</div>
						<div style={{ fontSize: "9px", color: "#64748b" }}>Only affects nodes you toggle to MOVING.</div>

						{/* <div style={{ fontSize: "10px", color: "#cbd5e1", fontWeight: 600, marginTop: 6 }}>Max Leaders</div>
						<input
							type="range"
							min="1"
							max="5"
							step="1"
							value={config.maxLeaders}
							onChange={(e) => setConfig({ ...config, maxLeaders: Number(e.target.value) })}
							title="UI constraint: limit how many leader nodes can exist"
							style={{ width: "100%", accentColor: "#ec4899" }}
						/>
						<div style={{ fontSize: "9px", color: "#f472b6", textAlign: "right" }}>{config.maxLeaders} Leaders</div> */}

						{/* RESTORED SLIDER */}
						{/* <div style={{ fontSize: "10px", color: "#cbd5e1", fontWeight: 600, marginTop: 6 }}>Min Cluster Size</div>
						<input
							type="range"
							min="2"
							max="10"
							step="1"
							value={config.minClusterSize}
							onChange={(e) => setConfig({ ...config, minClusterSize: Number(e.target.value) })}
							title="UI constraint: minimum nodes needed before forming a cluster"
							style={{ width: "100%", accentColor: "#a855f7" }}
						/>
						<div style={{ fontSize: "9px", color: "#a855f7", textAlign: "right" }}>
							Min Size: {config.minClusterSize}
						</div> */}
						<div style={{ fontSize: "9px", color: "#64748b" }}>Used by the UI/cluster visualization.</div>

						<div style={{ height: 1, backgroundColor: "#334155", margin: "8px 0" }} />
						<div style={{ fontSize: "10px", color: "#94a3b8", fontWeight: 600 }}>Simulation (Live)</div>
						<div style={{ fontSize: "9px", color: "#64748b" }}>Affects RF delivery + measurement noise.</div>
						<div style={{ fontSize: "10px", color: "#cbd5e1", fontWeight: 600, marginTop: 6 }}>Packet Loss</div>
						<input
							type="range"
							min="0"
							max="0.5"
							step="0.01"
							value={simTuning.packetLoss}
							onChange={(e) => setSimTuning({ ...simTuning, packetLoss: Number(e.target.value) })}
							title="Probability a packet is dropped (0–50%)"
							style={{ width: "100%" }}
						/>
						<div style={{ fontSize: "9px", color: "#cbd5e1", textAlign: "right" }}>
							Packet Loss: {(simTuning.packetLoss * 100).toFixed(0)}%
						</div>
						<div style={{ fontSize: "9px", color: "#64748b" }}>
							Higher loss increases isolation + delays convergence.
						</div>
						<div style={{ fontSize: "10px", color: "#cbd5e1", fontWeight: 600, marginTop: 6 }}>
							UWB Distance Noise (σ)
						</div>
						<input
							type="range"
							min="0"
							max="0.25"
							step="0.005"
							value={simTuning.uwbNoiseSigmaMeters}
							onChange={(e) => setSimTuning({ ...simTuning, uwbNoiseSigmaMeters: Number(e.target.value) })}
							title="Standard deviation of range measurements (meters)"
							style={{ width: "100%" }}
						/>
						<div style={{ fontSize: "9px", color: "#cbd5e1", textAlign: "right" }}>
							UWB σ: {simTuning.uwbNoiseSigmaMeters.toFixed(3)} m
						</div>
						<div style={{ fontSize: "9px", color: "#64748b" }}>Adds noise to measured distance between neighbors.</div>
						<div style={{ fontSize: "10px", color: "#cbd5e1", fontWeight: 600, marginTop: 6 }}>
							UWB Bearing (AoA) Noise (σ)
						</div>
						<input
							type="range"
							min="0"
							max="30"
							step="0.5"
							value={simTuning.uwbAngleNoiseStdDeg}
							onChange={(e) => setSimTuning({ ...simTuning, uwbAngleNoiseStdDeg: Number(e.target.value) })}
							title="Standard deviation of bearing (AoA) measurements (degrees)"
							style={{ width: "100%" }}
						/>
						<div style={{ fontSize: "9px", color: "#cbd5e1", textAlign: "right" }}>
							Bearing σ: {simTuning.uwbAngleNoiseStdDeg.toFixed(1)}°
						</div>
						<div style={{ fontSize: "9px", color: "#64748b" }}>
							Adds noise to measured neighbor bearing (angle-of-arrival).
						</div>

						<div style={{ height: 1, backgroundColor: "#334155", margin: "8px 0" }} />
						<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
							<div style={{ fontSize: "10px", color: "#94a3b8", fontWeight: 600 }}>Firmware</div>
							<button
								style={{ ...styles.btn, backgroundColor: "#334155", padding: "4px 8px", fontSize: "10px" }}
								onClick={() => applyFirmwareTuning()}
							>
								Apply
							</button>
						</div>
						<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
							<div style={{ fontSize: "9px", color: "#cbd5e1" }}>Messaging Mode</div>
							<select
								value={isEventDriven ? "ETM" : "PERIODIC"}
								onChange={(e) => {
									const isEtm = e.target.value === "ETM";
									const next: FirmwareConfig = {
										...firmwareTuning,
										eventDrivenSensing: isEtm,
										...(isEtm
											? {}
											: {
													helloIntervalMovingMs:
														firmwareTuning.helloIntervalIdleMs ?? firmwareTuning.helloIntervalMovingMs,
													rangingIntervalIdleMs:
														firmwareTuning.rangingIntervalMovingMs ?? firmwareTuning.rangingIntervalIdleMs,
												}),
									};
									setFirmwareTuning(next);
									applyFirmwareTuning(next);
								}}
								style={{
									fontSize: "10px",
									backgroundColor: "#0f172a",
									color: "#e2e8f0",
									border: "1px solid #334155",
									borderRadius: 4,
									padding: "2px 6px",
								}}
							>
								<option value="ETM">Event-driven (ETM)</option>
								<option value="PERIODIC">Periodic (fixed interval)</option>
							</select>
						</div>
						<div style={{ fontSize: "9px", color: "#64748b" }}>
							{isEventDriven
								? "Event-driven: UWB blinks only while MOVING; stationary sends HELLO only."
								: "Periodic: HELLO and BLINK cadence follow the intervals below."}
						</div>
						<div style={{ fontSize: "9px", color: "#64748b" }}>
							Cadence sliders below require <b>Apply</b>.
						</div>

						{isEventDriven ? (
							<>
								<div style={{ fontSize: "10px", color: "#cbd5e1", fontWeight: 600, marginTop: 8 }}>
									HELLO Interval (stationary state)
								</div>
								<input
									type="range"
									min="1000"
									max="60000"
									step="1000"
									value={firmwareTuning.helloIntervalIdleMs ?? 10000}
									onChange={(e) =>
										setFirmwareTuning({ ...firmwareTuning, helloIntervalIdleMs: Number(e.target.value) })
									}
									title="How often a node sends HELLO while stationary and stable"
									style={{ width: "100%" }}
								/>
								<div style={{ fontSize: "9px", color: "#cbd5e1", textAlign: "right" }}>
									{((firmwareTuning.helloIntervalIdleMs ?? 10000) / 1000).toFixed(0)} s
								</div>
							</>
						) : (
							<>
								<div style={{ fontSize: "10px", color: "#cbd5e1", fontWeight: 600, marginTop: 8 }}>
									HELLO Interval (all states)
								</div>
								<input
									type="range"
									min="1000"
									max="60000"
									step="1000"
									value={firmwareTuning.helloIntervalIdleMs ?? 10000}
									onChange={(e) => {
										const value = Number(e.target.value);
										setFirmwareTuning({
											...firmwareTuning,
											helloIntervalIdleMs: value,
											helloIntervalMovingMs: value,
										});
									}}
									title="How often a node sends HELLO in periodic mode"
									style={{ width: "100%" }}
								/>
								<div style={{ fontSize: "9px", color: "#cbd5e1", textAlign: "right" }}>
									{((firmwareTuning.helloIntervalIdleMs ?? 10000) / 1000).toFixed(0)} s
								</div>
							</>
						)}

						{!isEventDriven && (
							<>
								<div style={{ fontSize: "10px", color: "#cbd5e1", fontWeight: 600, marginTop: 8 }}>
									UWB Blink Interval (all states)
								</div>
								<input
									type="range"
									min="250"
									max="5000"
									step="250"
									value={firmwareTuning.rangingIntervalMovingMs ?? 1000}
									onChange={(e) => {
										const value = Number(e.target.value);
										setFirmwareTuning({
											...firmwareTuning,
											rangingIntervalMovingMs: value,
											rangingIntervalIdleMs: value,
										});
									}}
									title="How often a node sends UWB blinks in periodic mode"
									style={{ width: "100%" }}
								/>
								<div style={{ fontSize: "9px", color: "#cbd5e1", textAlign: "right" }}>
									{((firmwareTuning.rangingIntervalMovingMs ?? 1000) / 1000).toFixed(2)} s
								</div>
							</>
						)}
						<div style={{ fontSize: "10px", color: "#cbd5e1", fontWeight: 600, marginTop: 6 }}>IMU Move Threshold</div>
						<input
							type="range"
							min="0.1"
							max="2.0"
							step="0.05"
							value={firmwareTuning.accelMoveThresholdG}
							onChange={(e) => setFirmwareTuning({ ...firmwareTuning, accelMoveThresholdG: Number(e.target.value) })}
							style={{ width: "100%" }}
						/>
						<div style={{ fontSize: "9px", color: "#cbd5e1", textAlign: "right" }}>
							Move Threshold: {firmwareTuning.accelMoveThresholdG.toFixed(2)} g
						</div>
						<div style={{ fontSize: "9px", color: "#64748b" }}>Higher = fewer MOVING detections.</div>
						<div style={{ fontSize: "10px", color: "#cbd5e1", fontWeight: 600, marginTop: 6 }}>Isolation Timeout</div>
						<input
							type="range"
							min="5000"
							max="120000"
							step="1000"
							value={firmwareTuning.isolationNoAckMs}
							onChange={(e) => setFirmwareTuning({ ...firmwareTuning, isolationNoAckMs: Number(e.target.value) })}
							style={{ width: "100%" }}
						/>
						<div style={{ fontSize: "9px", color: "#cbd5e1", textAlign: "right" }}>
							Isolation No-ACK: {(firmwareTuning.isolationNoAckMs / 1000).toFixed(0)} s
						</div>
						<div style={{ fontSize: "9px", color: "#64748b" }}>
							Time without received packets before entering ISOLATED.
						</div>

						<div style={{ height: 1, backgroundColor: "#334155", margin: "8px 0" }} />
						{/* <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
							<div style={{ fontSize: "10px", color: "#94a3b8", fontWeight: 600 }}>Cloud Fusion</div>
							<button
								style={{ ...styles.btn, backgroundColor: "#334155", padding: "4px 8px", fontSize: "10px" }}
								onClick={applyCloudTuning}
							>
								Apply
							</button>
						</div> */}
						{/* <div style={{ fontSize: "9px", color: "#64748b" }}>Affects how the cloud optimizer weights residuals.</div> */}
						{/* <div style={{ fontSize: "10px", color: "#cbd5e1", fontWeight: 600, marginTop: 6 }}>Distance σ (Cloud)</div>
						<input
							type="range"
							min="0.01"
							max="1.0"
							step="0.01"
							value={cloudTuning.distanceSigma ?? 0.15}
							onChange={(e) => setCloudTuning({ ...cloudTuning, distanceSigma: Number(e.target.value) })}
							style={{ width: "100%" }}
						/> */}
						{/* <div style={{ fontSize: "9px", color: "#cbd5e1", textAlign: "right" }}>
							Distance σ: {(cloudTuning.distanceSigma ?? 0.15).toFixed(2)} m
						</div>
						<div style={{ fontSize: "9px", color: "#64748b" }}>Expected range noise used for weighting.</div>
						<div style={{ fontSize: "10px", color: "#cbd5e1", fontWeight: 600, marginTop: 6 }}>Angle σ (Cloud)</div> */}
						{/* <input
							type="range"
							min="0"
							max="60"
							step="1"
							value={(cloudTuning.angleSigma ?? (20 * Math.PI) / 180) * (180 / Math.PI)}
							onChange={(e) => setCloudTuning({ ...cloudTuning, angleSigma: (Number(e.target.value) * Math.PI) / 180 })}
							style={{ width: "100%" }}
						/> */}
						{/* <div style={{ fontSize: "9px", color: "#cbd5e1", textAlign: "right" }}>
							Angle σ: {(((cloudTuning.angleSigma ?? (20 * Math.PI) / 180) * 180) / Math.PI).toFixed(0)}°
						</div> */}
						{/* <div style={{ fontSize: "9px", color: "#64748b" }}>Expected bearing noise used for weighting.</div> */}
					</div>

					<div style={styles.panel}>
						<span style={styles.label}>Packet Legend</span>
						<div
							style={{ display: "grid", gridTemplateColumns: "1fr", gap: "4px", fontSize: "10px", color: "#cbd5e1" }}
						>
							<div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
								<div style={{ width: 8, height: 8, borderRadius: "50%", border: "1px solid #38bdf8" }}></div> HELLO
								(Wave)
							</div>
							<div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
								<div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#4ade80" }}></div> DATA (Line)
							</div>
							<div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
								<div style={{ width: 8, height: 8, borderRadius: "50%", border: "1px solid #a855f7" }}></div> ELECTION
								(Wave)
							</div>
							<div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
								<div style={{ width: 8, height: 8, borderRadius: "50%", border: "1px solid #ef4444" }}></div> PANIC
								(Wave)
							</div>
						</div>
					</div>
				</div>

				<div style={styles.main}>
					<div
						style={{
							position: "absolute",
							top: "15px",
							left: "15px",
							color: "#64748b",
							fontSize: "12px",
							fontFamily: "monospace",
						}}
					>
						TICKS: {tick} | NODES: {nodes.length}
					</div>
					{showCloudLogs && (
						<DraggableWindow
							id="cloud"
							title={`CLOUD DATABASE (${cloudViewMode})`}
							icon={Database}
							initialX={800}
							initialY={50}
							initialWidth={450}
							initialHeight={350}
							resizable={true}
							onClose={() => setShowCloudLogs(false)}
							onFocus={() => focusWindow("cloud")}
							zIndex={100}
						>
							<div style={{ padding: "8px", borderBottom: "1px solid #334155", display: "flex", gap: "4px" }}>
								<button
									onClick={() => setCloudViewMode("DATA")}
									style={{
										fontSize: "9px",
										padding: "4px 8px",
										borderRadius: "4px",
										border: "none",
										backgroundColor: cloudViewMode === "DATA" ? "#38bdf8" : "#1e293b",
										color: cloudViewMode === "DATA" ? "#0f172a" : "#94a3b8",
										cursor: "pointer",
									}}
								>
									DATA
								</button>
								<button
									onClick={() => setCloudViewMode("RAW")}
									style={{
										fontSize: "9px",
										padding: "4px 8px",
										borderRadius: "4px",
										border: "none",
										backgroundColor: cloudViewMode === "RAW" ? "#38bdf8" : "#1e293b",
										color: cloudViewMode === "RAW" ? "#0f172a" : "#94a3b8",
										cursor: "pointer",
									}}
								>
									RAW LOGS
								</button>
								<button
									onClick={() => setCloudViewMode("TOPOLOGY")}
									style={{
										fontSize: "9px",
										padding: "4px 8px",
										borderRadius: "4px",
										border: "none",
										backgroundColor: cloudViewMode === "TOPOLOGY" ? "#38bdf8" : "#1e293b",
										color: cloudViewMode === "TOPOLOGY" ? "#0f172a" : "#94a3b8",
										cursor: "pointer",
									}}
								>
									TOPOLOGY
								</button>
							</div>
							<div
								style={{
									padding: "6px 8px",
									borderBottom: "1px solid #334155",
									fontSize: "9px",
									fontFamily: "monospace",
									color: "#94a3b8",
								}}
							>
								UPLINK: {uplinkStats.totalBatches} batches / {uplinkStats.totalReports} reports
								{uplinkStats.lastSenderId >= 0 && (
									<>
										{" "}
										| last sender: {uplinkStats.lastSenderId} ({uplinkStats.lastBatchSize}){" "}
										{uplinkStats.lastUplinkTimeMs > 0
											? `${(Math.max(0, simNowMsRef.current - uplinkStats.lastUplinkTimeMs) / 1000).toFixed(1)}s ago`
											: ""}
									</>
								)}
								
							</div>
							{cloudViewMode === "DATA" ? (
								<div style={{ padding: "8px", overflowX: "auto" }}>
									<table
										style={{ width: "100%", borderCollapse: "collapse", fontSize: "10px", fontFamily: "monospace" }}
									>
										<thead>
											<tr style={{ borderBottom: "1px solid #475569", color: "#94a3b8", textAlign: "left" }}>
												<th style={{ padding: "4px" }}>ID</th>
												<th style={{ padding: "4px" }}>POS (m)</th>
												<th style={{ padding: "4px" }}>GLOBAL</th>
												<th style={{ padding: "4px" }}>BAT</th>
												<th style={{ padding: "4px" }}>STATUS</th>
												<th style={{ padding: "4px" }}>UPDATED</th>
											</tr>
										</thead>
										<tbody>
											{fusedRecords.map((r) => (
												<tr key={r.id} style={{ borderBottom: "1px solid #1e293b", color: "#e2e8f0" }}>
													<td style={{ padding: "4px" }}>{r.nodeId}</td>
													<td style={{ padding: "4px" }}>
														{r.position.x.toFixed(0)}, {r.position.y.toFixed(0)}
													</td>
													<td style={{ padding: "4px" }}>
														{typeof r.position.lat === "number" ? r.position.lat.toFixed(6) : "-"},{" "}
														{typeof r.position.lng === "number" ? r.position.lng.toFixed(6) : "-"}
													</td>
													<td style={{ padding: "4px" }}>{r.avgBattery.toFixed(1)}%</td>
													<td
														style={{
															padding: "4px",
															color: r.status === "STABLE" ? "#4ade80" : r.status === "MOVING" ? "#facc15" : "#94a3b8",
														}}
													>
														{r.status}
													</td>
													<td style={{ padding: "4px", opacity: 0.7 }}>
														{(Math.max(0, simNowMsRef.current - r.timestamp) / 1000).toFixed(1)}s ago
													</td>
												</tr>
											))}
											{fusedRecords.length === 0 && (
												<tr>
													<td colSpan={6} style={{ padding: "8px", textAlign: "center", color: "#64748b" }}>
														Waiting for data...
													</td>
												</tr>
											)}
										</tbody>
									</table>
								</div>
							) : cloudViewMode === "TOPOLOGY" ? (
								<div
									style={{
										width: "100%",
										height: "100%",
										minHeight: "200px",
										position: "relative",
										backgroundColor: "#0f172a",
									}}
								>
									{(() => {
										// Filter to get only the latest record per node for the topology.
										const uniqueRecordsMap = new Map<number, FusedRecord>();
										for (const r of fusedRecords) {
											const prev = uniqueRecordsMap.get(r.nodeId);
											if (!prev || r.timestamp > prev.timestamp) {
												uniqueRecordsMap.set(r.nodeId, r);
											}
										}
										const uniqueRecords = Array.from(uniqueRecordsMap.values());
										const truthById = new Map<number, { x: number; y: number }>();
										for (const n of nodes) {
											const x = (n.x - OFFSET_X_PX) / PIXELS_PER_METER;
											const y = (n.y - OFFSET_Y_PX) / PIXELS_PER_METER;
											if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
											truthById.set(n.id, { x, y });
										}
										const recordById = new Map<number, FusedRecord>();
										for (const r of uniqueRecords) recordById.set(r.nodeId, r);
										const positionsById = new Map<number, { x: number; y: number }>();
										const seed = uniqueRecords.find((r) =>
											(r.neighbors ?? []).some((n) => Number.isFinite(n.range) && Number.isFinite(n.aoa)),
										);
										if (seed) positionsById.set(seed.nodeId, { x: 0, y: 0 });
										let progressed = true;
										let guard = 0;
										while (progressed && guard < uniqueRecords.length * 2) {
											progressed = false;
											guard += 1;
											for (const r of uniqueRecords) {
												const base = positionsById.get(r.nodeId);
												if (!base) continue;
												for (const n of r.neighbors ?? []) {
													if (!Number.isFinite(n.range) || !Number.isFinite(n.aoa)) continue;
													if (positionsById.has(n.id)) continue;
													const theta = n.aoa + Math.PI;
													positionsById.set(n.id, {
														x: base.x + n.range * Math.cos(theta),
														y: base.y + n.range * Math.sin(theta),
													});
													progressed = true;
												}
											}
										}
										const recordsForView = uniqueRecords.map((r) => {
											const pos = positionsById.get(r.nodeId);
											if (!pos) return r;
											return {
												...r,
												position: { x: pos.x, y: pos.y, lat: r.position.lat, lng: r.position.lng },
											};
										});
										const edgeSet = new Set<string>();
										const edges: Array<[number, number]> = [];
										const idsPresent = new Set(recordsForView.map((r) => r.nodeId));
										for (const r of uniqueRecords) {
											for (const n of r.neighbors) {
												if (!idsPresent.has(n.id)) continue;
												const a = Math.min(r.nodeId, n.id);
												const b = Math.max(r.nodeId, n.id);
												const key = `${a}-${b}`;
												if (edgeSet.has(key)) continue;
												edgeSet.add(key);
												edges.push([a, b]);
											}
										}
										// Compute cloudStats and convergence status
										const cloudStats = computeCloudStructureStatsMeters({
											records: recordsForView,
											truthById,
											edges,
										});
										const { convergenceText, convergenceColor } = computeCloudConvergence(uniqueRecords, cloudStats);
										const lastPanicTsByNodeId = new Map<number, number>();
										for (const e of cloudEvents) {
											if (e.kind !== "PANIC") continue;
											if (typeof e.nodeId !== "number") continue;
											const prev = lastPanicTsByNodeId.get(e.nodeId);
											if (!prev || e.timestamp >= prev) lastPanicTsByNodeId.set(e.nodeId, e.timestamp);
										}

										const componentSizeByNodeId = new Map<number, number>();
										{
											const idList = Array.from(idsPresent.values());
											const idToIndex = new Map<number, number>();
											for (let i = 0; i < idList.length; i++) idToIndex.set(idList[i], i);
											const adjacency: number[][] = Array.from({ length: idList.length }, () => []);
											for (const [a, b] of edges) {
												const ai = idToIndex.get(a);
												const bi = idToIndex.get(b);
												if (ai === undefined || bi === undefined) continue;
												adjacency[ai].push(bi);
												adjacency[bi].push(ai);
											}
											const visited = new Array<boolean>(idList.length).fill(false);
											for (let i = 0; i < idList.length; i++) {
												if (visited[i]) continue;
												const stack = [i];
												visited[i] = true;
												const comp: number[] = [];
												while (stack.length > 0) {
													const cur = stack.pop()!;
													comp.push(cur);
													for (const nb of adjacency[cur]) {
														if (visited[nb]) continue;
														visited[nb] = true;
														stack.push(nb);
													}
												}
												const size = comp.length;
												for (const idx of comp) componentSizeByNodeId.set(idList[idx], size);
											}
										}
										const isPanicActive = (nodeId: number) => {
											// Panic persists while isolated, and clears automatically when the node
											// rejoins any multi-node connected component.
											if (!lastPanicTsByNodeId.has(nodeId)) return false;
											return (componentSizeByNodeId.get(nodeId) ?? 1) <= 1;
										};

										if (uniqueRecords.length === 0)
											return (
												<div style={{ padding: 20, color: "#64748b", fontSize: "10px", textAlign: "center" }}>
													No topology data
												</div>
											);

										// Calculate bounds
										const xs = recordsForView.map((r) => r.position.x);
										const ys = recordsForView.map((r) => r.position.y);
										const minX = Math.min(...xs);
										const maxX = Math.max(...xs);
										const minY = Math.min(...ys);
										const maxY = Math.max(...ys);

										const padding = 40;
										const width = 400; // internal SVG width
										const height = 300; // internal SVG height

										const rangeX = maxX - minX || 1;
										const rangeY = maxY - minY || 1;
										const scaleX = (width - padding * 2) / rangeX;
										const scaleY = (height - padding * 2) / rangeY;
										const scale = Math.min(scaleX, scaleY);

										const transform = (x: number, y: number) => ({
											x: padding + (x - minX) * scale + (width - padding * 2 - rangeX * scale) / 2,
											y: padding + (y - minY) * scale + (height - padding * 2 - rangeY * scale) / 2,
										});

										return (
											<>
												<div
													style={{
														position: "absolute",
														top: 8,
														right: 8,
														padding: "6px 10px",
														borderRadius: "6px",
														border: `1px solid ${convergenceColor}`,
														backgroundColor: "#0f172a",
														color: convergenceColor,
														fontFamily: "monospace",
														fontSize: "12px",
														fontWeight: "bold",
														opacity: 0.95,
														pointerEvents: "none",
													}}
												>
													Cloud: {convergenceText}
												</div>
												<div
													style={{
														position: "absolute",
														top: 8,
														left: 8,
														padding: "6px 8px",
														borderRadius: "6px",
														border: "1px solid #334155",
														backgroundColor: "#0f172a",
														color: "#e2e8f0",
														fontFamily: "monospace",
														fontSize: "10px",
														opacity: 0.95,
														pointerEvents: "none",
													}}
												>
													<div>ABS RMSE: {cloudStats ? cloudStats.abs.rmse.toFixed(2) : "-"} m</div>
													<div>ABS MAE: {cloudStats ? cloudStats.abs.mae.toFixed(2) : "-"} m</div>
													<div style={{ marginTop: 4 }}>
														ALIGNED RMSE: {cloudStats ? cloudStats.aligned.rmse.toFixed(2) : "-"} m
													</div>
													<div>ALIGNED MAE: {cloudStats ? cloudStats.aligned.mae.toFixed(2) : "-"} m</div>
													<div style={{ marginTop: 4 }}>
														PAIRWISE |Δd| MAE: {cloudStats ? cloudStats.pairwiseDistMae.toFixed(2) : "-"} m
													</div>
													<div style={{ opacity: 0.7 }}>
														N: {cloudStats ? cloudStats.n : 0} | Pairs: {cloudStats ? cloudStats.pairs : 0}
													</div>
												</div>
												<svg
													width="100%"
													height="100%"
													viewBox={`0 0 ${width} ${height}`}
													preserveAspectRatio="xMidYMid meet"
												>
													{/* Edges */}
													{uniqueRecords.map((r) => {
														const source = recordsForView.find((s) => s.nodeId === r.nodeId) ?? r;
														const start = transform(source.position.x, source.position.y);
														return r.neighbors.map((n) => {
															const target = recordsForView.find((s) => s.nodeId === n.id);
															if (!target) return null;
															const end = transform(target.position.x, target.position.y);

															// Calculate midpoint for text
															const midX = start.x + (end.x - start.x) * 0.3; // 30% from source
															const midY = start.y + (end.y - start.y) * 0.3;

															return (
																<g key={`${r.nodeId}-${n.id}`}>
																	<line
																		x1={start.x}
																		y1={start.y}
																		x2={end.x}
																		y2={end.y}
																		stroke="#334155"
																		strokeWidth="1"
																		opacity="0.5"
																	/>
																	<text
																		x={midX}
																		y={midY}
																		fill="#94a3b8"
																		fontSize="8"
																		fontFamily="monospace"
																		textAnchor="middle"
																		style={{ pointerEvents: "none" }}
																	>
																		{n.range.toFixed(1)}m / {((n.aoa * 180) / Math.PI).toFixed(0)}° {/*HERE LOL*/}
																	</text>
																</g>
															);
														});
													})}

													{/* Nodes */}
													{recordsForView.map((r) => {
														const pos = transform(r.position.x, r.position.y);
														const panic = isPanicActive(r.nodeId);
														return (
															<g key={r.nodeId} transform={`translate(${pos.x}, ${pos.y})`}>
																<circle
																	r="6"
																	fill={r.status === "STABLE" ? "#4ade80" : "#facc15"}
																	stroke={panic ? "#ef4444" : "#0f172a"}
																	strokeWidth={panic ? 2.5 : 1}
																/>
																<text
																	y="-10"
																	textAnchor="middle"
																	fill="#cbd5e1"
																	fontSize="10"
																	fontFamily="monospace"
																	fontWeight="bold"
																>
																	{r.nodeId}
																</text>
															</g>
														);
													})}
												</svg>
											</>
										);
									})()}
								</div>
							) : (
								<div style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "8px" }}>
									{cloudEvents.map((e) => (
										<div
											key={e.id}
											style={{
												padding: "4px",
												borderBottom: "1px solid #1e293b",
												fontFamily: "monospace",
												fontSize: "10px",
												color: e.level === "ERROR" ? "#f87171" : e.level === "WARN" ? "#facc15" : "#cbd5e1",
											}}
										>
											<span style={{ opacity: 0.5 }}>[{(e.timestamp / 1000).toFixed(1)}s]</span> {e.kind}
											{e.nodeId !== undefined ? ` node ${e.nodeId}` : ""}: {e.message}
										</div>
									))}
									{cloudEvents.length === 0 && (
										<div style={{ padding: "8px", textAlign: "center", color: "#64748b", fontSize: "10px" }}>
											No events yet.
										</div>
									)}
								</div>
							)}
						</DraggableWindow>
					)}
					{showPacketSniffer && (
						<DraggableWindow
							id="sniffer"
							title="AIR GAP SNIFFER"
							icon={Radio}
							initialX={800}
							initialY={400}
							onClose={() => setShowPacketSniffer(false)}
							onFocus={() => focusWindow("sniffer")}
							zIndex={100}
						>
							<div
								style={{
									padding: "8px",
									borderBottom: "1px solid #334155",
									display: "flex",
									gap: "6px",
									alignItems: "center",
									justifyContent: "space-between",
								}}
							>
								<div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
									{["ALL", "HELLO", "DATA", "ELECTION", "PANIC"].map((f) => (
										<button
											key={f}
											onClick={() => setPacketFilter(f)}
											style={{
												fontSize: "9px",
												padding: "4px 8px",
												borderRadius: "4px",
												border: "none",
												backgroundColor: packetFilter === f ? "#38bdf8" : "#1e293b",
												color: packetFilter === f ? "#0f172a" : "#94a3b8",
												cursor: "pointer",
											}}
										>
											{f}
										</button>
									))}
								</div>
								<div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
									<button
										onClick={() => setPackets([])}
										style={{
											fontSize: "9px",
											padding: "4px 8px",
											borderRadius: "4px",
											border: "none",
											backgroundColor: "#1e293b",
											color: "#94a3b8",
											cursor: "pointer",
										}}
									>
										Clear
									</button>
									<button
										onClick={exportSnifferPackets}
										style={{
											fontSize: "9px",
											padding: "4px 8px",
											borderRadius: "4px",
											border: "none",
											backgroundColor: "#1e293b",
											color: "#94a3b8",
											cursor: "pointer",
										}}
									>
										Export
									</button>
								</div>
							</div>
							<div style={{ display: "flex", flexDirection: "column", gap: "2px", padding: "8px" }}>
								{packets
									.filter((p) => packetFilter === "ALL" || p.type === packetFilter)
									.map((p) => {
										const srcNode = nodes.find((n) => n.id === p.srcId);
										const stateColor =
											srcNode?.firmwareState === "MOVING"
												? "#facc15"
												: srcNode?.firmwareState === "ISOLATED"
													? "#ef4444"
													: srcNode?.firmwareState === "STATIONARY"
														? "#4ade80"
														: "#94a3b8";
										const payloadKind =
											p.type === PacketType.DATA && p.payload && typeof p.payload === "object" && "type" in p.payload
												? String((p.payload as { type?: unknown }).type ?? "DATA")
												: undefined;
										const displayType = payloadKind ?? p.type;
										return (
											<div
												key={p.id}
												style={{
													padding: "4px",
													borderBottom: "1px solid #1e293b",
													fontFamily: "monospace",
													fontSize: "9px",
													color: "#cbd5e1",
													display: "flex",
													gap: "8px",
													borderLeft: `3px solid ${stateColor}`,
													backgroundColor: `${stateColor}14`,
												}}
											>
												<span style={{ fontWeight: "bold", color: getPacketColor(p.type) }}>{displayType}</span>
												<span>
													ID:{p.srcId} → {p.destId === -1 ? "ALL" : `ID:${p.destId}`}
												</span>
											</div>
										);
									})}
							</div>
						</DraggableWindow>
					)}

					{/* BATTERY MONITOR WINDOW */}
					{showBatteryMonitor && (
						<DraggableWindow
							id="battery"
							title="SYSTEM BATTERY AVG"
							icon={TrendingDown}
							initialX={50}
							initialY={500}
							onClose={() => setShowBatteryMonitor(false)}
							onFocus={() => focusWindow("battery")}
							zIndex={100}
						>
							<div style={{ padding: "10px", height: "150px" }}>
								<svg
									width="100%"
									height="100%"
									viewBox="0 0 50 100"
									preserveAspectRatio="none"
									style={{ borderLeft: "1px solid #334155", borderBottom: "1px solid #334155" }}
								>
									<polyline
										points={energyHistory.map((val, i) => `${i},${100 - val}`).join(" ")}
										fill="none"
										stroke="#10b981"
										strokeWidth="2"
									/>
								</svg>
							</div>
						</DraggableWindow>
					)}
					{showFilterConfiguration && (
						<DraggableWindow
							id="kalman"
							title="Kalman Filter"
							icon={Wrench}
							initialX={200}
							initialY={100}
							initialHeight={705}
							initialWidth={1100}
							onClose={() => setShowFilterConfiguration(false)}
							onFocus={() => focusWindow("kalman")}
							zIndex={100}
						>
						<EKFCanvas />
							
						</DraggableWindow>
					)}
					

					{/* ... (Existing Inspectors & SVG Rendering Logic) ... */}
					{openWindows.map((id) => {
						const node = nodes.find((n) => n.id === id);
						if (!node) return null;
						return (
							<DraggableWindow
								key={id}
								id={id}
								title={`NODE ${id}`}
								icon={Search}
								initialX={400}
								initialY={100}
								onClose={closeNodeWindow}
								onFocus={focusWindow}
								zIndex={windowOrder.indexOf(id) + 20}
							>
								<div style={{ padding: "12px" }}>
									<div style={styles.inspectorRow}>
										<span>ROLE</span>
										<span>{node.role}</span>
									</div>
									<div style={styles.inspectorRow}>
										<span>BATTERY</span>
										<span style={{ color: node.battery > 30 ? "#4ade80" : "#f87171" }}>{node.battery}%</span>
									</div>
									<div style={styles.inspectorRow}>
										<span>NEXT HOP</span>
										<span>{node.nextHop ? `ID:${node.nextHop}` : "NONE"}</span>
									</div>

									<div style={{ marginTop: "10px", fontSize: "10px", fontWeight: "bold" }}>COOP LOCALIZATION</div>
									{(() => {
										const globalPos = node.getEstimatedGlobalPosition();
										if (globalPos) {
											return (
												<div style={styles.inspectorRow}>
													<span>GLOBAL POS</span>
													<div style={{ textAlign: "right" }}>
														<div>
															{globalPos.lat.toFixed(5)}, {globalPos.lng.toFixed(5)}
														</div>
														<div style={{ color: "#64748b", fontSize: "9px" }}>
															Alt: {globalPos.alt?.toFixed(1) ?? 0}m
														</div>
													</div>
												</div>
											);
										} else {
											const localPos = node.getEstimatedLocalPosition();
											return (
												<div style={styles.inspectorRow}>
													<span>LOCAL POS (Rel)</span>
													<span>{localPos ? `(${localPos.x.toFixed(2)}, ${localPos.y.toFixed(2)})` : "N/A"}</span>
												</div>
											);
										}
									})()}
									<div style={{ marginTop: "5px", fontSize: "9px", color: "#94a3b8" }}>RANGING DATA</div>
									<div style={{ backgroundColor: "rgba(0,0,0,0.2)", maxHeight: "80px", overflowY: "auto" }}>
										{Array.from(node.neighbors.values()).map((n) => (
											<div key={n.id} style={{ ...styles.inspectorRow, borderBottom: "1px dashed #334155" }}>
												<span>ID:{n.id}</span>
												<div style={{ textAlign: "right" }}>
													<div>{n.rangeMeters !== undefined ? `${n.rangeMeters.toFixed(2)}m` : "N/A"}</div>
													{n.aoa !== undefined && (
														<div style={{ color: "#f472b6" }}>AoA: {((n.aoa * 180) / Math.PI).toFixed(1)}°</div>
													)}
												</div>
											</div>
										))}
									</div>

									<div style={{ marginTop: "10px", fontSize: "10px", fontWeight: "bold" }}>NEIGHBORS</div>
									<div style={{ backgroundColor: "rgba(0,0,0,0.2)", maxHeight: "120px", overflowY: "auto" }}>
										{Array.from(node.neighbors.values()).map((n) => (
											<div key={n.id} style={{ ...styles.inspectorRow, borderBottom: "1px dashed #334155" }}>
												<span>ID:{n.id}</span>
												<span>{n.role}</span>
											</div>
										))}
									</div>
								</div>
							</DraggableWindow>
						);
					})}
					<svg
						width="100%"
						height="100%"
						viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
						onContextMenu={(e) => e.preventDefault()}
						ref={svgRef}
					>
						<defs>
							<pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
								<path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" strokeWidth="1" />
							</pattern>
						</defs>
						<rect width="100%" height="100%" fill="url(#grid)" />
						{/* Arena bounds (matches experiment world bounds) */}
						<g style={{ pointerEvents: "none" }}>
							<rect
								x={WORLD_BOUNDS_PX.minX}
								y={WORLD_BOUNDS_PX.minY}
								width={WORLD_BOUNDS_PX.maxX - WORLD_BOUNDS_PX.minX}
								height={WORLD_BOUNDS_PX.maxY - WORLD_BOUNDS_PX.minY}
								fill="none"
								stroke="#38bdf8"
								strokeWidth={2}
								strokeDasharray="6 4"
								opacity={0.45}
							/>
							<text
								x={WORLD_BOUNDS_PX.minX + 6}
								y={WORLD_BOUNDS_PX.minY + 14}
								fill="#38bdf8"
								fontSize="10"
								fontFamily="monospace"
								opacity={0.8}
							>
								{ARENAHEADER}
							</text>

							{/* X-Axis Labels */}
							{Array.from({ length: 9 }).map((_, i) => {
								const m = i * 10; // 0, 10, 20...
								if (m > 50) return null;
								const px = WORLD_BOUNDS_PX.minX + m * PIXELS_PER_METER;
								return (
									<g key={`x-axis-${m}`} transform={`translate(${px}, ${WORLD_BOUNDS_PX.minY - 5})`}>
										<line y1="0" y2="5" stroke="#38bdf8" strokeWidth="1" opacity="0.5" />
										<text y="-4" textAnchor="middle" fill="#38bdf8" fontSize="9" fontFamily="monospace" opacity="0.8">
											{m}m
										</text>
									</g>
								);
							})}
							{/* Y-Axis Labels */}
							{Array.from({ length: 6 }).map((_, i) => {
								const m = i * 10;
								if (m > 40) return null;
								const py = WORLD_BOUNDS_PX.minY + m * PIXELS_PER_METER;
								return (
									<g key={`y-axis-${m}`} transform={`translate(${WORLD_BOUNDS_PX.minX - 5}, ${py})`}>
										<line x1="0" x2="5" stroke="#38bdf8" strokeWidth="1" opacity="0.5" />
										<text
											x="-4"
											y="3"
											textAnchor="end"
											fill="#38bdf8"
											fontSize="9"
											fontFamily="monospace"
											opacity="0.8"
										>
											{m}m
										</text>
									</g>
								);
							})}
						</g>
						{/* GHOST GRAPH VISUALIZATION (Cooperative Localization Belief) */}
						{(() => {
							if (windowOrder.length === 0) return null;
							const focusedId = windowOrder[windowOrder.length - 1];
							const node = nodes.find((n) => n.id === focusedId);
							if (!node) return null;

							const localGraph = node.getLocalGraph();
							const selfPose = localGraph.get(node.id);
							if (!selfPose) return null;

							// Ghost origin = where this node started (spawn position) in screen coordinates.
							const originScreenX = node.spawnX;
							const originScreenY = node.spawnY;

							return (
								<g key={`ghost-group-${node.id}`}>
									{/* GHOST ORIGIN MARKER (spawn position) */}
									<g style={{ pointerEvents: "none" }}>
										<line
											x1={originScreenX - 5}
											y1={originScreenY}
											x2={originScreenX + 5}
											y2={originScreenY}
											stroke="#38bdf8"
											strokeWidth={2}
										/>
										<line
											x1={originScreenX}
											y1={originScreenY - 5}
											x2={originScreenX}
											y2={originScreenY + 5}
											stroke="#38bdf8"
											strokeWidth={2}
										/>
										<text
											x={originScreenX + 6}
											y={originScreenY + 3}
											fill="#38bdf8"
											fontSize="9"
											fontFamily="monospace"
											fontWeight="bold"
										>
											ORIGIN
										</text>
										<line
											x1={node.x}
											y1={node.y}
											x2={originScreenX}
											y2={originScreenY}
											stroke="#38bdf8"
											strokeWidth={1}
											strokeDasharray="2 2"
											opacity={0.3}
										/>
									</g>

									{Array.from(localGraph.entries()).map(([id, pose]) => {
										if (id === node.id) return null;

										const relX = pose.x - selfPose.x;
										const relY = pose.y - selfPose.y;

										const screenX = node.x + relX * PIXELS_PER_METER;
										const screenY = node.y + relY * PIXELS_PER_METER;

										return (
											<g key={`ghost-${node.id}-${id}`} style={{ pointerEvents: "none" }}>
												<circle
													cx={screenX}
													cy={screenY}
													r={6}
													fill="none"
													stroke="#f472b6"
													strokeWidth={1}
													strokeDasharray="3 3"
												/>
												<line
													x1={node.x}
													y1={node.y}
													x2={screenX}
													y2={screenY}
													stroke="#f472b6"
													strokeWidth={0.5}
													strokeDasharray="3 3"
													opacity={0.5}
												/>
												<text x={screenX + 8} y={screenY + 3} fill="#f472b6" fontSize="9" fontFamily="monospace">
													Est:{id}
												</text>
											</g>
										);
									})}
								</g>
							);
						})()}
						{config.showRange &&
							nodes.map((n) => (
								<circle
									key={`r-${n.id}`}
									cx={n.x}
									cy={n.y}
									r={config.uwbRange * PIXELS_PER_METER}
									fill="none"
									stroke="#334155"
									strokeDasharray="4 4"
									opacity="0.3"
									pointerEvents="none"
								/>
							))}
						{links.map((l, i) => {
							const midX = (l.source.x + l.target.x) / 2;
							const midY = (l.source.y + l.target.y) / 2;
							const distMeters = l.dist / PIXELS_PER_METER;
							return (
								<g key={i} style={{ pointerEvents: "none" }}>
									<line
										x1={l.source.x}
										y1={l.source.y}
										x2={l.target.x}
										y2={l.target.y}
										stroke="#475569"
										strokeOpacity={0.3}
										strokeWidth={1}
									/>
									<text
										x={midX}
										y={midY - 6}
										fill="#cbd5e1"
										fontSize="9"
										fontFamily="monospace"
										textAnchor="middle"
										style={{ opacity: 0.8 }}
									>
										{distMeters.toFixed(2)}m
									</text>
								</g>
							);
						})}
						{walls.map((w) => (
							<line
								key={w.id}
								x1={w.x1}
								y1={w.y1}
								x2={w.x2}
								y2={w.y2}
								stroke="#facc15"
								strokeWidth={4}
								strokeLinecap="round"
							/>
						))}
						{isDrawingWall && wallStart && (
							<line
								x1={wallStart.x}
								y1={wallStart.y}
								x2={wallEnd?.x || wallStart.x}
								y2={wallEnd?.y || wallStart.y}
								stroke="#facc15"
								strokeWidth={2}
								strokeDasharray="4 4"
							/>
						)}
						{visualPackets.map((vp) => {
							const srcNode = nodes.find((n) => n.id === vp.sourceId);
							const stateColor =
								srcNode?.firmwareState === "MOVING"
									? "#facc15"
									: srcNode?.firmwareState === "ISOLATED"
										? "#ef4444"
										: srcNode?.firmwareState === "STATIONARY"
											? "#4ade80"
											: undefined;
							const packetColor = stateColor ?? getPacketColor(vp.packet.type);
							if (vp.style === "RING") {
								const radius = (vp.maxRadius || 100) * vp.progress;
								const opacity = (1.0 - vp.progress) * 0.3;
								return (
									<circle
										key={vp.id}
										cx={vp.x}
										cy={vp.y}
										r={radius}
										fill="none"
										stroke={packetColor}
										strokeWidth={2}
										strokeOpacity={opacity}
										pointerEvents="none"
									/>
								);
							} else {
								return <circle key={vp.id} cx={vp.x} cy={vp.y} r={3} fill={packetColor} pointerEvents="none" />;
							}
						})}
						{nodes.map((n) => {
							const color = getNodeColor(n);
							let Icon = Activity;
							if (n.role === NodeRole.ROOT) Icon = Wifi;
							if (n.role === NodeRole.LEADER) Icon = Zap;
							if (n.role === NodeRole.ISOLATED && n.isolationTimer > config.isolationTimeout) Icon = Wifi;
							return (
								<g
									key={n.id}
									transform={`translate(${n.x},${n.y})`}
									onMouseDown={(e) => handleMouseDown(e, n.id)}
									onClick={() => {
										if (!n.isDragging) n.toggleMode();
									}}
									onContextMenu={(e) => {
										e.preventDefault();
										setContextMenu({ x: e.clientX, y: e.clientY, nodeId: n.id });
									}}
									style={{ cursor: "grab" }}
								>
									{openWindows.includes(n.id) && (
										<circle r="24" fill="none" stroke="white" strokeWidth="1" strokeDasharray="2 2" opacity="0.8">
											<animateTransform
												attributeName="transform"
												type="rotate"
												from="0 0 0"
												to="360 0 0"
												dur="3s"
												repeatCount="indefinite"
											/>
										</circle>
									)}
									{n.role === NodeRole.ISOLATED && n.isolationTimer > config.isolationTimeout && (
										<circle r="30" fill="none" stroke="#ef4444" strokeWidth="2" opacity="0.5">
											<animate attributeName="r" from="20" to="50" dur="1s" repeatCount="indefinite" />
											<animate attributeName="opacity" from="1" to="0" dur="1s" repeatCount="indefinite" />
										</circle>
									)}
									{n.isGossiping && (
										<foreignObject x="15" y="-25" width="20" height="20">
											<MessageSquare size={14} color="#38bdf8" fill="#0f172a" />
										</foreignObject>
									)}
									{n.isElecting && (
										<foreignObject x="-30" y="-25" width="20" height="20">
											<Scale size={14} color="#a855f7" fill="#0f172a" />
										</foreignObject>
									)}
									<circle r="18" fill="#0f172a" stroke={color} strokeWidth="3" />
									<foreignObject x="-10" y="-10" width="20" height="20" style={{ pointerEvents: "none" }}>
										<div
											style={{
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
												height: "100%",
												color: color,
											}}
										>
											<Icon size={14} />
										</div>
									</foreignObject>
									<text
										y="32"
										textAnchor="middle"
										fill={color}
										fontSize="10"
										fontWeight="bold"
										fontFamily="monospace"
										pointerEvents="none"
									>
										{n.type === "HARDWARE_GW" ? "HW_GW" : n.role === NodeRole.LEADER ? "ELECTED" : `ID:${n.id}`}
									</text>
									<text
										y="44"
										textAnchor="middle"
										fill="#64748b"
										fontSize="9"
										fontFamily="monospace"
										pointerEvents="none"
									>
										{n.firmwareState}
									</text>
									<g transform="translate(12, 12)">
										<rect x="0" y="0" width="16" height="8" rx="2" fill="#020617" stroke="#475569" strokeWidth="1" />
										<rect
											x="2"
											y="2"
											width={Math.max(0, (n.battery / 100) * 12)}
											height="4"
											rx="1"
											fill={n.battery > 30 ? "#22c55e" : "#ef4444"}
										/>
										<text x="18" y="8" fill="#cbd5e1" fontSize="8" fontFamily="monospace" fontWeight="bold">
											{n.battery}%
										</text>
									</g>
								</g>
							);
						})}
					</svg>
				</div>
			</div>
			{contextMenu && (
				<div
					style={{
						position: "fixed",
						top: contextMenu.y,
						left: contextMenu.x,
						backgroundColor: "#1e293b",
						border: "1px solid #334155",
						borderRadius: "4px",
						padding: "4px",
						zIndex: 1000,
						display: "flex",
						flexDirection: "column",
						gap: "2px",
						boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
					}}
				>
					<button
						style={{
							...styles.btn,
							justifyContent: "flex-start",
							backgroundColor: "transparent",
							color: "#f1f5f9",
						}}
						onClick={() => {
							openNodeWindow(contextMenu.nodeId);
							setContextMenu(null);
						}}
					>
						<Search size={12} /> Inspect Node
					</button>
					<button
						style={{
							...styles.btn,
							justifyContent: "flex-start",
							backgroundColor: "transparent",
							color: "#f1f5f9",
						}}
						onClick={handleSetGlobalPosition}
					>
						<Wifi size={12} /> Set Global Position
					</button>
					<button
						style={{
							...styles.btn,
							justifyContent: "flex-start",
							backgroundColor: "transparent",
							color: "#f1f5f9",
						}}
						onClick={handleSetBatteryLife}
					>
						<Zap size={12} /> Set Battery Life
					</button>
					<button
						style={{
							...styles.btn,
							justifyContent: "flex-start",
							backgroundColor: "transparent",
							color: "#ef4444",
						}}
						onClick={() => setContextMenu(null)}
					>
						<XCircle size={12} /> Cancel
					</button>
				</div>
			)}
		</>
	);
};

export default App;
