# Experiments (A–E)

This page summarizes the headless experiments implemented under `src/experiments/`.

- Entry point: `src/experiments/runner.ts`
- Run: `npm run experiments -- --seed=1`
- Outputs: CSVs written to the repository root (see each experiment section).

> Units: meters (m), seconds (s) in CSV, milliseconds (ms) internally. Angles in radians (rad).
>
> Anchor-free caveat: for cooperative localization without anchors, absolute `RMSE/MAE` can be misleading; prefer `RMSE_Aligned/MAE_Aligned` and/or `PairwiseDist_MAE`. See `docs/metrics.md`.

## What this project is (for first-time readers)

ICUM-SIM is a **simulator** for a network of mobile devices (“nodes”) that are trying to **localize themselves** (estimate their own 2D positions) using noisy, lossy, short-range radio measurements.

At a high level there are three layers:

1. **Engine (ground truth)**: the simulator maintains the true world state: where each node really is and how it moves.
2. **Firmware (on-node estimate)**: each node runs a firmware algorithm that:

- exchanges packets with neighbors,
- makes UWB-style measurements,
- and continuously updates its own estimated position based on those measurements.

3. **Cloud (optional)**: nodes can publish summaries (neighbor observations) to a cloud backend that performs **fusion** to produce cloud-side position estimates.

The experiments in this document run the simulator **headlessly** (no UI) to generate CSVs for plots/tables.

### Key terms used in the experiments

- **Node**: a device in the network. In the simulator, each node has a true position and a firmware-estimated position.
- **Neighbor**: another node within radio/UWB range that can exchange packets and produce measurements.
- **UWB range**: a simulated distance measurement between two nodes. It is noisy: the experiment parameter `uwbNoiseSigma` is the distance noise standard deviation (meters).
- **AoA (angle of arrival)**: a simulated bearing/angle measurement to a neighbor (radians). It is also noisy.
- **Packet loss**: simulated probability that a transmitted packet is dropped (default 10%). Packet loss reduces measurement availability and slows/perturbs convergence.
- **Tx**: “transmissions” (packet count). Used as a proxy for energy and channel occupancy.

### Policies compared in these experiments

- **Baseline (periodic)**: nodes transmit and measure on a fixed schedule (e.g., every 2 seconds), regardless of whether they are moving.
- **ICUM/ETM (event-driven sensing)**: nodes reduce unnecessary communication when they appear stable/stationary and trigger sensing/communication more based on events.

### Why there are multiple error metrics

Cooperative localization without anchors is often only identifiable up to a **rigid transform** (the solution can rotate/translate as a whole). So the experiments report:

- **Absolute metrics** (`RMSE`, `MAE`): compare estimated positions directly to world coordinates (only meaningful if the solution is anchored to the same frame).
- **Aligned metrics** (`RMSE_Aligned`, `MAE_Aligned` / aligned ALE): rigidly align the estimated configuration to truth first, then compute error (appropriate for anchor-free evaluation).
- **Structure metrics** (`PairwiseDist_MAE`): compare inter-node distances; invariant to global rotation/translation.
- **Residual metrics** (`RangeResidual_MAE`, `AngleResidual_MAE`): compare how well the estimated geometry explains the node’s own measured ranges/angles (deployable without ground-truth).

## Shared assumptions (all experiments)

**Determinism / seeds**

All experiments are deterministic given the same seed.

Seed precedence (highest priority first):

1. CLI: `--seed=123` or `--seed 123`
2. Env var: `EXPERIMENT_SEED=123`
3. Default: `1`

**World bounds**

- Experiments typically enable bounds via `EXPERIMENT_WORLD_BOUNDS_M`:
  - X: 0–50 m
  - Y: 0–50 m

**Motion scenarios**

- `none_moving`: no injected motion.
- `few_moving`, `many_moving`: deterministic velocity changes during a fixed time window.
- Shared motion window constants:
  - start: 120 s (`MOTION_START_MS = 120_000`)
  - stop: 180 s (`MOTION_STOP_MS = 180_000`)

Plain English: “few moving” and “many moving” temporarily move a subset of nodes between 120–180 seconds, then stop them again, to test how well the system handles motion.

**Engine defaults (when not overridden)**

These are defaults in `SimulationRunner` when an experiment does not specify otherwise:

- UWB range noise: `uwbNoiseSigma = 0.05` m
- UWB angle noise: `uwbAngleNoiseStdRad = 0.05` rad
- UWB max range: `uwbRangeMeters = 15` m
- Packet loss: `packetLoss = 0.1` (10%)

---

## Experiment A — Baseline vs ICUM/ETM (time series + noise sweep)

**Title**

- Baseline periodic messaging vs ICUM/ETM event-driven sensing over time.

**Objective**

- Compare communication cost vs localization quality for a periodic baseline against an event-driven (ICUM/ETM-style) policy.

**Method**

- Implementation: `src/experiments/experiments/experimentA.ts`
- CSV outputs:
  - `experiments_A_<scenario>_noise0.00.csv`
  - `experiments_A_<scenario>_noise0.05.csv`
  - `experiments_A_<scenario>_noise0.20.csv`
- Scenarios: `none_moving`, `few_moving`, `many_moving`.
- Node count: 10.
- Duration: 600 s.
- Logging cadence: 1 row per second (`logEveryMs=1000`), simulation stepped in 1 s chunks.
- Noise sweep (UWB range noise): `uwbNoiseSigma ∈ {0.00, 0.05, 0.20}` m.
- Policies:
  - **Baseline**: `eventDrivenSensing=false` and fixed HELLO + ranging intervals of 2 s (moving + idle), `neighborTimeoutMs=5000`.
  - **ETM/ICUM**: `eventDrivenSensing=true` (other firmware parameters default).

**What varies vs what is fixed**

- Varied: motion scenario, UWB range noise sigma.
- Fixed: node layout (deterministic), node count, world bounds, runtime, packet loss default, and firmware parameters except the policy toggle.

**Procedure (what the code actually does)**

For each scenario and noise level:

1. Create two separate simulations (baseline and ETM/ICUM) with different deterministic seeds.
2. Seed both runners with the same initial layout.
3. For `t = 0..600s` (step 1 s):

- apply the scenario motion at time `t`
- snapshot both runners (truth + per-node firmware estimates)
- compute metrics from snapshots
- advance simulation by 1 s

**How to interpret / report**

- If you want an anchor-free headline accuracy number, use `*_RMSE_Aligned` / `*_MAE_Aligned` as primary.
- Use `*_PairwiseDist_MAE` to talk about global shape preservation (rigid-transform invariant).
- Use `*_RangeResidual_MAE` / `*_AngleResidual_MAE` as “self-consistency” metrics (they do not require truth).
- `*_TxPerNodePerMin` is the fairest communication comparison because it normalizes by time and node count.

If you are presenting a single summary point from the time series, common choices are:

- final-time aligned error (e.g., at 600 s), and
- total Tx (or Tx per node per minute) over the same window.

**Key metrics** (exported columns)

# Experiments (A–E)

This document explains the **purpose** of each headless experiment and the **story** it is trying to tell.
It is written so that someone who has never seen ICUM-SIM can still understand what is being tested and why.

- Entry point: `src/experiments/runner.ts`
- Run: `npm run experiments -- --seed=1`
- Outputs: CSVs written to the repository root.

> Units: meters (m), seconds (s) in CSV, milliseconds (ms) internally. Angles in radians (rad).

## 0: Background (what ICUM-SIM is)

ICUM-SIM simulates a set of mobile devices (“**nodes**”) that try to estimate their own 2D positions.
Each node has:

- a **true** position (the simulator’s ground truth), and
- an **estimated** position (what the node’s firmware believes).

Nodes can only learn about the world through imperfect communication:

- **UWB range**: a noisy measurement of distance to a neighbor.
- **AoA** (angle of arrival / bearing): a noisy measurement of the direction to a neighbor.
- **Packet loss**: a fraction of packets/measurements are randomly dropped.

The experiments below compare different ways of deciding **when to communicate and measure** (periodic vs event-driven) and different ways of combining measurements (**on-node firmware optimization** vs **cloud fusion**).

### Shared assumptions (for all experiments)

**Determinism / seeds**

All experiments are deterministic given the same seed.

Seed precedence (highest priority first):

1. CLI: `--seed=123` or `--seed 123`
2. Env var: `EXPERIMENT_SEED=123`
3. Default: `1`

**World size**

Experiments usually run in a bounded square world:

- X: 0–50 m
- Y: 0–50 m

**Motion scenarios**

The same three motion scenarios are reused:

- `none_moving`: nobody is forced to move.
- `few_moving`: a small subset moves between 120–180 s.
- `many_moving`: a larger subset moves between 120–180 s.

This “move window” (120–180 s) is intentionally chosen so you can see:

1. convergence while stationary, 2) a disturbance during motion, and 3) re-convergence after motion stops.

**Engine defaults (when not overridden)**

- UWB range noise: `uwbNoiseSigma = 0.05` m
- UWB angle noise: `uwbAngleNoiseStdRad = 0.05` rad
- UWB max range: `uwbRangeMeters = 15` m
- Packet loss: `packetLoss = 0.1` (10%)

### How to read the “accuracy” metrics

Cooperative localization without anchors can be correct “up to a rigid transform” (rotate/translate the whole map). Therefore:

- **Absolute accuracy** (`RMSE`, `MAE`) is only meaningful if the coordinate frame is anchored.
- **Aligned accuracy** (`RMSE_Aligned`, `MAE_Aligned`, aligned ALE) is meaningful even without anchors.
- **Structure** (`PairwiseDist_MAE`) measures whether the _shape_ is right (inter-node distances).
- **Residuals** (`RangeResidual_MAE`, `AngleResidual_MAE`) measure internal consistency with the measurements (deployable even without truth).

See `docs/metrics.md` for formal definitions.

---

# **1: Quantification of Communication Efficiency (Event-Driven vs Time-Triggered)**

ICUM-SIM includes an **event-driven sensing** mode (ICUM/ETM) where the firmware reduces “background chatter” when nodes appear stable.
The baseline alternative is a **time-triggered** policy where nodes transmit at a fixed cadence no matter what.

In these experiments, **Tx count** is used as a direct proxy for communication load (and therefore energy / airtime).

**Objective:** Quantify how much communication is saved by the event-driven policy, and whether localization quality remains acceptable.

**Methodology:** Run the same simulated world twice:

◦ **Test Case A (ICUM/ETM):** `eventDrivenSensing=true`.

◦ **Test Case B (Baseline):** `eventDrivenSensing=false` with fixed 2 s HELLO + ranging intervals.

These are implemented as:

- **Experiment A** (time series + noise sweep)
- **Experiment E** (paper-style repeated A/B runner, finer timestep)

**Key metrics:**

◦ **Average transmission rate ($\rho$):** exported as `TxPerNodePerMin` (packets / node / minute). Lower is better.

◦ **Total transmissions ($\gamma$):** exported as `Tx`/`TxTotal` (packets). Lower is better.

◦ **Localization error:**

- aligned: `RMSE_Aligned` / `MAE_Aligned` (recommended for anchor-free comparison)
- absolute: `RMSE` / `MAE` (only if anchored)

### 1A) Experiment A — Baseline vs ICUM/ETM (time series + noise sweep)

This is the “main plot-friendly” comparison because it shows behavior over time and under multiple noise levels.

**Objective:** Compare communication vs accuracy over time under different motion scenarios and different ranging noise.

**Methodology:**

- Implementation: `src/experiments/experiments/experimentA.ts`
- CSV outputs: `experiments_A_<scenario>_noise<xx.xx>.csv`
- Node count: 10
- Duration: 600 s, logged at 1 Hz (1 row per second)
- Motion scenarios: `none_moving`, `few_moving`, `many_moving`
- Noise sweep: `uwbNoiseSigma ∈ {0.00, 0.05, 0.20}` m

For each scenario and noise sigma, the code:

1. Creates two runners (baseline + ICUM/ETM) with deterministic seeds.
2. Seeds them with the same initial node layout.
3. For each second:
   - applies the motion scenario at that timestamp
   - snapshots truth + firmware estimates
   - logs Tx and accuracy metrics

**Key metrics (what to plot):**

- Communication: `Baseline_TxPerNodePerMin` vs `ETM_TxPerNodePerMin`
- Accuracy (anchor-free): `Baseline_RMSE_Aligned` / `Baseline_MAE_Aligned` vs the ETM equivalents
- Complementary: `PairwiseDist_MAE` (shape) and `RangeResidual_MAE` / `AngleResidual_MAE` (self-consistency)

### 1B) Experiment E — Paper-style A/B (seeded, finer timestep)

Experiment E is a compact “A/B harness” designed for repeated runs with explicit seeds per (scenario, policy).
It uses a finer simulation timestep (`dt=250ms`) than Experiment A’s 1 s stepping.

**Objective:** Produce paper-style A/B tables/plots with deterministic per-policy seeding and measurement-residual metrics.

**Methodology:**

- Implementation: `src/experiments/experiments/experimentE.ts`
- CSV outputs: `experiments_E_<scenario>_<policy>.csv`
- Node count: 10
- Duration: 300 s
- Simulation timestep: 250 ms, logged at 1 Hz
- Policies: `baseline` vs `icum`

**Key metrics:**

- Communication: `TxTotal`, `TxPerNodePerMin`
- Accuracy: `RMSE`
- Deployable consistency: `RangeResidual_MAE` (m), `AngleResidual_MAE` (rad)

---

# **2: Localization Accuracy vs UWB Noise (Sensitivity / Robustness)**

UWB ranging is intrinsically noisy, and real deployments can have much worse errors under challenging propagation.
Even if we do not explicitly model every physical mechanism, we can still ask a practical question:

“If the range measurements get noisier, how does final localization quality degrade?”

**Objective:** Evaluate the sensitivity of localization accuracy to increasing UWB range noise.

**Methodology:** Run the same system multiple times, sweeping `uwbNoiseSigma` over a range of values.

◦ **Experiment B** is the dedicated “final score vs noise” sweep.

### 2A) Experiment B — Noise sweep (final accuracy)

**Methodology:**

- Implementation: `src/experiments/experiments/experimentB.ts`
- CSV output: `experiments_B.csv`
- Node count: 8
- Duration: 300 s
- Noise sweep: `uwbNoiseSigma ∈ {0.1, 0.2, …, 0.8}` m

For each noise sigma:

1. Create a runner with that `uwbNoiseSigma`.
2. Seed a deterministic layout.
3. Run for 300 s.
4. Snapshot and record the final metrics.

**Key metrics:**

◦ **Aligned error (recommended):** `RMSE_Aligned`, `MAE_Aligned`

◦ **Structure error:** `PairwiseDist_MAE`

◦ **Absolute error (only if anchored):** `RMSE`, `MAE`

---

# **3: Scalability and Convergence (Node Count Sweep)**

As the network grows, the system has more measurements and more constraints, but also more opportunities for packet loss and contention.
We therefore want to quantify two things:

1. how much each node has to talk, and 2) how quickly the collective estimate stabilizes.

**Objective:** Measure how communication rate and convergence behavior scale with node count (and motion).

**Methodology:** Sweep node count across multiple scenarios, run a 1 Hz time series, and use a smoothed convergence heuristic.

◦ **Experiment C** is the dedicated scaling + convergence study.

### 3A) Experiment C — Scaling + convergence

**Methodology:**

- Implementation: `src/experiments/experiments/experimentC.ts`
- CSV outputs: `experiments_C_<scenario>.csv`
- Scenarios: `none_moving`, `few_moving`, `many_moving`
- Node counts: 5, 10, 20, 35, 50
- Duration: 300 s, logged at 1 Hz
- Noise: `uwbNoiseSigma = 0.05` m

**Convergence definition (operational):**

- Compute aligned ALE once per second.
- Maintain a rolling mean over 30 seconds.
- Declare convergence when the rolling mean changes by ≤ 0.05 m for 5 consecutive seconds.

**Key metrics:**

◦ **Communication rate ($\rho$):** `TxPerNodePerMin`

◦ **Accuracy (anchor-free):** `ALE` (this experiment’s `ALE` is aligned)

◦ **Time to stabilize:** `ConvergenceMs`

---

# **4: Cloud Fusion Accuracy and Coverage (Baseline vs Robust)**

In addition to on-node estimation, ICUM-SIM can publish neighbor observations to a cloud backend.
The cloud performs a fusion/optimization step to produce cloud-side position records.

This matters because:

- publish policies can reduce bandwidth, but also reduce cloud observability, and
- robust fusion may improve outlier tolerance.

**Objective:** Compare cloud fusion modes (least squares vs robust) in terms of accuracy and availability (coverage).

**Methodology:** Run a simulation, gate publishing with a staleness-based policy, ingest into two cloud backends, and score the resulting cloud estimates.

◦ **Experiment D** is the dedicated cloud-fusion comparison.

### 4A) Experiment D — Cloud fusion: baseline vs robust

**Methodology:**

- Implementation: `src/experiments/experiments/experimentD.ts`
- CSV outputs: `experiments_D_<scenario>.csv`
- Node count: 12
- Duration: 300 s, logged at 1 Hz
- Noise: `uwbNoiseSigma = 0.05` m
- Publish gating: `CloudPublishTracker({ staleMs: 30_000 })`
- Two clouds:
  - baseline: `CloudBackend({ robustFusion: false })`
  - robust: `CloudBackend({ robustFusion: true })`

Each second:

1. Snapshot the simulation.
2. Build a report per node from its neighbor table (`{ id, range, aoa }`).
3. Decide if the node publishes (staleness-based).
4. If published, ingest the same report into both clouds.
5. Tick both clouds and score their latest records against truth.

**Key metrics:**

◦ **Cloud RMSE:** `CloudBaseline_RMSE`, `CloudRobust_RMSE`

◦ **Coverage:** `CoverageBaseline`, `CoverageRobust` (how many nodes have an estimate)

---

## 5: Where the CSVs come from (mapping)

- Experiment A → `experiments_A_<scenario>_noise<xx.xx>.csv`
- Experiment B → `experiments_B.csv`
- Experiment C → `experiments_C_<scenario>.csv`
- Experiment D → `experiments_D_<scenario>.csv`
- Experiment E → `experiments_E_<scenario>_<policy>.csv`
