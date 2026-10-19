# United Alliance

A multi-agent system you run on your own machines. An **Overseer** server with its own
coordinating agent takes your goals and staffs them: it spawns as many agents as the work
needs on **hosts** (harnesses) on any number of machines, gives them roles and retires
them when they're done. A **helper** answers the Overseer for you while you're away, every
agent coordinates in the open on a shared **board**, and a web **console** lets you talk
to the Overseer, the helper or any agent and watch everything as it happens.

- **Overseer:** Node.js + TypeScript (Fastify, WebSockets, built-in SQLite)
- **Console:** React + Vite
- **Harness:** Python 3.10+, runs on Windows and Linux
- **Models:** DeepSeek today (OpenAI-format API); keys stay on the Overseer

> **Status: early.** The Overseer only accepts connections from this machine and private
> networks, and there is no operator login yet. Don't expose it to the internet.

## Requirements

- [Node.js](https://nodejs.org) 22.5 or newer (24 tested), npm 10+
- Python 3.10+ on every machine that runs a host
- A DeepSeek API key

## Quick start

**Windows:** double-click **`start.cmd`**. It installs dependencies on first run, then
asks how to start:

- **[1] Overseer server** (default): runs the real backend; the console opens at
  http://localhost:8080. Data is kept in `apps/overseer/data/`.
- **[2] Demo**: console with mock data, no server (http://localhost:5173)
- **[3] Console only**: console connected to an Overseer elsewhere

Skip the question with `start.cmd server`, `start.cmd mock` or `start.cmd live <url>`.

**Any OS:**

```bash
npm install
npm start          # Overseer + console on http://localhost:8080
npm run dev        # demo console with mock data on http://localhost:5173
```

First steps with the server: **Settings** → add your DeepSeek API key → **Hosts → Add
host** → Windows or Linux → download the zip on the target machine → run `start.cmd`
there → give the Overseer a task. Tell the **Helper** how to handle things while you're
away, and read along on the **Board**. If Windows Firewall asks, allow Node.js on private
networks so hosts on your LAN can connect.

## Adding a machine

Console → **Hosts → Add host** → Windows or Linux. Download the zip (or copy the
one-line installer), run `start.cmd` / `./start.sh` on that machine. It enrolls with the
Overseer on first start; there are no API keys in the package.

A host is not an agent. It offers seats (8 by default, `--slots N` to change); the
Overseer fills them with agents when there's work and retires agents that fail, stop or
sit idle. Only one copy runs per folder: start it again and the new copy waits in
standby, taking over if the running one stops.

## Your data

Everything the Overseer knows lives in `apps/overseer/data/` (set `ALLIANCE_DATA_DIR` to
move it): one SQLite database and the master key that encrypts your API keys. It is
ignored by git.

To start over, use **Settings → Remove all data**. It deletes the database and master
key and restarts the Overseer empty, as on its first start. Hosts have to be added again
afterwards.

## Configuration

Most settings live in the console. A few are read from the environment at boot:

| Variable | Default | |
|---|---|---|
| `ALLIANCE_PORT` | `8080` | HTTP + WebSocket port |
| `ALLIANCE_BIND` | `0.0.0.0` | Listen address (the network guard still allows private ranges only) |
| `ALLIANCE_DATA_DIR` | `apps/overseer/data` | Database and master key |
| `ALLIANCE_DEEPSEEK_API_KEY` | | Provider key from the environment (locks it in the console) |
| `ALLIANCE_MASTER_KEY` | | 32-byte key (hex or base64) instead of the generated key file |
| `ALLIANCE_ALLOW_PUBLIC` | | Force public access on or off |

## Development

```bash
npm run typecheck                      # all workspaces
npm test                               # Overseer + harness-kit tests
cd apps/harness && python -m unittest discover -s tests -t .   # harness tests
```

| Workspace | |
|---|---|
| `packages/protocol` | Shared types: entities and wire messages |
| `packages/harness-kit` | Generates Windows/Linux host builds |
| `apps/overseer` | Server: state, scheduler, workers, board, Overseer + helper agents, model gateway |
| `apps/web` | Operator console |
| `apps/harness` | The harness, in Python |

| Doc | What's in it |
|---|---|
| [DESIGN.md](DESIGN.md) | Architecture, context management, long-running tasks, monitoring, security |
| [CODE.md](CODE.md) | Repo layout, conventions, how to add tools, pages and messages |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | WebSocket + REST contract |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Database tables |
| [docs/UI.md](docs/UI.md) | Console design language and screens |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Build phases |

## License

[MIT](LICENSE)
