export type NodeType = 'HARDWARE_GW' | 'TRACKER';

export enum NodeRole {
  ROOT = 'ROOT',
  LEADER = 'LEADER',
  RELAY = 'RELAY',
  IDLE = 'IDLE',
  ISOLATED = 'ISOLATED'
}

export enum PacketType {
  HELLO = 'HELLO',
  DATA = 'DATA',         
  ELECTION = 'ELECTION', 
  PANIC = 'PANIC',       
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
  progress: number; 
  speed: number;
  style: 'LINE' | 'RING'; 
  maxRadius?: number;     
}

export interface NeighborEntry {
  id: number;
  role: NodeRole;
  battery: number;
  hopsToGw: number;
  lastSeen: number;
  rssi: number;
  // --- GOSSIP DATA ---
  leaderId?: number; 
  leaderBat?: number;
  parentId?: number;
  neighborCount?: number; // <--- NEW: For "Most Neighbors" logic
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
  type: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
  category: 'CLOUD' | 'PACKET' | 'SYS';
}