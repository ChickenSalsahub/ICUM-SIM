# GitHub Copilot Instructions for ICUM-SIM

## Project Overview

ICUM-SIM is a visual simulator for Indoor Cooperative UWB (Ultra-Wideband) Mesh Networks. It simulates node behavior, packet exchange, ranging, and cooperative localization algorithms.

**Tech Stack:**
- **Frontend:** React 19, Vite 7, TypeScript 5.9
- **Styling:** Tailwind CSS (implied by class names) / Lucide React icons
- **Testing:** Vitest
- **Linting:** ESLint

## Architecture & Patterns

### 1. Simulation Loop Pattern (Game Loop)
The project uses a "Game Loop" architecture rather than typical React reactive patterns for the core simulation.

- **Main Loop:** `App.tsx` contains the `requestAnimationFrame` loop.
- **Tick System:** The loop calculates `dt` (delta time) and calls `.tick(dt)` on every `NodeFirmware` instance.
- **State Management:**
  - **Simulation State:** Stored in `useRef` (e.g., `nodesRef`, `packetsRef`) to allow mutable updates without triggering re-renders every frame.
  - **UI State:** Synced from refs to React state (`useState`) periodically or on specific events for rendering.

### 2. Component Separation
- **`src/App.tsx` (Physics Engine):** The "God Object". Handles:
  - Node movement, dragging, and wall intersection (`doIntersect`).
  - Packet propagation (checking distance and Line-of-Sight).
  - Rendering the canvas/map.
- **`src/logic/NodeFirmware.ts` (Firmware):** Simulates the microcontroller code.
  - **Responsibility:** State machine, packet processing, battery management, localization.
  - **Constraint:** MUST NOT access global "physics" (like absolute positions of other nodes) directly. It interacts with the world via `HardwareInterface` (HAL).
- **`src/logic/UWBRanging.ts`:** Simulates UWB hardware layer (distances, noise, wall attenuation).
- **`src/logic/CloudBackend.ts`:** Simulates the cloud server receiving data from the gateway.

### 3. Coordinate Systems
- **Canvas Coordinates:** Pixels (x, y). Used for rendering and `App.tsx` physics.
- **Physical Coordinates:** Meters. Used inside `NodeFirmware` and `CooperativeLocalization`.
- **Conversion:** `PIXELS_PER_METER = 20` (defined in `App.tsx`). Always convert when passing data between UI and Logic.

## Critical Workflows

### Development
- **Start:** `npm run dev`
- **Build:** `npm run build`
- **Lint:** `npm run lint`

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
- **Avoid React Render Loop:** Do not put high-frequency simulation logic inside `useEffect` or `useState` setters. Use `useRef` and mutate objects.
- **Batch Updates:** If multiple nodes update, batch the React state update to a single call per frame.

### Simulation Logic
- **Determinism:** Logic should be deterministic based on `dt`.
- **Async:** `NodeFirmware` logic is synchronous `tick()`. Async behavior (network delays) is simulated by queuing packets.
- **HAL Pattern:** `NodeFirmware` uses `HardwareInterface` callbacks (`onRx`, `onTxComplete`) to interact with the simulated radio.

## New Feature Implementation Guide
1.  **Define Types:** Add new packet types or node roles in `src/types/index.ts`.
2.  **Update Firmware:** Implement logic in `src/logic/NodeFirmware.ts`. Use `this.hal` for I/O.
3.  **Update Physics/UI:** Update `src/App.tsx` to handle new visual elements or physics interactions.
4.  **Test:** Add unit tests in `src/logic/**/__tests__/`.
