# Copilot Instructions for ICUM-SIM

- **Stack & commands**: React + TypeScript + Vite (SWC). `npm install`; `npm run dev` (https, basic-ssl), `npm run build` (`tsc -b` then vite), `npm run test` (vitest), `npm run lint` (eslint flat).
- **Architecture split**: Firmware lives in `src/firmware` (pure TS, no React/DOM). Simulation engine lives in `src/engine` (world truth, physics, RF). UI should consume snapshots only.
- **Firmware HAL**: `src/firmware/types.ts` defines `INodeHAL` (getIMU, pollRadio, getBatteryVoltage, getTimeMs, radioSend, log) plus firmware configs/snapshots. Firmware must not touch refs or DOM.
- **NodeFirmware**: `src/firmware/NodeFirmware.ts` holds the FSM (STATIONARY/MOVING/ISOLATED via accel>0.5G), battery-aware leader election (LTE > degree > battery > ID), and graph relaxation cost `J = sum(lambda_d*e_dist^2 + lambda_theta*e_angle^2)` via gradient descent. Uses shared `Packet`/`NodeRole` types only.
- **SimulationRunner**: `src/engine/SimulationRunner.ts` advances time headlessly, integrates physics (x,y + velocity), does RF propagation with LOS/wall blocking, UWB noise (sigma default 0.05m), and packet loss (default 10%). Owns per-node RX buffers and calls firmware `tick`.
- **Experiments**: `src/experiments/runner.ts` runs A/B/C headlessly and writes `experiments.csv`. Update metrics there when refining paper results.
- **Tests**: `src/firmware/__tests__/NodeFirmware.spec.ts` covers FSM accel threshold and leader election battery preference. Keep new tests deterministic (set IMU/radio inputs explicitly).
- **Legacy UI**: `src/App.tsx` still uses refs + `gameLoop`. When integrating, replace internal physics/radio with `SimulationRunner.snapshot()`; avoid reintroducing state inside firmware.
- **Units**: Firmware/engine operate in meters; legacy UI still mixes pixels (20 px/m). Convert consistently if bridging to App visuals.
- **LOS/geometry**: Wall intersection helper duplicated in engine; centralize if you change LOS rules.
- **Styling/UI**: Dark slate palette, inline styles, monospace metrics; keep `DraggableWindow` ordering (no portals) if adding windows.
- **Pitfalls**: Forgetting to clear RX buffers will stall nodes; skipping LOS/noise inflates reach; mismatched units between UI and engine cause RMSE drift.

Ask for clarification if architecture boundaries need tweaks.
