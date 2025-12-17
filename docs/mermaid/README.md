# Mermaid diagrams

This folder contains Mermaid diagrams describing how ICUM-SIM works.

- `system-overview.mmd`: high-level architecture (UI ↔ engine ↔ firmware ↔ cloud).
- `cloud-fusion.mmd`: how `CloudBackend` buffers reports and runs pose-graph fusion.
- `adaptive-publish-and-sensing.mmd`: when nodes publish/sense while stationary vs moving.
- `icum-event-driven-sensing.mmd`: IMU/topology-triggered sensing to reduce messages.
- `cloud-publish-policy.mmd`: shared publish gating used by both UI and experiments.

Preview in VS Code with a Mermaid extension, or Markdown preview if enabled.
