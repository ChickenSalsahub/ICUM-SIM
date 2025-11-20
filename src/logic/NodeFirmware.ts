import { NodeRole, NodeType, NodeConfig, Packet, PacketType, NeighborEntry } from '../types';

export class NodeFirmware {
  public id: number;
  public type: NodeType;
  public x: number;
  public y: number;
  public targetX: number;
  public targetY: number;
  
  public battery: number;
  public role: NodeRole;
  public state: 'MOVING' | 'STATIONARY';
  
  public neighbors: Map<number, NeighborEntry> = new Map();
  public txQueue: Packet[] = []; 
  
  public hopsToGw: number = 999;
  public nextHop: number | null = null;
  public isolationTimer: number = 0;
  
  public isDragging: boolean = false;
  public isGossiping: boolean = false;
  public isElecting: boolean = false;

  private helloTimer: number;
  private gossipResetTimer: number = 0;
  private dataTimer: number;
  private txCooldownTimer: number = 0;
  
  private HELLO_INTERVAL = 1.0; 
  private NEIGHBOR_TIMEOUT = 3.0;

  constructor(id: number, type: NodeType, x: number, y: number) {
    this.id = id;
    this.type = type;
    this.x = x;
    this.y = y;
    this.targetX = x;
    this.targetY = y;
    this.battery = Math.floor(Math.random() * 40) + 60;
    this.role = type === 'HARDWARE_GW' ? NodeRole.ROOT : NodeRole.IDLE;
    this.state = type === 'TRACKER' ? 'MOVING' : 'STATIONARY';
    if (this.type === 'HARDWARE_GW') this.hopsToGw = 0;

    this.helloTimer = Math.random() * this.HELLO_INTERVAL;
    this.dataTimer = Math.random() * 2.0; 
  }

  public tick(dt: number, config: NodeConfig, rxPackets: Packet[]) {
    this.updateMotion(dt, config);

    // 1. Inbox
    if (rxPackets.length > 0) {
      this.isGossiping = true;
      this.gossipResetTimer = 0.2; 
      this.isolationTimer = 0; 
      if(this.role === NodeRole.ISOLATED) {
          this.changeRole(NodeRole.IDLE, 999, null, PacketType.HELLO);
      }
      
      const batch = rxPackets.slice(0, 5); 
      this.processInbox(batch);
    } else {
      if (this.gossipResetTimer > 0) this.gossipResetTimer -= dt;
      else this.isGossiping = false;
    }

    // 2. Timers
    this.updateTimers(dt);
    if (this.txCooldownTimer > 0) this.txCooldownTimer -= dt;

    // 3. Consensus
    if (this.type !== 'HARDWARE_GW') {
      this.ensureStability(dt, config);
    }
  }

  private processInbox(packets: Packet[]) {
    packets.forEach(p => {
      if (p.type === PacketType.HELLO || p.type === PacketType.ELECTION || p.type === PacketType.PANIC) {
        const existing = this.neighbors.get(p.srcId);
        
        this.neighbors.set(p.srcId, {
          id: p.srcId,
          role: p.payload.role,
          battery: p.payload.battery,
          hopsToGw: p.payload.hopsToGw,
          leaderId: p.payload.leaderId,
          leaderBat: p.payload.leaderBat,
          parentId: p.payload.parentId,
          neighborCount: p.payload.neighborCount, // <--- NEW: GOSSIP NEIGHBOR COUNT
          lastSeen: 0,
          rssi: -50
        });
        
        // If my parent panicked or became isolated, I must panic immediately
        if (this.nextHop === p.srcId && (p.type === PacketType.PANIC || p.payload.hopsToGw >= 999)) {
             this.changeRole(NodeRole.IDLE, 999, null, PacketType.PANIC);
        }
      }

      if (p.type === PacketType.DATA && this.role !== NodeRole.ROOT && this.role !== NodeRole.LEADER) {
         if (this.nextHop !== null && this.nextHop !== p.srcId) {
             if (this.txCooldownTimer <= 0) {
                 this.forwardData(p);
                 this.txCooldownTimer = 0.05; 
             }
         }
      }
    });
  }

  private forwardData(originalPacket: Packet) {
    if (!this.nextHop) return;
    this.txQueue.push({
        id: `${this.id}-FWD-${originalPacket.id}`, 
        type: PacketType.DATA,
        srcId: originalPacket.srcId, 
        destId: this.nextHop,        
        payload: originalPacket.payload,
        timestamp: Date.now()
    });
  }

  // --- YOUR REQUESTED ALGORITHM ---
  private getSortedCandidates() {
    const candidates = [...Array.from(this.neighbors.values()), {
      id: this.id, 
      role: this.role, 
      battery: this.battery, 
      hopsToGw: this.hopsToGw, 
      neighborCount: this.neighbors.size, // My own count
      lastSeen: 0, rssi: 0
    }];

    candidates.sort((a, b) => {
      // 1. HARDWARE ACCESS (Real Internet Wins)
      // If someone has a path to a Hardware Gateway (Hops < 100), they win.
      const aHw = a.hopsToGw < 100; const bHw = b.hopsToGw < 100;
      if (aHw && !bHw) return -1;
      if (!aHw && bHw) return 1;
      if (aHw && bHw) return a.hopsToGw - b.hopsToGw; // Shorter path wins

      // 2. MOST NEIGHBORS (Centrality) - Your Request
      const aCount = a.neighborCount ?? 0;
      const bCount = b.neighborCount ?? 0;
      if (aCount !== bCount) return bCount - aCount; // Higher count wins

      // 3. BATTERY (Sustainability)
      if (a.battery !== b.battery) return b.battery - a.battery; // Higher battery wins
      
      // 4. LOWEST ID (Atomic Tie-Breaker) - Your Request
      return a.id - b.id; // Lower ID wins
    });
    return candidates;
  }

  private ensureStability(dt: number, config: NodeConfig) {
    // Isolation Check
    if (this.neighbors.size === 0) {
      this.handleIsolation(dt);
      return;
    }
    this.isolationTimer = 0; 

    // Hardware Gateway Check
    let bestHw = null;
    for(const n of this.neighbors.values()) {
        if (n.hopsToGw < 100) {
            if (!bestHw || n.hopsToGw < bestHw.hopsToGw) bestHw = n;
        }
    }

    if (bestHw) {
        this.isElecting = false;
        if (this.nextHop !== bestHw.id || this.role === NodeRole.LEADER) {
             this.changeRole(NodeRole.RELAY, bestHw.hopsToGw + 1, bestHw.id, PacketType.HELLO);
        }
        return;
    }

    // --- DARK CLUSTER LOGIC ---
    
    // 1. Check Cluster Size Constraint
    const candidates = this.getSortedCandidates();
    const clusterSizeEstimate = this.neighbors.size + 1; 
    
    let allowedLeaders = 1;
    if (clusterSizeEstimate >= config.minClusterSize) {
        allowedLeaders = config.maxLeaders;
    }
    if (allowedLeaders < 1) allowedLeaders = 1;

    const rulingCouncil = candidates.slice(0, allowedLeaders);
    const shouldBeLeader = rulingCouncil.some(c => c.id === this.id);

    // 2. Promotion / Demotion
    if (shouldBeLeader && this.role !== NodeRole.LEADER) {
        this.runElection(config, allowedLeaders);
        return;
    }
    if (!shouldBeLeader && this.role === NodeRole.LEADER) {
        this.runElection(config, allowedLeaders);
        return;
    }

    // 3. Cluster Merge (Incumbent Logic)
    if (this.role === NodeRole.LEADER) {
       // If I see a neighbor who is ALSO a leader, we need to de-conflict
       const competingLeaders = Array.from(this.neighbors.values()).filter(n => n.role === NodeRole.LEADER);
       
       // If there are too many leaders locally, and I am the weakest...
       if (competingLeaders.length > 0) {
            // Re-run election to see if I still make the cut in the merged group
            const mergedCandidates = this.getSortedCandidates();
            const mergedCouncil = mergedCandidates.slice(0, allowedLeaders);
            if (!mergedCouncil.some(c => c.id === this.id)) {
                this.runElection(config, allowedLeaders); // Abdicate
                return;
            }
       }
    }

    // 4. Relay Optimization
    if (this.role === NodeRole.RELAY || this.role === NodeRole.IDLE) {
         let best = null;
         for(const n of this.neighbors.values()) {
             if (n.parentId === this.id) continue; 
             if (n.hopsToGw >= 999) continue;      
             if (!best) best = n;
             // Use same sorting logic as election to pick parent
             else if (n.hopsToGw < best.hopsToGw) best = n;
             else if (n.hopsToGw === best.hopsToGw && (n.neighborCount||0) > (best.neighborCount||0)) best = n;
         }

         if (best) {
             if (this.nextHop !== best.id || this.hopsToGw !== (best.hopsToGw + 1)) {
                  this.changeRole(NodeRole.RELAY, best.hopsToGw + 1, best.id, PacketType.HELLO);
             }
             this.isElecting = false;
             return;
         } else {
             this.runElection(config, allowedLeaders);
         }
    }
  }

  private runElection(config: NodeConfig, allowedLeaders: number) {
    this.isElecting = true;
    const candidates = this.getSortedCandidates();
    const rulingCouncil = candidates.slice(0, allowedLeaders);
    const amICouncil = rulingCouncil.some(c => c.id === this.id);

    if (amICouncil) {
      if (this.role !== NodeRole.LEADER) {
          this.changeRole(NodeRole.LEADER, 100, null, PacketType.ELECTION);
      }
    } else {
      const best = candidates[0];
      if (best.id !== this.id) {
        const safeHops = Math.min(best.hopsToGw + 1, 999);
        if (this.nextHop !== best.id) {
            this.changeRole(NodeRole.RELAY, safeHops, best.id, PacketType.HELLO);
        }
      }
    }
  }

  private changeRole(newRole: NodeRole, newHops: number, newNextHop: number | null, packetType: PacketType) {
    const changed = this.role !== newRole || this.hopsToGw !== newHops || this.nextHop !== newNextHop;
    
    this.role = newRole;
    this.hopsToGw = newHops;
    this.nextHop = newNextHop;

    if (changed) {
        this.broadcast(packetType);
        if (newRole !== NodeRole.LEADER) this.isElecting = false;
    }
  }

  private handleIsolation(dt: number) {
    if (this.role !== NodeRole.ISOLATED) {
        this.changeRole(NodeRole.ISOLATED, 999, null, PacketType.PANIC);
    }
    this.isolationTimer += dt;
  }

  private updateTimers(dt: number) {
    for (const [id, entry] of this.neighbors) {
      entry.lastSeen += dt;
      if (entry.lastSeen > this.NEIGHBOR_TIMEOUT) {
        this.neighbors.delete(id);
        if (this.nextHop === id) {
             this.changeRole(NodeRole.IDLE, 999, null, PacketType.PANIC);
        }
      }
    }

    this.helloTimer += dt;
    if (this.helloTimer >= this.HELLO_INTERVAL) {
      this.broadcast(PacketType.HELLO);
      this.helloTimer = (Math.random() * 0.4) - 0.2; 
    }

    this.dataTimer += dt;
    const interval = this.state === 'MOVING' ? 1.5 : 5.0;
    if (this.dataTimer >= interval) {
       if (this.hopsToGw < 999) {
         this.broadcast(PacketType.DATA, { x: Math.round(this.x), y: Math.round(this.y), status: 'OK' });
       }
       this.dataTimer = (Math.random() * 0.5) - 0.25; 
    }
  }

  private broadcast(type: PacketType, payload: any = {}) {
    const fullPayload = {
        role: this.role, 
        battery: this.battery, 
        hopsToGw: this.hopsToGw,
        leaderId: (this.role === NodeRole.LEADER) ? this.id : (this.role === NodeRole.RELAY && this.nextHop ? (this.neighbors.get(this.nextHop)?.leaderId || this.neighbors.get(this.nextHop)?.id) : this.id),
        leaderBat: (this.role === NodeRole.LEADER) ? this.battery : (this.role === NodeRole.RELAY && this.nextHop ? (this.neighbors.get(this.nextHop)?.leaderBat || this.neighbors.get(this.nextHop)?.battery) : this.battery),
        parentId: this.nextHop,
        neighborCount: this.neighbors.size, // <--- Critical for "Most Neighbors" logic
        ...payload
    };

    this.txQueue.push({
      id: `${this.id}-${Date.now()}-${Math.random()}`,
      type,
      srcId: this.id,
      destId: (type === PacketType.DATA && this.nextHop) ? this.nextHop : -1,
      payload: fullPayload,
      timestamp: Date.now()
    });
  }

  private updateMotion(dt: number, config: NodeConfig) {
    if (this.isDragging || this.state !== 'MOVING') return;
    const dist = Math.sqrt(Math.pow(this.targetX - this.x, 2) + Math.pow(this.targetY - this.y, 2));
    if (dist < 10) {
      this.targetX = Math.random() * 1100 + 50;
      this.targetY = Math.random() * 700 + 50;
    } else {
      const moveStep = config.movingSpeed * 100 * dt; 
      this.x += ((this.targetX - this.x) / dist) * moveStep;
      this.y += ((this.targetY - this.y) / dist) * moveStep;
    }
  }

  public toggleMode() {
    this.state = this.state === 'MOVING' ? 'STATIONARY' : 'MOVING';
    if (this.state === 'MOVING') this.dataTimer = 100; 
    if (this.state === 'STATIONARY') {
      this.targetX = this.x; this.targetY = this.y;
    }
  }
}