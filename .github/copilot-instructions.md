# ICUM-SIM Copilot Instructions

## Project Overview

ICUM-SIM is a client-side React/Vite application simulating a mesh network. It visualizes node interactions, packet propagation, and distributed consensus algorithms in real-time.

## Architecture & Core Components

### 1. Simulation Engine (`src/App.tsx`)

- **Role**: Orchestrates the global simulation state, physics, RF propagation, and rendering.
- **Key Mechanism**: `gameLoop` driven by `requestAnimationFrame`.
- **State Management**: Uses `useRef` (`nodesRef`, `wallsRef`) for high-frequency updates to avoid React render thrashing, syncing to React state (`setNodes`) for frame updates.
- **RF Propagation**: Calculates distance between nodes and checks for wall intersections (`doIntersect`) to determine packet delivery.

### 2. Node Logic (`src/logic/NodeFirmware.ts`)

- **Role**: Encapsulates the firmware logic for a single node.
- **Isolation**: strictly decoupled from the UI. It knows nothing about the global `nodes` array or `App.tsx`.
- **Lifecycle**: `tick(dt, config, rxPackets)` is called every simulation frame.
- **Communication**: Nodes communicate _only_ via `txQueue` (sending) and `rxPackets` (receiving).

### 3. Data Models (`src/types/index.ts`)

- **Single Source of Truth**: All shared enums (`NodeRole`, `PacketType`) and interfaces (`Packet`, `NodeConfig`) are defined here.
- **Visual vs Logical**:
  - `Packet`: The logical data payload.
  - `VisualPacket`: The animation state (x, y, progress) for rendering the packet in the UI.

## Development Guidelines

### Simulation Logic

- **Performance**: When modifying the `gameLoop`, prioritize performance. Avoid heavy computations (like O(N^2) checks) inside the loop if possible, or optimize them.
- **Wall Logic**: Always check for wall intersections when calculating connectivity or packet transmission. Use the existing `doIntersect` helper.
- **Coordinate System**: The canvas is 1200x800. `PIXELS_PER_METER` is 20.

### Node Firmware Development

- **Distributed Mindset**: When writing code in `NodeFirmware.ts`, think from the perspective of a single isolated device. You cannot access global state.
- **State Machine**: Use `this.state` and `this.role` to manage behavior.
- **Timers**: Use `dt` (delta time) for all timers (e.g., `helloTimer`, `dataTimer`) instead of `setInterval`/`setTimeout` to ensure simulation speed consistency.

### UI & Rendering

- **SVG Rendering**: The map is rendered using SVG elements.
- **Interactions**: Mouse events are handled on the SVG container and translated to simulation coordinates.

## Common Tasks

### Adding a New Packet Type

1. Add the type to `PacketType` enum in `src/types/index.ts`.
2. Handle the packet in `NodeFirmware.processInbox`.
3. (Optional) Update `VisualPacket` logic in `App.tsx` if it needs distinct visual behavior (e.g., speed, color).

### Modifying Node Behavior

- Edit `src/logic/NodeFirmware.ts`.
- Ensure `tick()` handles the new logic.
- If the logic requires new configuration, update `NodeConfig` in `types` and the default config in `App.tsx`.

## Tech Stack

- **Framework**: React 19 + Vite
- **Language**: TypeScript
- **Styling**: Inline styles (JS objects) and standard CSS.
- **Icons**: `lucide-react`
