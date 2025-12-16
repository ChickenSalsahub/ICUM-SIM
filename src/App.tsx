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
} from "lucide-react";
import { NodeFirmware } from "./logic/NodeFirmware";
import { CloudBackend, FusedRecord } from "./logic/CloudBackend";
import { DraggableWindow } from "./components/DraggableWindow";
import {
	NodeConfig,
	LogEntry,
	NodeRole,
	NodeType,
	Packet,
	PacketType,
	VisualPacket,
	Wall,
	HardwareInterface,
} from "./types";
import UWBRanging from "./logic/UWBRanging";

const PIXELS_PER_METER = 20;
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 800;

interface Link {
	source: NodeFirmware;
	target: NodeFirmware;
	dist: number;
}

const doIntersect = (
	p1: { x: number; y: number },
	q1: { x: number; y: number },
	p2: { x: number; y: number },
	q2: { x: number; y: number }
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

const App: React.FC = () => {
	const [nodes, setNodes] = useState<NodeFirmware[]>([]);
	const [links, setLinks] = useState<Link[]>([]);
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [packets, setPackets] = useState<Packet[]>([]);
	const [visualPackets, setVisualPackets] = useState<VisualPacket[]>([]);
	const [fusedRecords, setFusedRecords] = useState<FusedRecord[]>([]);

	const [walls, setWalls] = useState<Wall[]>([]);
	const [isDrawingWall, setIsDrawingWall] = useState(false);
	const [wallStart, setWallStart] = useState<{ x: number; y: number } | null>(null);
	const [wallEnd, setWallEnd] = useState<{ x: number; y: number } | null>(null);

	const [energyHistory, setEnergyHistory] = useState<number[]>(new Array(50).fill(100));

	const [showCloudLogs, setShowCloudLogs] = useState(false);
	const [showPacketSniffer, setShowPacketSniffer] = useState(false);
	const [showBatteryMonitor, setShowBatteryMonitor] = useState(false);
	const [cloudViewMode, setCloudViewMode] = useState<"RAW" | "FUSED" | "TOPOLOGY">("FUSED");

	const [packetFilter, setPacketFilter] = useState<string>("ALL");
	const [tick, setTick] = useState(0);
	const [isPlaying, setIsPlaying] = useState(true);

	const [config, setConfig] = useState<NodeConfig>({
		uwbRange: 15,
		isolationTimeout: 5,
		movingSpeed: 0.8,
		showRange: false,
		maxLeaders: 1,
		minClusterSize: 5,
	});

	const nodesRef = useRef<NodeFirmware[]>([]);
	const cloudBackendRef = useRef<CloudBackend>(new CloudBackend());
	const visualPacketsRef = useRef<VisualPacket[]>([]);
	const wallsRef = useRef<Wall[]>([]);
	const uwbRef = useRef(new UWBRanging(PIXELS_PER_METER));
	const prevOdomRef = useRef<Map<number, { x: number; y: number; t: number }>>(new Map());
	const animationRef = useRef<number | undefined>(undefined);
	const lastTimeRef = useRef<number>(0);
	const energyTimerRef = useRef<number>(0);

	const [openWindows, setOpenWindows] = useState<number[]>([]);
	const [windowOrder, setWindowOrder] = useState<number[]>([]);
	const draggedNodeIdRef = useRef<number | null>(null);
	const dragStartPosRef = useRef({ x: 0, y: 0 });
	const dragOffsetRef = useRef({ x: 0, y: 0 });
	const svgRef = useRef<SVGSVGElement>(null);

	// Global Ether Queue (Simulating the Air)
	const txQueueRef = useRef<{ senderId: number; packet: Packet }[]>([]);

	const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: number } | null>(null);

	const createNode = (id: number, type: NodeType, x: number, y: number) => {
		prevOdomRef.current.set(id, { x, y, t: Date.now() });

		const hal: HardwareInterface = {
			radioSend: (packet) => {
				txQueueRef.current.push({ senderId: id, packet });
				// Simulate TX Complete callback immediately or next tick?
				// For now, we assume fire-and-forget or immediate completion
			},
			getTimeMs: () => Date.now(),
			getRandom: () => Math.random(),
			isMoving: () => {
				const node = nodesRef.current.find((n) => n.id === id);
				if (!node) return false;
				const dist = Math.sqrt(Math.pow(node.targetX - node.x, 2) + Math.pow(node.targetY - node.y, 2));
				return dist > 10.0;
			},
			getOdometryMeters: () => {
				const now = Date.now();
				const node = nodesRef.current.find((n) => n.id === id);
				if (!node) return { dx: 0, dy: 0, dTheta: 0, timestamp: now };

				const prev = prevOdomRef.current.get(id) || { x: node.x, y: node.y, t: now };
				const dxPx = node.x - prev.x;
				const dyPx = node.y - prev.y;
				prevOdomRef.current.set(id, { x: node.x, y: node.y, t: now });

				return { dx: dxPx / PIXELS_PER_METER, dy: dyPx / PIXELS_PER_METER, dTheta: 0, timestamp: now };
			},
			log: (_msg) => {
				// console.log(`[Node ${id}] ${msg}`);
			},
		};
		return new NodeFirmware(id, type, x, y, hal);
	};

	useEffect(() => {
		nodesRef.current = nodes;
	}, [nodes]);
	useEffect(() => {
		wallsRef.current = walls;
	}, [walls]);

	useEffect(() => {
		const initial: NodeFirmware[] = [];
		setNodes(initial);
		nodesRef.current = initial;
	}, []);

	const addLog = useCallback((msg: string, type: LogEntry["type"], category: LogEntry["category"]) => {
		const time = new Date().toLocaleTimeString().split(" ")[0];
		const entry: LogEntry = { id: Math.random().toString(36), time, msg, type, category };
		setLogs((prev) => [entry, ...prev].slice(0, 100));
	}, []);

	const capturePacket = useCallback((p: Packet) => {
		setPackets((prev) => [p, ...prev].slice(0, 50));
	}, []);

	const gameLoop = useCallback(
		(timestamp: number) => {
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
						let tx = vp.x;
						let ty = vp.y;
						if (targetNode) {
							tx = vp.startX + (targetNode.x - vp.startX) * vp.progress;
							ty = vp.startY + (targetNode.y - vp.startY) * vp.progress;
						}
						vp.x = tx;
						vp.y = ty;

						for (const w of currentWalls) {
							if (
								doIntersect(
									{ x: vp.startX, y: vp.startY },
									{ x: vp.x, y: vp.y },
									{ x: w.x1, y: w.y1 },
									{ x: w.x2, y: w.y2 }
								)
							) {
								return null;
							}
						}
					}
					return vp;
				})
				.filter((vp): vp is VisualPacket => vp !== null && vp.progress < 1.0);

			// 2. ETHER & PHYSICS
			while (txQueueRef.current.length > 0) {
				const item = txQueueRef.current.shift();
				if (!item) continue;

				const sender = currentNodes.find((n) => n.id === item.senderId);
				if (!sender) continue;

				const packet = item.packet;
				capturePacket(packet);

				// Visuals
				if (packet.destId === -1) {
					newVisuals.push({
						id: Math.random().toString(),
						packet: packet,
						x: sender.x,
						y: sender.y,
						startX: sender.x,
						startY: sender.y,
						targetId: -1,
						progress: 0,
						speed: packet.type === PacketType.DATA ? 2.5 : 2.0,
						style: "RING",
						maxRadius: rangePx,
					});
				}

				// Propagation
				currentNodes.forEach((receiver) => {
					if (sender.id === receiver.id) return;
					if (packet.destId !== -1 && packet.destId !== receiver.id) return;

					const dist = Math.sqrt(Math.pow(sender.x - receiver.x, 2) + Math.pow(sender.y - receiver.y, 2));

					if (dist <= rangePx) {
						let blocked = false;
						for (const w of currentWalls) {
							if (
								doIntersect(
									{ x: sender.x, y: sender.y },
									{ x: receiver.x, y: receiver.y },
									{ x: w.x1, y: w.y1 },
									{ x: w.x2, y: w.y2 }
								)
							) {
								blocked = true;
								break;
							}
						}

						if (!blocked) {
							// Packet Loss (10%)
							if (Math.random() > 0.1) {
								// Ranging Simulation
								if (packet.payload?.type === "RANGING_POLL") {
									const measurement = uwbRef.current.measure(
										{ id: sender.id, x: sender.x, y: sender.y },
										{ id: receiver.id, x: receiver.x, y: receiver.y },
										{ pixelsPerMeter: PIXELS_PER_METER, maxRangeMeters: config.uwbRange, walls: currentWalls }
									);

									if (measurement.success) {
										const responsePacket: Packet = {
											id: `resp-${receiver.id}-${sender.id}-${Date.now()}`,
											type: PacketType.DATA,
											srcId: receiver.id,
											destId: sender.id,
											payload: {
												type: "RANGING_RESPONSE",
												distance: measurement.measuredDistanceMeters,
												aoa: measurement.aoa,
												aod: measurement.aod,
												tof: measurement.timeOfFlightSeconds,
												los: measurement.los,
											},
											timestamp: Date.now(),
										};

										// Schedule Response
										setTimeout(() => {
											txQueueRef.current.push({ senderId: receiver.id, packet: responsePacket });
										}, 10);
									}
								} else {
									// Normal Delivery
									if (receiver.hal.onRx) {
										receiver.hal.onRx(packet);
									}
								}

								if (packet.destId !== -1) {
									newVisuals.push({
										id: Math.random().toString(),
										packet: packet,
										x: sender.x,
										y: sender.y,
										startX: sender.x,
										startY: sender.y,
										targetId: receiver.id,
										progress: 0,
										speed: 2.5,
										style: "LINE",
									});
								}
							}
						}
					}
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

			// 4. FIRMWARE & PHYSICS
			let totalBat = 0;
			currentNodes.forEach((node) => {
				node.isDragging = node.id === draggedNodeIdRef.current;

				// Physics Update
				if (node.state === "MOVING" && !node.isDragging) {
					const dist = Math.sqrt(Math.pow(node.targetX - node.x, 2) + Math.pow(node.targetY - node.y, 2));
					if (dist < 10) {
						node.targetX = Math.random() * 1100 + 50;
						node.targetY = Math.random() * 700 + 50;
					} else {
						node.battery = Math.max(0, node.battery - 0.01 * deltaTime);
						const moveStep = config.movingSpeed * 100 * deltaTime;
						node.x += ((node.targetX - node.x) / dist) * moveStep;
						node.y += ((node.targetY - node.y) / dist) * moveStep;
					}
				}

				// Firmware Tick
				node.tick(deltaTime);
				totalBat += node.battery;

				// Cloud Ingestion
				if (node.role === NodeRole.ROOT || node.role === NodeRole.LEADER) {
					// 1. Gateway/Leader's Own Sightings
					while (node.sightingQueue.length > 0) {
						const sighting = node.sightingQueue.shift();
						if (sighting) {
							cloudBackendRef.current.ingest({
								nodeId: node.id,
								timestamp: sighting.timestamp,
								neighbors: [{ id: sighting.targetId, range: sighting.distance }],
								battery: node.battery,
								x: node.x / PIXELS_PER_METER,
								y: node.y / PIXELS_PER_METER,
								status: node.state,
							});
						}
					}

					// 2. Forwarded Reports from Mesh (Gossip)
					while (node.cloudQueue.length > 0) {
						const report = node.cloudQueue.shift();
						if (report) {
							cloudBackendRef.current.ingest({
								nodeId: report.nodeId,
								timestamp: report.timestamp,
								neighbors: report.neighbors,
								battery: report.battery,
							});
						}
					}
				} else if (node.role === NodeRole.ISOLATED) {
					// Internet fallback: isolated node reports its own pose directly
					cloudBackendRef.current.ingest({
						nodeId: node.id,
						timestamp: Date.now(),
						x: node.x / PIXELS_PER_METER,
						y: node.y / PIXELS_PER_METER,
						battery: node.battery,
						status: node.state,
					});
				} else {
					// Non-Gateway nodes just clear their local sighting queue (simulating storage limit)
					// In reality, they would aggregate these into the GOSSIP packet sent in runAnchorLogic
					if (node.sightingQueue.length > 50) node.sightingQueue.shift();
				}
			});

			// 5. CLOUD BACKEND TICK
			if (cloudBackendRef.current.tick(Date.now())) {
				setFusedRecords([...cloudBackendRef.current.getRecords()]);
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
		[isPlaying, config, addLog, capturePacket]
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
				node.x = mouseX - dragOffsetRef.current.x;
				node.y = mouseY - dragOffsetRef.current.y;
				node.targetX = node.x;
				node.targetY = node.y;
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
				Math.pow(mouseX - dragStartPosRef.current.x, 2) + Math.pow(mouseY - dragStartPosRef.current.y, 2)
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
		const n = createNode(maxId + 1, type, Math.random() * 1000 + 50, Math.random() * 700 + 50);
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
		prevOdomRef.current.clear();
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
	const getNodeColor = (n: NodeFirmware) => {
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
		const latStr = prompt("Enter Latitude (e.g. 52.5200):");
		const lngStr = prompt("Enter Longitude (e.g. 13.4050):");
		if (latStr && lngStr) {
			const lat = parseFloat(latStr);
			const lng = parseFloat(lngStr);
			if (!isNaN(lat) && !isNaN(lng)) {
				const node = nodesRef.current.find((n) => n.id === contextMenu.nodeId);
				if (node) {
					node.setGlobalPosition(lat, lng);

					// Hack: Tell the Gateway about this anchor so it can compute the graph
					const gateway = nodesRef.current.find((n) => n.type === "HARDWARE_GW");
					if (gateway && gateway.id !== node.id) {
						gateway.coopLoc.addExternalAnchor(node.id, lat, lng);
					}
				}
			}
		}
		setContextMenu(null);
	};

	return (
		<>
			<style>{`body { margin: 0; padding: 0; overflow: hidden; box-sizing: border-box; }`}</style>
			<div
				style={styles.container}
				onMouseUp={handleMouseUp}
				onMouseMove={handleMouseMove}
				onMouseDown={(e) => handleMouseDown(e, "bg")}
			>
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
						<span style={styles.label}>Configuration</span>
						<input
							type="range"
							min="5"
							max="30"
							value={config.uwbRange}
							onChange={(e) => setConfig({ ...config, uwbRange: Number(e.target.value) })}
							style={{ width: "100%" }}
						/>
						<div style={{ fontSize: "9px", color: "#cbd5e1", textAlign: "right" }}>{config.uwbRange}m</div>
						<input
							type="range"
							min="0.1"
							max="3.0"
							step="0.1"
							value={config.movingSpeed}
							onChange={(e) => setConfig({ ...config, movingSpeed: Number(e.target.value) })}
							style={{ width: "100%" }}
						/>
						<div style={{ fontSize: "9px", color: "#cbd5e1", textAlign: "right" }}>{config.movingSpeed}x</div>
						<input
							type="range"
							min="1"
							max="5"
							step="1"
							value={config.maxLeaders}
							onChange={(e) => setConfig({ ...config, maxLeaders: Number(e.target.value) })}
							style={{ width: "100%", accentColor: "#ec4899" }}
						/>
						<div style={{ fontSize: "9px", color: "#f472b6", textAlign: "right" }}>{config.maxLeaders} Leaders</div>

						{/* RESTORED SLIDER */}
						<input
							type="range"
							min="2"
							max="10"
							step="1"
							value={config.minClusterSize}
							onChange={(e) => setConfig({ ...config, minClusterSize: Number(e.target.value) })}
							style={{ width: "100%", accentColor: "#a855f7" }}
						/>
						<div style={{ fontSize: "9px", color: "#a855f7", textAlign: "right" }}>
							Min Size: {config.minClusterSize}
						</div>
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
									onClick={() => setCloudViewMode("FUSED")}
									style={{
										fontSize: "9px",
										padding: "4px 8px",
										borderRadius: "4px",
										border: "none",
										backgroundColor: cloudViewMode === "FUSED" ? "#38bdf8" : "#1e293b",
										color: cloudViewMode === "FUSED" ? "#0f172a" : "#94a3b8",
										cursor: "pointer",
									}}
								>
									FUSED DATA
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
							{cloudViewMode === "FUSED" ? (
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
														{r.position.lat ? r.position.lat.toFixed(6) : "-"},{" "}
														{r.position.lng ? r.position.lng.toFixed(6) : "-"}
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
														{((Date.now() - r.timestamp) / 1000).toFixed(1)}s ago
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
										// Filter to get only the latest record per node for the topology
										const uniqueRecordsMap = new Map<number, FusedRecord>();
										for (const r of fusedRecords) {
											if (!uniqueRecordsMap.has(r.nodeId)) {
												uniqueRecordsMap.set(r.nodeId, r);
											}
										}
										const uniqueRecords = Array.from(uniqueRecordsMap.values());

										if (uniqueRecords.length === 0)
											return (
												<div style={{ padding: 20, color: "#64748b", fontSize: "10px", textAlign: "center" }}>
													No topology data
												</div>
											);

										// Calculate bounds
										const xs = uniqueRecords.map((r) => r.position.x);
										const ys = uniqueRecords.map((r) => r.position.y);
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
											<svg
												width="100%"
												height="100%"
												viewBox={`0 0 ${width} ${height}`}
												preserveAspectRatio="xMidYMid meet"
											>
												{/* Edges */}
												{uniqueRecords.map((r) => {
													const start = transform(r.position.x, r.position.y);
													return r.neighbors.map((n) => {
														const target = uniqueRecords.find((t) => t.nodeId === n.id);
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
																	{n.range.toFixed(1)}m / {((n.aoa * 180) / Math.PI).toFixed(0)}°
																</text>
															</g>
														);
													});
												})}

												{/* Nodes */}
												{uniqueRecords.map((r) => {
													const pos = transform(r.position.x, r.position.y);
													return (
														<g key={r.nodeId} transform={`translate(${pos.x}, ${pos.y})`}>
															<circle r="6" fill={r.status === "STABLE" ? "#4ade80" : "#facc15"} />
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
										);
									})()}
								</div>
							) : (
								<div style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "8px" }}>
									{logs
										.filter((l) => l.category === "CLOUD")
										.map((l) => (
											<div
												key={l.id}
												style={{
													padding: "4px",
													borderBottom: "1px solid #1e293b",
													fontFamily: "monospace",
													fontSize: "10px",
													color: l.type === "SUCCESS" ? "#4ade80" : "#f87171",
												}}
											>
												<span style={{ opacity: 0.5 }}>[{l.time}]</span> {l.msg}
											</div>
										))}
									{logs.filter((l) => l.category === "CLOUD").length === 0 && (
										<div style={{ padding: "8px", textAlign: "center", color: "#64748b", fontSize: "10px" }}>
											No logs yet.
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
							<div style={{ padding: "8px", borderBottom: "1px solid #334155", display: "flex", gap: "4px" }}>
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
							<div style={{ display: "flex", flexDirection: "column", gap: "2px", padding: "8px" }}>
								{packets
									.filter((p) => packetFilter === "ALL" || p.type === packetFilter)
									.map((p) => (
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
											}}
										>
											<span style={{ fontWeight: "bold", color: getPacketColor(p.type) }}>{p.type}</span>
											<span>
												ID:{p.srcId} → {p.destId === -1 ? "ALL" : `ID:${p.destId}`}
											</span>
										</div>
									))}
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
						{/* GHOST GRAPH VISUALIZATION (Cooperative Localization Belief) */}
						{(() => {
							if (windowOrder.length === 0) return null;
							const focusedId = windowOrder[windowOrder.length - 1];
							const node = nodes.find((n) => n.id === focusedId);
							if (!node) return null;

							const localGraph = node.getLocalGraph();
							const selfPose = localGraph.get(node.id);
							if (!selfPose) return null;

							// Calculate Screen Position of Local Origin (0,0)
							const originRelX = 0 - selfPose.x;
							const originRelY = 0 - selfPose.y;
							const originScreenX = node.x + originRelX * PIXELS_PER_METER;
							const originScreenY = node.y + originRelY * PIXELS_PER_METER;

							return (
								<g key={`ghost-group-${node.id}`}>
									{/* LOCAL ORIGIN MARKER */}
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
						{links.map((l, i) => (
							<line
								key={i}
								x1={l.source.x}
								y1={l.source.y}
								x2={l.target.x}
								y2={l.target.y}
								stroke="#475569"
								strokeOpacity={0.3}
								strokeWidth={1}
								pointerEvents="none"
							/>
						))}
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
										stroke={getPacketColor(vp.packet.type)}
										strokeWidth={2}
										strokeOpacity={opacity}
										pointerEvents="none"
									/>
								);
							} else {
								return (
									<circle
										key={vp.id}
										cx={vp.x}
										cy={vp.y}
										r={3}
										fill={getPacketColor(vp.packet.type)}
										pointerEvents="none"
									/>
								);
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
										{n.state}
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
