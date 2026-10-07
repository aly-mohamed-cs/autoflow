# Autoflow

No-code RPA for the whole company: people who don't write code build automations by
recording or arranging plain-English steps, and robots run them unattended on
dedicated Windows machines.

| Part | What it is | Where it runs |
|---|---|---|
| **Autoflow Studio** | Designer: step builder, recorder, test-run debugger | Designer PCs (Windows app) |
| **Autoflow Orchestrator** | Web dashboard + API: publishing, schedules, queues, vault, run history | Company server (Windows service) |
| **Autoflow Robot** | Runs published flows unattended | Robot PCs (Windows service) |
| **Engine** | Python runtime shared by Studio and Robot | Bundled inside both |

## Repository layout

```
apps/studio       Electron + React designer
apps/dashboard    React web dashboard (served by the server)
apps/server       Orchestrator API (Fastify + SQLite)
packages/ui       Shared design system
packages/flow-types  Generated catalog + flow schema used by the TS apps
engine/           Python engine (flows, activities, JSON-RPC for Studio)
robot/            Python robot agent (enroll, connect, run jobs)
testbed/          Demo web portal used by tests and demos
deploy/windows/   Server install / update / backup scripts
```

## Development setup (Windows)

Prerequisites: Git, Node.js 24, [pnpm](https://pnpm.io) 10, [uv](https://docs.astral.sh/uv/).

```powershell
pnpm install
cd engine; uv sync; cd ..
pnpm engine:test     # engine tests
pnpm catalog         # regenerate packages/flow-types/generated after changing activities
```

Run a flow from the command line:

```powershell
cd engine
uv run autoflow-engine run path\to\flow.json --inputs '{"name": "Mona"}'
```

## Adding an automation step

Activities live in `engine/src/autoflow_engine/activities/`. Register a function with
`@activity(...)`, describe its settings with a `Params` model using `Param(...)`
(title, widget kind, help text), then run `pnpm catalog`. Studio renders the new
step automatically. `tests/test_catalog_and_validation.py` checks every activity is
complete.

## For people using Autoflow

See the [user guide](docs/USER-GUIDE.md): your first automation, recording, picking elements,
Excel/web/desktop/PDF/email tasks, schedules, queues and keyboard shortcuts.

## Deployment

| Guide | For |
|---|---|
| [deploy/SERVER-SETUP.md](deploy/SERVER-SETUP.md) | IT: install the Orchestrator on the company server from this repository, Active Directory sign-in, updates, backups |
| [deploy/ROBOT-SETUP.md](deploy/ROBOT-SETUP.md) | IT: turn a Windows PC or VM into an unattended robot |

Short version, on the server (PowerShell as administrator):

```powershell
git clone https://github.com/aly-mohamed-cs/autoflow.git C:\RPA-Server
cd C:\RPA-Server
.\deploy\windows\install-server.ps1      # later, to update: .\deploy\windows\update-server.ps1
```

## Tests

```powershell
pnpm typecheck; pnpm test          # TypeScript apps (unit tests + Orchestrator integration)
cd engine; uv run pytest           # engine, incl. real browser tests on the demo portal
cd robot;  uv run pytest           # Orchestrator + robot + engine end to end (build the server first)
cd apps\studio; pnpm e2e           # Studio desktop app, driven like a user
```
