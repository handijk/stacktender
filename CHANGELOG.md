# Changelog

## 0.1.0 (unreleased)

### Fixed

- stacktender's own recreate after a change of its definition or configuration starts its delay when the
  deploy has finished, not when the compose step did: a deploy with a long reload was killed before its
  answer (0.0.14).

### Added

- The loop for images and digests: findings and policy from a Renovate scan, silent applies one at
  a time inside the window, verification with a soak, rollback with the copy from before, resume
  after a restart, undo by record or by commit, proposals and dismissals.
- The copies: restic in a runner container stacktender starts itself, sets derived from the
  compose file, nightly runs, the copy before a service that keeps data gets a new image, restores
  with a copy first.
- The shipped deploy: build what changed, the test gate, the copy, `docker compose up`, the
  last-deployed marker, the check that a rebuilt stacktender starts, housekeeping.
- The HTTP API, webhooks (JSON, ntfy, Discord, Slack), the maintenance signal between the parts,
  the hooks (`assessor`, `veto`), the host report.
- The first run makes the stack directory a git repository with its data directories ignored.
- MQTT (optional): the maintenance signal per source retained, events and state published.
- `backups.host` for the host name on the snapshots; a deploy never recreates stacktender itself
  mid-run but after its answer.
