# GitHub Copilot Instructions for ICUM-SIM

## Project Overview

ICUM-SIM is a visual simulator for Indoor Cooperative UWB (Ultra-Wideband) Mesh Networks. It simulates node behavior, packet exchange, ranging, and cooperative localization algorithms.

**Tech Stack:**

- **Frontend:** React 19, Vite 7, TypeScript 5.9
- **Styling:** Tailwind CSS (implied by class names) / Lucide React icons
- **Testing:** Vitest

## Architecture & Patterns

### 1. Simulation Loop Pattern

The project uses a "Game Loop" architecture rather than typical React reactive patterns for the core simulation.

- **Main Loop:** `App.tsx` contains the `requestAnimationFrame` loop.
- **Tick System:** The loop calculates `dt` (delta time) and calls `.tick(dt)` on every `NodeFirmware` instance.
- **State Management:**
  - **Simulation State:** Stored in `useRef` (e.g., `nodesRef`, `packetsRef`) to allow mutable updates without triggering re-renders every frame.
  - **UI State:** Synced from refs to React state (`useState`) periodically or on specific events for rendering.

### 2. Component Separation

- **`src/App.tsx`**: The "Physics Engine" and "God Object". It handles:
  - Node movement and dragging.
  - Wall intersection logic (`doIntersect`).
  - Packet propagation (checking distance and Line-of-Sight).
  - Rendering the canvas/map.
- **`src/logic/NodeFirmware.ts`**: The "Firmware". It simulates the code running on the actual microcontroller.
  - **Responsibility:** State machine (IDLE, LEADER), packet processing, battery management, and calling the localization engine.
  - **Constraint:** Should not know about global "physics" (like absolute positions of other nodes) unless received via simulated sensors/packets.
- **`src/logic/UWBRanging.ts`**: Simulates the UWB hardware layer (calculating distances, adding noise, handling wall attenuation).

### 3. Coordinate Systems

- **Canvas Coordinates:** Pixels (x, y). Used for rendering and `App.tsx` physics.
- **Physical Coordinates:** Meters. Used inside `NodeFirmware` and `CooperativeLocalization`.
- **Conversion:** `PIXELS_PER_METER = 20` (defined in `App.tsx` and `NodeFirmware.ts`). Always convert when passing data between UI and Logic.

## Critical Workflows

### Development

- **Start:** `npm run dev`
- **Build:** `npm run build`

### Testing

- **Runner:** Vitest
- **Location:** `src/logic/**/__tests__/*.spec.ts`
- **Command:** `npm test`
- **Focus:** Test logic classes (`NodeFirmware`, `CooperativeLocalization`) in isolation from the React UI.

## Coding Conventions

### TypeScript

- **Strict Typing:** Use interfaces from `src/types/index.ts`.
- **No `any`:** Avoid `any` unless absolutely necessary for mocking.

### Performance

- **Avoid React Render Loop:** Do not put high-frequency simulation logic inside `useEffect` or `useState` setters. Use `useRef` and mutate objects, then trigger a render only when visual updates are needed.
- **Batch Updates:** If multiple nodes update, batch the React state update to a single call per frame.

### Simulation Logic

- **Determinism:** Where possible, logic should be deterministic based on `dt`.
- **Async:** `NodeFirmware` logic is synchronous `tick()`. Async behavior (like network delays) is simulated by queuing packets and processing them in future ticks.

## Key Files

- `src/App.tsx`: Main entry, simulation loop, rendering.
- `src/logic/NodeFirmware.ts`: Node behavior logic.
- `src/logic/localization/CooperativeLocalization.ts`: Math/Kalman Filter implementation.
- `src/types/index.ts`: Shared type definitions (Packets, NodeRoles, etc.).
