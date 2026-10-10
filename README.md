# stacktender

Keeps a Docker Compose stack current without breaking it: finds what is behind, applies the
routine updates by itself, watches the result, rolls back what does not come up healthy, and
keeps a copy of every service's data from right before it changed, so a rollback is an undo.
Everything else is put to a person with the facts and a recommendation.

It is the autopilot that the detectors lack. Renovate and Dependabot open pull requests;
Watchtower, WUD and Komodo pull and recreate; none of them looks at what happened next, and none
has the copy from before. stacktender is the loop around them: git is the source of truth, every
change is a commit, every commit is a deploy, every deploy is verified, and every verification
that fails is reverted while the previous data is put back.

**Status: in progress.** This README is the contract; the code comes from a home stack that has
run this loop since 2026 and is being extracted into this project. The core is here with its
tests: findings and policy from a Renovate report, verification and rollback with the journal, undo
by record or by commit, the backup sets and runs. The runtime around it (the Docker socket, git, the
Renovate and restic runners, the HTTP API, webhooks) and the shipped deploy follow.

## What it needs from your stack

- The stack is one git repository with a `docker-compose.yaml` at its root (more compose files
  through `include` are fine). Pinned image references in it: `image: redis:7.4.8-alpine`, with or
  without `@sha256:…`. Services built from the repository (`build:`) with their lockfiles
  (`package-lock.json`, `bun.lock`) are covered too.
- Service state lives in bind mounts under the repository directory that git does not track:
  `./postgres-data:/var/lib/postgresql/data`. That is how stacktender tells data from
  configuration without a list. Named volumes are not covered in version 1.
- Health checks on the services that have a way to express one (`healthcheck:` in the compose
  file). Without one, "healthy" means "running and not restarting".
- A Docker socket, read-write: stacktender recreates containers, stops them for a copy, and
  runs its two helpers (Renovate for the lookup, restic for the copies) as containers.
- Nothing else. No GitHub, no inbound internet, no agent on the host. A remote for the repository
  is optional; stacktender works on the checkout it has.

If your compose files sit in a directory without git, the first run makes it a repository.

## What it promises

1. **No change without a commit.** A version pin changes in git, with a message that says what
   moved and why, and that commit is what gets deployed. `git log` is the history of your stack.
2. **No deploy without a copy.** Before a service that keeps data gets a new image, its data is
   snapshotted, with the service stopped for the seconds that takes. The snapshot is tagged with
   the commit.
3. **No update without verification.** After a deploy, the affected containers are watched: they
   must run the new image, be healthy (or running without restarts when there is no health check),
   and stay so for a soak period. Your own check can veto at the end (the `veto` hook).
4. **A failed verification is undone.** The previous pin is committed and deployed, and the
   snapshot from before the update is restored first, so the previous version starts on the data
   it knows. If the undo itself fails, that is the one message that says "now".
5. **Routine updates only, by themselves.** A patch of a pinned version, a rebuilt image behind
   the same tag, a lockfile refresh within the declared ranges. Majors, 0.x minors, long catch-ups,
   images on moving tags, anything a rule holds: a person decides, from a proposal that carries
   the facts, and the verdict of your `assessor` hook when you have one.
6. **An update you regret later is still undoable.** Days after an update that verified fine, a
   person can ask for its undo: the data from right before it goes back under the previous version.
7. **It survives its own restarts.** An apply in flight is journalled on disk, not in anything the
   deploy may be restarting; after a restart it verifies or rolls back from where it was. stacktender
   can update its own image this way.

## How it works

```
      every N hours                            when due, one at a time, inside the apply window
  ┌──────────────┐    report     ┌──────────┐   commit + deploy   ┌────────┐   ok    ┌──────────┐
  │ scan         │ ───────────▶ │ policy   │ ─────────────────▶ │ verify │ ──────▶ │ applied  │
  │ (Renovate,   │               │ silent / │                     │ (soak, │         └──────────┘
  │  registries, │               │ ask /    │                     │  veto) │   not ok
  │  host)       │               │ hold     │                     └────────┘ ──────▶ restore copy,
  └──────────────┘               └──────────┘                                        revert pin,
                                       │ ask                                         deploy, tell
                                       ▼
                               proposal (webhook) ──▶ approve by git or HTTP ──▶ the same path
```

### Scan

Renovate runs in lookup mode against a clone of the repository (`--platform=local`): it reads the
compose files, the Dockerfiles and the lockfiles, asks every registry what exists, and writes a
report. It changes nothing. stacktender adds what Renovate cannot know:

- the digest of every running image, from Docker, so an image can be pinned to the exact build it
  runs without changing a bit (`digests` switch), and an upstream rebuild of the same tag shows
  up as a finding;
- the host's own account of pending security patches and a waiting reboot, read from the host's
  update summary through a bind mount (reported, never changed);
- the containers of other compose projects on the same machine, compared with the registry by
  what Docker says they run (reported, never changed; their files are not read).

### Policy

Every finding gets one of three policies, by rules you can extend:

| policy   | when                                                                                                                  | what happens                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `silent` | a patch of a pinned version, a digest, a lockfile refresh within range; older than `minimumReleaseAge`                | applied by itself, one at a time, in the window |
| `ask`    | a major, a 0.x minor, a catch-up longer than `maxCatchUp`, a moving tag, a failed-and-reverted update, a rule says so | a proposal to a person                          |
| `hold`   | a rule says so                                                                                                        | listed, nothing else                            |

Services everything depends on (`infraServices`: the broker, the databases, stacktender's own
dependencies) are only restarted inside `infraWindow`, at night.

An optional **assessor** (see Hooks) turns some asks into silents: for every minor and major
step it gets the step, the release notes link and the service's compose entry, and answers
`clean`, `needs a person` or `needs a code change`, with why. A minor it found clean, on a service
that keeps no data, goes by itself. Everything else goes to the person with the verdict attached.
stacktender has no opinion on what reads the notes: a script, an LLM you run, a person.

### Apply, verify, roll back

An apply edits the pin in every file that holds it, commits, pushes to the deploy (below) and
waits for it. Then it watches the affected containers for `deployTimeout` until each runs the new
image and is healthy, and for `soak` minutes after that none may fall over or restart. At the end
the veto endpoint, when configured, gets the update and may answer `{"ok": false, "why": "…"}`.

On failure: the snapshot the deploy took is restored under the service, stopped; the previous
pin is committed and deployed; the result is reported as `rolled_back` with what was restored, or
`rollback_failed` when the old version did not come up either.

### Copies

restic, in a container stacktender owns, with the repository outside the stack directory
(`../stacktender-backups` by default; any restic repository URL works, S3 and SFTP included).

Sets are derived from the compose file, not listed: a read-write bind mount under the repository
that git does not track is data; services sharing a directory, or depending on a service that
keeps one, form one set and are stopped together for the seconds a copy takes. Exceptions are
config (`noStop` for a store that is safe to copy live, `exclude` for caches and models, `data`
for files nothing mounts, like `.env`).

A nightly run copies every set, forgets old snapshots by the retention you set, and checks the
repository once a week. The same path serves the copy before an update, a restore and an undo.

### Deploy

stacktender ships the deploy, because the promises above are made inside it:

1. checkout of the pushed commit, build of the services whose context changed; a build that
   reproduces the image the service already runs (a change the Dockerfile does not copy, a test
   file for instance) ends the deploy there for that service: no copy, no recreate;
2. the test gate, if the repository has one (`deploy.test` in the config: a command that must
   exit 0, or nothing is reloaded or recreated), and the reload commands (`deploy.reload`: files
   applied by a command instead of a rebuild, bind-mounted code with a reload endpoint);
3. the copy of every set whose service gets a new image, tagged `deploy:<sha>`;
4. `docker compose up -d` of what changed (everything when the compose file changed);
5. the last-deployed marker, so a refused deploy is retried from the last one that went through;
6. a retained maintenance signal on the side channel while all this runs, so your monitoring can
   hold its alerts.

The test gate and the reload commands run inside the stacktender container: `sh` with git, the
docker CLI, curl, wget and node, on the host's network when the service has `network_mode: host`.

It is a shell script in the repository, invoked by a git hook on the checkout stacktender
deploys from. If you already have a deploy, keep yours and point stacktender's `deploy.command`
at it; then steps 3 and 5 are yours to provide, and the promises that rest on them are yours too.

### Telling and asking

Everything stacktender does or wants is an event: `scanned`, `needs_decision` (batched, at most
once per `announceInterval`), `applied`, `rolled_back`, `rollback_failed`, `undone`,
`backup_done`, `backup_failed`, `host_attention`. Events go to:

- **webhooks**: any URL, JSON body, with the usual services recognised by their URL shape (ntfy,
  Slack and Discord webhooks, Matrix through a hookshot URL, plain HTTP);
- **MQTT** (optional): a retained document with every finding and its state, plus the events,
  for a home automation that wants to act on them;
- the **HTTP API** on localhost: the list, the history, the sets, the snapshots.

A proposal is a prepared commit on a branch `stacktender/<id>`. Approving it is `git merge` and
push, or `POST /updates/<id>/apply`; dismissing is deleting the branch, or
`POST /updates/<id>/dismiss` with a reason and optionally a date to be asked again. The webhook
message carries both. Undo is `POST /updates/<id>/undo`, also for an update applied days ago.

Nothing asks twice: a dismissed finding stays quiet until the date you gave or until its target
moves again.

### Hooks

Two optional HTTP endpoints let your own judgement into the loop. Both are plain POST with JSON,
answered within a timeout; a hook that does not answer counts as "no opinion".

| hook       | when                                     | request                                                                   | answer                                                                              |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `assessor` | before a minor or major step is proposed | `{id, kind, name, from, to, updateType, services, files, sourceUrl, why}` | `{verdict: "clean" \| "needs a person" \| "needs a code change" \| "pending", why}` |
| `veto`     | at the end of the soak, before "applied" | `{name, from, to, services, sha}`                                         | `{ok: true}` or `{ok: false, why}`                                                  |

With an assessor, no minor goes by its age alone: every minor and major step is read first, one at
a time, and a proposal waits for the verdict, which it then carries. A minor found `clean` on a
service that keeps no data (`assessorAskAnyway` lists the exceptions) is applied like a patch. A
reader that takes longer than the timeout answers `pending`: it is asked again every five minutes
for a day, and starts its reading on the first call. A hook that cannot be reached is tried again
after an hour.

stacktender ships no assessor. The stack this comes from answers with a coding agent that reads
the release notes; a script that greps a changelog for "breaking" is a valid one too.

## Install

stacktender runs as a container next to the stack, with the Docker socket, the stack directory
mounted at its own host path (so compose resolves the relative bind mounts) and a data directory:

```yaml
services:
  stacktender:
    image: ghcr.io/handijk/stacktender:0.1.0
    restart: unless-stopped
    user: '1000:1000' # the owner of the stack directory
    group_add: ['999'] # the group of /var/run/docker.sock
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /home/me/stack:/home/me/stack # the stack directory, at its own path
      - /var/lib/update-notifier:/host/update-notifier:ro # optional: the host's patch summary
      - /var/lib/apt/periodic:/host/apt-periodic:ro
      - /lib/modules:/host/modules:ro
    working_dir: /home/me/stack
    environment:
      - STACKTENDER_WEBHOOK=https://ntfy.sh/your-topic
    ports:
      - '127.0.0.1:8800:8800'
```

The first run makes the directory a git repository if it is none, with the data directories
ignored, writes a default `stacktender.yaml` next to the compose file, starts the restic runner
container, and scans. With `autopilot: false` (the default for a new stack) it only reports; set
it to `true` once the reports look right. The data directory is `./stacktender-data` by default
(`--data` or `STACKTENDER_DATA` for another place); the restic repository is
`../stacktender-backups` (`backups.repository`, any restic repository URL works).

Without a container: `npx stacktender --stack /home/me/stack` on a machine with git and the
docker CLI.

### A push by hand

When people push to the stack's repository, a `post-receive` hook on that checkout asks
stacktender to deploy, and relays its lines (the `[deploy] done:` line marks success):

```sh
#!/bin/bash
read old new ref
[ "$ref" = refs/heads/main ] || exit 0
curl -s --max-time 3600 -X POST http://127.0.0.1:8800/deploy -H 'Content-Type: application/json' \
  -d "{\"old\":\"$old\",\"new\":\"$new\",\"reason\":\"push\"}" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("\n".join("[deploy] "+l for l in d["output"].split("\n") if l)); sys.exit(0 if d["ok"] else 1)'
```

stacktender's own definition in the compose file is never recreated in the middle of a deploy: it
brings up everything else, answers, and a moment later starts a helper container (its own image's
docker CLI, with the socket and the stack directory mounted) that recreates it; a compose started
inside the container it recreates would die with it half way. The socket must sit at the same path
on the host as in the container (`/var/run/docker.sock`, as in the install above).

### The API

On `localhost:8800`, JSON, no authentication (bind it to localhost or put it behind something
that has one):

| route                             | what                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /status`                     | the engines' status, the last scan and deploy, the signals                                  |
| `GET /updates?only=need_decision` | the findings with their policy and state, and the history                                   |
| `POST /updates/<id>/apply`        | try one now (`{"in_window": true}` queues it for its own time)                              |
| `POST /updates/<id>/dismiss`      | `{"days": 30, "reason": "..."}`                                                             |
| `POST /updates/<id>/undo`         | take an applied update back; `GET /updates/undoable` lists them                             |
| `POST /scan`                      | scan now                                                                                    |
| `GET /backups`, `/backups/sets`   | the sets, the runs, the last night                                                          |
| `GET /backups/snapshots?set=…`    | the snapshots                                                                               |
| `POST /backups/now`               | a backup now (`{"set": "…"}` for one)                                                       |
| `POST /backups/restore`           | `{"set": "…", "snapshot": "<id>"}`                                                          |
| `POST /deploy`                    | `{"old": "<sha>", "new": "<sha>"}`: a deploy, for the git hook of a push by hand            |
| `POST /maintenance`               | `{"source": "…", "active": true}`: another tool's planned work, which stacktender waits for |
| `GET /events`                     | the last events                                                                             |

## Configuration

`stacktender.yaml` in the repository, committed like everything else:

```yaml
autopilot: true # false: everything is a proposal
scanIntervalHours: 6
applyWindow: {from: '10:00', to: '17:00'}
infraWindow: {from: '02:00', to: '05:00'}
infraServices: [mosquitto, postgres]
minGapMinutes: 30 # between two applies
soakMinutes: 5
deployTimeoutMinutes: 15
minimumReleaseAgeDays: 3 # a release younger than this waits
maxCatchUpDays: 60 # longer behind than this: ask
digests: true
digestIntervalDays: 7
exactTags: {'redis:7-alpine': '7.4.8-alpine'} # a moving tag replaced by the version it is today
rules:
  - match: '^timescale/timescaledb$'
    updateTypes: [major, minor, patch]
    policy: ask
    why: 'the extension inside the database has to be updated by hand afterwards'
hooks: # both optional
  assessor: http://localhost:3000/updates/assess
  assessorAskAnyway: [stacktender] # never silent on a clean verdict, these
  veto: http://localhost:3000/updates/veto
backups:
  repository: ../stacktender-backups # or s3:..., sftp:...
  at: '01:00'
  keepWithin: 14d
  keepWeekly: 8
  host: stack # the host name on the snapshots; keep an existing repository's
  exclude: [ollama-data, loki-data]
  noStop: [mosquitto]
  data: [.env]
host:
  report: true # needs the /host mounts above
scanner:
  image: renovate/renovate:44
deploy:
  test: # optional gate: must exit 0, or nothing is reloaded or recreated
    command: docker compose run --rm tests
    paths: [app/] # only when a change touches these; every build or reload when absent
  reload: # files applied by a command instead of a rebuild
    - paths: [app/automations/]
      command: curl -sS -X POST http://localhost:3000/admin/reload
  # command: ./scripts/deploy.sh # bring your own instead of the shipped one
notify:
  webhooks: [https://ntfy.sh/your-topic]
  mqtt: # optional: the maintenance signal retained per source on
    url: mqtt://localhost #   <maintenanceTopic>/<name>-<source>, so a watchdog can hold
    maintenanceTopic: stacktender/maintenance #   its alerts while planned work runs; events on eventsTopic
    eventsTopic: stacktender/events
    stateTopic: stacktender/state
    name: stacktender
```

## What it does not do

- Named volumes, data outside the stack directory, and stacks spread over several hosts. Version 1
  is one host, one directory.
- Install host packages. It reports that security patches stopped arriving or a reboot has been
  waiting; a person with sudo does the rest.
- Zero-downtime. A service is recreated, and stopped for its copy. Seconds, not none.
- Judge an application that is up but wrong. That is what the veto endpoint is for, and your
  monitoring.
- Device firmware, models, other stacks' files. Out of scope here; the home stack this comes
  from does those in its own automations next to stacktender.

## Roadmap

- 0.1: the loop for images and digests, the deploy, the copies, webhooks, the HTTP API.
- 0.2: lockfile refreshes for services built from the repository, the hooks, MQTT.
- 0.3: named volumes; a proposal UI by someone who likes UIs.

## License

MIT
