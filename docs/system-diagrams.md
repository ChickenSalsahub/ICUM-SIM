# ICUM-SIM System Diagrams

These diagrams describe the _central_ control-flow and data-flow in the simulator.

## 1) End-to-end data flow (UI + engine + cloud + experiments)

```mermaid
%%{init: {'flowchart': {'useMaxWidth': false}}}%%
flowchart LR
  subgraph UI[React UI]
    App["App.tsx\n(gameLoop + views)"]
    Overlay["Cloud TOPOLOGY overlay\n(abs/aligned/pairwise metrics)"]
  end

  subgraph Engine[Simulation Engine]
    Runner["SimulationRunner\n(world truth + physics + RF)"]
    UWB["UWBRanging\n(noise + LOS/walls)"]
    FW["NodeFirmware\n(state + sensing + optimization)"]
  end

  subgraph Cloud[Cloud Backend]
    Pub["CloudPublishTracker\n(publish gating)"]
    CloudBase["CloudBackend (baseline)"]
    CloudRobust["CloudBackend (robust)"]
    Graph["RelativePoseGraph\n(cooperative localization)"]
    DB[(FusedRecord records)]
  end

  subgraph Exp[Headless Experiments]
    ExpRunner["experiments/runner.ts"]
    ExpA["Experiment A/B/C/E\n(engine-side metrics)"]
    ExpD["Experiment D\n(cloud-side metrics)"]
    CSV[(CSV outputs)]
  end

  App -->|set pose/battery/velocity| Runner
  Runner --> UWB
  Runner -->|tick dtMs| FW
  Runner -->|snapshot| App

  App -->|shouldPublish| Pub
  Pub -->|RawReport ingest| CloudBase
  Pub -->|RawReport ingest| CloudRobust

  CloudBase -->|runFusion| Graph
  CloudRobust -->|runFusion| Graph
  CloudBase --> DB
  CloudRobust --> DB

  DB -->|records| App
  App --> Overlay

  ExpRunner --> ExpA
  ExpRunner --> ExpD
  ExpA --> Runner
  ExpD --> Runner
  ExpD --> CloudBase
  ExpD --> CloudRobust
  ExpRunner --> CSV
```

## 2) UI simulation + cloud publish loop (sequence)

```mermaid
%%{init: {'sequence': {'useMaxWidth': false}}}%%
sequenceDiagram
  autonumber
  participant UI as App.tsx (gameLoop)
  participant R as SimulationRunner
  participant F as NodeFirmware (per node)
  participant P as CloudPublishTracker
  participant CB as CloudBackend baseline
  participant CR as CloudBackend robust

  loop Each animation frame
    UI->>R: setNodePose / setNodeVelocity / setNodeBatteryV
    UI->>R: step(dtMs)
    R->>F: tick(dtMs) for each node
    UI->>R: snapshot()
    R-->>UI: truth + firmware snapshots

    opt ~every 250ms
      UI->>P: shouldPublish(nodeId, isAnchor, isMoving, neighborIds)
      alt publish allowed OR PANIC+LTE override
        UI->>CB: ingest(RawReport)
        UI->>CR: ingest(RawReport)
      else suppressed
        UI-->>UI: skip cloud ingest
      end

      UI->>CB: tick(nowMs)\n(runFusion every window)
      UI->>CR: tick(nowMs)
      CB-->>UI: getRecords() (FusedRecord[])
      CR-->>UI: getRecords() (FusedRecord[])
    end
  end
```

## 3) Firmware state machine (movement + isolation)

```mermaid
%%{init: {'state': {'useMaxWidth': false}}}%%
stateDiagram-v2
  [*] --> STATIONARY

  STATIONARY --> MOVING: linAccelG > accelMoveThresholdG
  MOVING --> STATIONARY: linAccelG <= accelMoveThresholdG

  STATIONARY --> ISOLATED: now - lastAckMs > isolationNoAckMs
  MOVING --> ISOLATED: now - lastAckMs > isolationNoAckMs

  ISOLATED --> MOVING: connectivity returns && IMU indicates moving
  ISOLATED --> STATIONARY: connectivity returns && IMU indicates stationary

  note right of ISOLATED
    Emits PANIC periodically\n(primarily for observability;\nUI may publish truth if LTE-capable)
  end note
```

## 4) Cloud fusion pipeline (high level)

```mermaid
%%{init: {'flowchart': {'useMaxWidth': false}}}%%
flowchart TD
  Ingest["RawReport ingest"] --> Buffer[(buffer per node)]

  Buffer --> Tick{"tick window elapsed?"}
  Tick -- No --> Hold[wait]
  Tick -- Yes --> Fuse["runFusion"]

  Fuse --> Anchors{Any reports contain x,y?}
  Anchors -- Yes --> RealAnchors["Use real anchors\nsupernodes"]
  Anchors -- No --> VirtualAnchor["Pin a seed node\nvirtual anchor to fix translation"]

  RealAnchors --> Constraints[Build edge constraints\nrange, AoA, weights]
  VirtualAnchor --> Constraints

  Constraints --> Optimize[Optimize RelativePoseGraph\nLS or Huber robust]
  Optimize --> Emit["Fuse into FusedRecord records"]
  Emit --> DB[(cloud DB records)]
```

## 5) Experiments pipeline (A–E)

```mermaid
%%{init: {'flowchart': {'useMaxWidth': false}}}%%
flowchart LR
  Runner["experiments/runner.ts"] -->|runs| A["Experiment A\n(time series + noise sweep)"]
  Runner --> B["Experiment B\n(final score vs noise)"]
  Runner --> C["Experiment C\n(convergence + tx rate)"]
  Runner --> D["Experiment D\n(cloud baseline vs robust)"]
  Runner --> E["Experiment E\n(A/B policies, seeded)"]

  A --> CSV_A[(experiments_A_noise*.csv)]
  B --> CSV_B[(experiments_B.csv)]
  C --> CSV_C[(experiments_C.csv)]
  D --> CSV_D[(experiments_D.csv)]
  E --> CSV_E[(experiments_E.csv)]
```
