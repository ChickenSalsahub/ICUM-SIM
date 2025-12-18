# Metrics Reference (ICUM-SIM)

This document explains **every metric produced by the UI and experiments**, including meaning, recommended usage, and units.

## Coordinate frames and a critical caveat (anchored vs anchor-free)

Your system supports both:

- **Anchored** localization: at least one node is pinned to world coordinates (e.g., a gateway with ground-truth `{x,y}` injected into cloud reports).
- **Anchor-free** cooperative localization: the relative geometry can converge, but the _global_ pose is only identifiable up to a rigid transform.

In anchor-free mode, **absolute world-frame error is not a valid “accuracy” metric**. Use **rigid-aligned** metrics and/or **structure** metrics.

Throughout this doc:

- **Distance unit** is **meters (m)**.
- **Time unit** is **seconds (s)** in CSV, **milliseconds (ms)** internally.
- **Angles** are in **radians (rad)**.

---

## Engine-side localization metrics (used in Experiments A/B/C/E)

These metrics compare each node’s firmware estimate to the simulator ground truth.

### `RMSE` — Root Mean Squared Error (absolute)

- **Meaning**: average quadratic position error over nodes.
- **Definition**:
  - For node $i$, error magnitude $e_i = \sqrt{(\hat x_i-x_i)^2+(\hat y_i-y_i)^2}$.
  - $\mathrm{RMSE} = \sqrt{\frac{1}{N}\sum_i e_i^2}$.
- **Units**: **m**.
- **Use**: only appropriate when the solution is **anchored** to the same world frame as truth.
- **Where**:
  - Computed in `rmse(...)` in [src/experiments/lib/metrics.ts](src/experiments/lib/metrics.ts)
  - Exported in Experiment A/B/E CSVs.

### `MAE` — Mean Absolute Error (absolute)

- **Meaning**: average Euclidean position error over nodes.
- **Definition**: $\mathrm{MAE} = \frac{1}{N}\sum_i e_i$.
- **Units**: **m**.
- **Use**: same anchoring caveat as RMSE.
- **Where**:
  - Computed in `mae(...)` in [src/experiments/lib/metrics.ts](src/experiments/lib/metrics.ts)
  - Exported in Experiment A/B CSVs.

### `ALE` — Average Localization Error

- **Meaning**: paper-style naming; in this simulator **ALE == MAE**.
- **Units**: **m**.
- **Use**:
  - Prefer `ALE_Aligned` for anchor-free claims.
- **Where**:
  - `ale(...)` delegates to `mae(...)` in [src/experiments/lib/metrics.ts](src/experiments/lib/metrics.ts)
  - Experiment C exports `ALE` but it is actually **aligned ALE** (see below).

### `RMSE_Aligned` — RMSE after best-fit rigid alignment

- **Meaning**: RMSE after aligning the estimated point set onto truth using a best-fit **rotation + translation** (no scale).
- **Why it exists**: in anchor-free cooperative localization, the whole configuration can be rotated/translated (and sometimes mirrored) without changing the underlying solution quality.
- **Units**: **m**.
- **Use**: primary “accuracy” metric for anchor-free experiments.
- **Details**:
  - Uses a 2D Kabsch-style rigid alignment.
  - Allows a **Y reflection** if it lowers SSE (useful when the system produces a mirrored configuration).
  - For $N<2$, it falls back to the absolute RMSE.
- **Where**:
  - `rmseAlignedRigid(...)` in [src/experiments/lib/metrics.ts](src/experiments/lib/metrics.ts)
  - Exported in Experiment A/B CSVs.

### `MAE_Aligned` / `ALE_Aligned` — MAE after best-fit rigid alignment

- **Meaning**: mean Euclidean error after rigid alignment (same transform logic as above).
- **Units**: **m**.
- **Use**: primary “accuracy” metric for anchor-free experiments.
- **Where**:
  - `aleAlignedRigid(...)` in [src/experiments/lib/metrics.ts](src/experiments/lib/metrics.ts)
  - Exported as `MAE_Aligned` in Experiment A/B.
  - Experiment C’s `ALE` column is this aligned ALE.

### `PairwiseDist_MAE` — pairwise distance structure error

- **Meaning**: average absolute error of _inter-node distances_ across all unordered node pairs.
- **Definition**:
  - For each pair $(i,j)$, compare $d^\text{truth}_{ij}$ vs $d^\text{est}_{ij}$.
  - $\mathrm{PairwiseDist\_MAE} = \frac{1}{\binom{N}{2}}\sum_{i<j} |d^\text{est}_{ij}-d^\text{truth}_{ij}|$.
- **Units**: **m**.
- **Use**:
  - Anchor-free and rigid-transform invariant.
  - Best for “shape preservation” / structural fidelity.
  - Note: it is **all-pairs**, not “only measured edges”. It captures global deformation, but can overweight far-apart nodes.
- **Where**:
  - `pairwiseDistanceMae(...)` in [src/experiments/lib/metrics.ts](src/experiments/lib/metrics.ts)
  - Exported in Experiment A/B.

---

## Messaging / energy proxy metrics

### `TxTotal` / `Tx` / `TxPerNodePerMin`

- **Meaning**: number of transmitted packets (a proxy for energy / channel occupancy).
- **Units**:
  - `TxTotal` / `Tx`: **packets** (dimensionless count)
  - `TxPerNodePerMin`: **packets / node / minute**
- **Use**:
  - Compare policy efficiency (baseline periodic vs ICUM/ETM event-driven).
  - Use alongside an accuracy metric (aligned or absolute depending on anchors).
- **Where**:
  - `sumTx(...)` in [src/experiments/lib/metrics.ts](src/experiments/lib/metrics.ts)
  - Experiment C: `TxPerNodePerMin = totalTx / nodeCount / (timeMinutes)` in [src/experiments/experiments/experimentC.ts](src/experiments/experiments/experimentC.ts)
  - Experiment A/E: export tx counts alongside error.

---

## Convergence metrics (Experiment C)

### `ConvergenceMs`

- **Meaning**: time when the system is considered “converged” under a stabilization heuristic.
- **Units**: **ms** (written as a numeric value in the CSV).
- **Heuristic (as implemented)**:
  - Compute aligned ALE once per second.
  - Maintain a rolling mean over a 30-second window.
  - Declare convergence when the rolling mean changes by at most **0.05 m** for **5 consecutive seconds**.
- **Use**:
  - Compare scalability and stability vs node count and motion scenario.
  - Not a formal proof of convergence; it is a robust, noise-tolerant operational definition.
- **Where**:
  - Implemented in [src/experiments/experiments/experimentC.ts](src/experiments/experiments/experimentC.ts)

---

## Cloud-side metrics (Experiment D + UI Cloud view)

These metrics evaluate the **cloud fused** positions (`FusedRecord.position`) against ground truth.

### `CloudBaseline_RMSE` / `CloudRobust_RMSE`

- **Meaning**: RMSE between latest cloud fused position per node and truth.
- **Units**: **m**.
- **Use**:
  - Compare cloud fusion modes:
    - baseline least squares
    - robust (Huber) fusion
  - This is meaningful when the cloud solution is anchored or is otherwise comparable to truth.
- **Where**:
  - Computed by `cloudRmse(...)` in [src/experiments/lib/cloudMetrics.ts](src/experiments/lib/cloudMetrics.ts)
  - Used in [src/experiments/experiments/experimentD.ts](src/experiments/experiments/experimentD.ts)

### `CoverageBaseline` / `CoverageRobust`

- **Meaning**: how many nodes had a _latest fused record_ available at evaluation time.
- **Units**: **nodes (count)**.
- **Range**: $0..N$.
- **Use**:
  - Distinguish “accurate but sparse” vs “slightly worse but covers more nodes”.
  - Useful with packet loss / publish gating.
- **Where**:
  - Returned as `coverage` by `cloudRmse(...)` in [src/experiments/lib/cloudMetrics.ts](src/experiments/lib/cloudMetrics.ts)

---

## UI-only cloud topology overlay metrics (Cloud DB → TOPOLOGY view)

These are computed from the currently displayed cloud records (latest per node) and the current ground truth from the simulation.

### `ABS RMSE` / `ABS MAE`

- **Meaning**: absolute errors between cloud-recorded `{x,y}` and ground truth (in meters).
- **Units**: **m**.
- **Use**: only meaningful if the cloud layout is anchored to world coordinates.

### `ALIGNED RMSE` / `ALIGNED MAE`

- **Meaning**: same as experiments’ aligned metrics, but applied to cloud fused positions.
- **Units**: **m**.
- **Use**: meaningful even when the cloud topology is anchor-free.

### `PAIRWISE |Δd| MAE`

- **Meaning**: structure error comparing pairwise distances from cloud fused positions vs truth.
- **Units**: **m**.
- **Use**: good “shape quality” metric; rigid-transform invariant.

### Implementation location

- Shared implementation: [src/logic/metrics/CloudTopologyMetrics.ts](src/logic/metrics/CloudTopologyMetrics.ts)
- Used by UI: [src/App.tsx](src/App.tsx)

---

## Input / tuning parameters that show up in CSVs

### `Noise` / `uwbNoiseSigma`

- **Meaning**: standard deviation of UWB range noise.
- **Units**: **m**.
- **Where**:
  - Simulation option `uwbNoiseSigma` in [src/engine/SimulationRunner.ts](src/engine/SimulationRunner.ts)
  - Swept in Experiment B and Experiment A’s noise sweep.

---

## Quick guidance (what to report in a paper)

- **If you have real anchors** (gateway/LTE truth consistently pins the frame): report `RMSE`/`MAE` (absolute), and still optionally report `PairwiseDist_MAE`.
- **If you do not have anchors**: report `RMSE_Aligned`/`MAE_Aligned` as primary, and `PairwiseDist_MAE` as a complementary structure metric.
- Always report a **messaging/energy proxy** (`TxPerNodePerMin` or `TxTotal`) alongside accuracy.
