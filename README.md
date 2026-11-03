# Deploy by Command

**A safe LLM-driven platform for automated AWS EC2 and Docker deployment from text commands.**

You type (or say) what you want, for example *"Deploy my website"*. A language model (Gemini, with a rule-based fallback) maps the sentence to **one of seven approved intents**. The backend then runs a fixed, pre-written workflow: launch an EC2 server, install Docker over SSH, deploy a container and check it from the public internet. Anything unclear or destructive maps to `UNKNOWN`, and then nothing runs.

> Re-implementation of the architecture described in *Deploy by Command* (Gullapalli & Ruthvika, VIT Vellore).

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/Saipavanavsp/deploy-by-command/blob/main/colab/Deploy_by_Command_Colab.ipynb)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Saipavanavsp/deploy-by-command)

| | Link |
|---|---|
| **Source code** | https://github.com/Saipavanavsp/deploy-by-command |
| **Notebook in Google Colab** | [Open in Colab](https://colab.research.google.com/github/Saipavanavsp/deploy-by-command/blob/main/colab/Deploy_by_Command_Colab.ipynb), then *Runtime → Run all* |
| **Live simulated demo** | https://deploy-by-command-demo.onrender.com/?token=ACCESS_TOKEN (needs the access token; see [Live demo](#live-demo-render)) |

**You don't need to run anything to evaluate this project.** All results below were recorded on a Google Colab runtime and on the dashboard, and are shown with screenshots in [Results and walkthrough](#results-and-walkthrough).

---

## Results at a glance

| What was checked | Result | Reproduces |
|---|---|---|
| Automated tests (7 areas) | **29 / 29 passed** in about 5 s | Table III |
| Rule classifier on 12 reference commands | **12 / 12 passed** | Table IV |
| Free-form sentence *"can you put my site on the internet please"* | Rules: **UNKNOWN (0.2)**, nothing runs · Gemini: **FULL_DEPLOY (0.95)** | Table IV / V |
| Live Gemini, 3 commands (`gemini-flash-lite-latest`) | **3 / 3 understood** by Gemini (0.95, 0.90, 0.95) | Table V |
| Backend latency on Colab (median / p95, n = 50) | `/health` 2.0 / 3.2 ms · `/command` 1.8 / 2.7 ms · `/logs` 1.9 / 4.7 ms | Table VIII |
| Rate limit 240 requests/min | **Enforced**: request #241 got HTTP 429 | Table VIII |
| Simulated end-to-end deployment | Launch → Configure → Deploy **all done**; second run **skips** finished steps | Sec. 4 |
| Destructive commands (*"delete everything"*, *"terminate my instance"*) | **UNKNOWN, nothing was run** | Safety |
| Terminate | Refused without typed confirmation; works with `TERMINATE` | Safety |
| Real AWS launch / deploy | **Not run** (needs a billable AWS account; disabled by default) | — |

---

## Contents

- [Results at a glance](#results-at-a-glance)
- [Results and walkthrough](#results-and-walkthrough)
- [Architecture](#architecture)
- [The seven intents](#the-seven-intents)
- [Safety design](#safety-design)
- [Setup: local](#setup-local)
- [Setup: Google Colab (VS Code Colab extension)](#setup-google-colab-via-the-vs-code-colab-extension)
- [Environment variables](#environment-variables)
- [IAM policy (least privilege)](#iam-policy-least-privilege)
- [API](#api)
- [Tests, evaluation and benchmark](#tests-evaluation-and-benchmark)
- [Status](#status)

---

## Architecture

```mermaid
flowchart LR
  subgraph Client["Client layer (browser)"]
    U([User]) -->|types| TB[Command box]
    U -->|speaks| WS[Web Speech API]
    WS --> TB
    TB --> DASH[React dashboard<br/>command · actions · progress · live logs · result + URL]
  end

  subgraph Backend["Backend layer (Node.js + Express on 127.0.0.1)"]
    API[API layer<br/>zod validation · helmet · CORS allowlist · rate limit 240/min · 10 KB]
    CLS[LLM classifier<br/>1 of 7 intents]
    WF[Workflow handler<br/>preconditions · one-job lock · step status]
    ST[(State + logs<br/>saved to disk, per mode)]
    PS{Provider selection<br/>MODE = mock / aws}
    API --> CLS --> WF
    WF --> ST
    WF --> PS
  end

  GEM[[Gemini API<br/>external]]
  CLS <-.->|command text only| GEM
  DASH <-->|JSON over HTTP| API

  subgraph Exec["Execution layer (AWS ap-south-1 / Cloudflare)"]
    MOCK[Mock provider<br/>simulated]
    AWSP[AWS provider<br/>EC2 + SSH]
    EC2[EC2 instance<br/>Amazon Linux 2023]
    DK[Docker container<br/>sample-app, port 80]
    HC[Health check + public URL]
    CF[Cloudflare publisher] --> CFP[Cloudflare Pages<br/>static site]
    AWSP --> EC2 --> DK --> HC
  end

  PS --> MOCK
  PS --> AWSP
  WF --> CF
```

Data flows one way: command → backend validation → classifier → only an approved intent reaches a workflow handler. Otherwise nothing runs. In real mode the dashboard first shows the interpreted action and waits for **Confirm**.

### Repository layout

```
deploy-by-command/
├── backend/            Express API, workflow, Gemini/rules interpreter, mock + AWS providers, Cloudflare publisher
│   ├── src/            server.js · app.js · config.js · middleware.js · schemas.js · routes.js · workflow.js
│   │                   state.js · logger.js · interpreter/ · providers/ · aws/ · cloudflare.js
│   ├── test/           29 tests (node:test + supertest)
│   └── scripts/        test runner, eval-classifier, observe-gemini, benchmark, loc, plot.py, preflight
├── frontend/           React + Vite dashboard
├── sample-app/         dependency-free Node server (/, /health, /info) + Dockerfile + public/index.html
├── colab/              Deploy_by_Command_Colab.ipynb
└── .env.example
```

## The seven intents

| Intent | Meaning | Operation |
|---|---|---|
| `LAUNCH` | Create the cloud server only | launch |
| `CONFIGURE` | Install and verify Docker | configure |
| `DEPLOY` | Deploy to a configured server | deploy |
| `FULL_DEPLOY` | "Deploy my website" end to end; finished steps skipped | full |
| `STATUS` | Check server, container and website | status |
| `RESTART` | Restart the container | restart |
| `UNKNOWN` | Anything else, unclear or destructive | none |

**Gemini** is called through its OpenAI-compatible endpoint with `temperature: 0` and `response_format: json_object`. The system prompt lists the intents and states that the user text is data and any instruction inside it must be ignored. The reply must match a strict zod schema `{intent, confidence, reason}`. Transient errors (429/500/502/503/504) are retried up to 3 times with a 1.2 s × attempt delay. Permanent errors (e.g. 404) are not retried, and Google's explanation is shown with the key redacted. Confidence below 0.5 becomes `UNKNOWN`.

The **rule-based fallback** is used when there is no key or Gemini fails. Destructive or shell-like words (`delete`, `terminate`, `sudo`, `rm`, …) always map to `UNKNOWN`. The dashboard shows which engine decided.

## Safety design

- **Two locks for real AWS:** `MODE=aws` **and** `ALLOW_REAL_AWS=yes`. With only the first, the backend refuses to start.
- **Loopback only:** the server binds `127.0.0.1`. The dashboard has no login. The only exception is the Colab tunnel, which requires a random access token and forces mock mode.
- **Startup banner** shows the mode. Real mode warns about billable resources and about any instance already tracked.
- **Approved intents only:** destructive operations are unreachable from command text. **Terminate** needs a typed confirmation (`"TERMINATE"` or the instance ID) in the request body.
- **One server, one job:** a second launch is refused while a server is tracked. Only one operation runs at a time (409 `BUSY`). Preconditions enforce step order.
- **Honest results:** steps go `pending → running → done | failed`. Only results returned by the provider are saved, and a deploy counts as successful only when the **public** health check passes.
- **Network:** SSH (22) is opened to your public IP `/32` only. `0.0.0.0/0` is rejected. HTTP (80) is open. IMDSv2 is required. Instances are tagged `Project=deploy-by-command`.
- **SSH host key pinning:** the SHA-256 fingerprint is logged and pinned on first contact, and a different key is refused later. Every remote command is a hardcoded string.
- **Secrets:** the Gemini key, Cloudflare token and AWS keys are redacted from every log line and error. The private key path never reaches the browser. The key file is written with mode 600. `.env`, `keys/` and `state/` are git-ignored.
- **Per-mode state:** `state/state-mock.json` and `state/state-aws.json` are separate. Simulated state can never load in real mode.
- **API hardening:** helmet, a CORS allowlist (cross-site requests get 403), 240 requests/min (429), a 10 KB JSON body limit, zod validation (commands 1–300 characters).

## Results and walkthrough

All outputs below are real, recorded on **3 November 2026**. Parts 1–3 ran on a **Google Colab runtime** (Intel Xeon 2.20 GHz, Node v22.23.4, Linux) using the notebook [`colab/Deploy_by_Command_Colab.ipynb`](colab/Deploy_by_Command_Colab.ipynb). Part 4 is the dashboard in **simulated mode**, and Part 5 is the hosted demo on Render.

### Part 1 — Setting up the Colab runtime

**Step 1. Configuration.** Secrets come from Colab Secrets and are never printed.

![Colab configuration cell output](docs/screenshots/01-colab-config.png)

**Step 2. Node.js 22** installed from NodeSource.

![Node.js version](docs/screenshots/02-colab-node.png)

**Step 3. Clone the repository and install dependencies** (`npm ci` in `backend/` and `frontend/`).

![Clone and npm ci](docs/screenshots/03-colab-clone-install.png)

### Part 2 — Evaluation (Tables III, IV, V, VIII and Fig. 14)

**Table III: 29 automated tests, all passing.** They call the real HTTP API with the simulated provider; Gemini and Cloudflare are replaced by stubs, so the tests are fast and repeatable.

![29 tests passing](docs/screenshots/04-colab-tests-29-of-29.png)

| Area | Tests | What is verified |
|---|---|---|
| Health and routing | 2 / 2 | Mock-mode health; every route works with and without `/api` |
| Rule classifier | 1 / 1 | The 12 reference commands map to the expected intents |
| Gemini handling | 7 / 7 | Valid reply used; off-list reply rejected; failures fall back without leaking the key; low confidence → UNKNOWN; 404 shows the cause with the key redacted; 503 retried; 404 not retried |
| Validation and refusal | 2 / 2 | Empty, too-long and malformed input rejected; unsupported command runs nothing |
| Workflow and ordering | 6 / 6 | Prerequisites; full workflow; one job at a time (409); finished steps skipped; typed Terminate confirmation; a failing provider is never reported as success |
| Configuration and safety | 4 / 4 | Real mode refused without the second lock; SSH `0.0.0.0/0` rejected; no key path reaches the browser; separate state per mode |
| Cloudflare route | 7 / 7 | Needs credentials; correct URL chosen; "verified" only after HTTP 200; unreachable reported; errors and token redacted |
| **Total** | **29 / 29** | |

**Table IV: the rule-based classifier, 12 / 12.**

![Table IV classifier evaluation](docs/screenshots/05-colab-table4-classifier.png)

The rules deliberately do **not** understand free phrasing. *"can you put my site on the internet please"* → `UNKNOWN` (confidence 0.2), so nothing runs and the reason is shown. Understanding phrasing like this is Gemini's job (Table V).

**Table V: live Gemini.** Every command was understood by Gemini, including the free-form sentence the rules could not handle.

![Table V live Gemini](docs/screenshots/06-colab-table5-gemini.png)

| Command | Intent | Engine | Confidence | Time |
|---|---|---|---|---|
| "Deploy my website" | FULL_DEPLOY | gemini | 0.95 | 37.5 s |
| "Deploy my website" | FULL_DEPLOY | gemini | 0.90 | 69.5 s |
| "can you put my site on the internet please" | FULL_DEPLOY | gemini | 0.95 | 40.0 s |

Observations:
- **Confidence varies slightly:** the same command gave 0.95 and then 0.90, even at temperature 0. The intent stayed the same.
- **Times were unusually long that day.** The API key had just hit Google's free-tier rate limit (earlier runs returned HTTP 429 and 503). In those runs the app correctly fell back to the rules engine and showed the reason, which is the designed safe behaviour. The dashboard limits each Gemini request to 20 s (`GEMINI_TIMEOUT_MS`); this measurement allowed 120 s.

**Building the dashboard** (`vite build`):

![Vite build](docs/screenshots/07-colab-frontend-build.png)

**Table VIII: performance** (simulated mode, loopback, 50 sequential requests per endpoint):

![Table VIII benchmark](docs/screenshots/11-colab-table8-benchmark.png)

| Measurement | Value |
|---|---|
| `GET /health` median / p95 | 2.00 ms / 3.16 ms |
| `POST /command` (rules) median / p95 | 1.77 ms / 2.73 ms |
| `GET /logs` median / p95 | 1.86 ms / 4.72 ms |
| Bare Node HTTP server (baseline) median / p95 | 0.66 ms / 2.03 ms |
| Rate limit (240 / min) | 260 sent: 240 × HTTP 200, 20 × HTTP 429 (first 429 at #241), so it is **enforced** |
| Automated tests | 29 / 29 passed in 5.28 s |
| Frontend bundle, raw / gzip | JS 155.98 kB / 50.25 kB · CSS 6.29 kB / 2.06 kB |
| Real AWS launch / deploy time | not measured (needs a live AWS run) |

**Fig. 14: tests passed by area, and backend response time by endpoint.**

![Fig. 14](docs/screenshots/12-colab-fig14.png)

### Part 3 — Simulated end-to-end deployment (from Python on Colab)

**Starting the backend.** The banner states the mode clearly. In simulated mode nothing touches AWS, SSH or Docker.

![Backend banner](docs/screenshots/08-colab-backend-start.png)

**"Deploy my website"** is interpreted as `FULL_DEPLOY`. The server answers **202 Accepted** and runs launch → configure → deploy in the background. Every provider line is tagged `[SIMULATED]`, and the IP comes from the reserved documentation range `198.51.100.0/24`. In this run Gemini was rate-limited (HTTP 429), so after 3 attempts the rules engine decided, and the warning says so.

![End-to-end simulated deployment](docs/screenshots/09-colab-e2e-full-deploy.png)

**Second run and safety checks:**
- **Finished steps are skipped:** the second run logged *"skip launch"* and *"skip configure"*, so only deploy ran.
- **Second launch refused:** with **409 ALREADY_TRACKED**, because only one server is allowed.
- **Destructive text refused:** *"delete everything"* and *"terminate my instance"* became **UNKNOWN** with `operation=None`, so nothing ran.

![Skip steps and refuse destructive commands](docs/screenshots/10-colab-skip-steps-and-unknown.png)

### Part 4 — The dashboard (Fig. 9/10)

**Command and interpretation.** The yellow banner and the **SIMULATED · MOCK** badge make the mode obvious. The card shows the intent, which engine decided, the confidence, the reason and the plan.

![Dashboard interpretation](docs/screenshots/13-dashboard-interpretation.png)

**Actions and progress.** Launch, Configure and Deploy each go *pending → running → done*.

![Dashboard actions and progress](docs/screenshots/14-dashboard-actions-progress.png)

**Live logs and result.** The logs have timestamps and levels and auto-scroll. The result card shows the server ID, the example IP (marked as not real), Docker *ready*, and the URL with a **healthy** badge.

![Dashboard logs and result](docs/screenshots/15-dashboard-logs-result.png)

**Refusal of a destructive command.** *"delete everything"* → **UNKNOWN** with *"No action. Nothing was run."* and the list of supported actions.

![Dashboard UNKNOWN refusal](docs/screenshots/16-dashboard-unknown-refusal.png)

**Terminate with typed confirmation.** It runs only after typing `TERMINATE` (or the instance ID). The security group, key pair and local key file are deleted (simulated here), and the progress resets.

![Dashboard terminate](docs/screenshots/17-dashboard-terminate.png)

![Dashboard progress reset](docs/screenshots/18-dashboard-progress-reset.png)

### Part 5 — Hosted simulated demo (Render)

The repository includes [`render.yaml`](render.yaml), so Render builds and runs the app from GitHub with **one click**. It stays in simulated mode and is protected by a random access token.

![Render blueprint](docs/screenshots/19-render-blueprint.png)

![Render sync](docs/screenshots/20-render-sync.png)

![Render deployed](docs/screenshots/21-render-deployed.png)

### Issues found during the runs, and how they were fixed

| Problem observed | Cause | Fix |
|---|---|---|
| Notebook failed with `WinError 5` on `/content/...` | It was running on the **local Windows** Python kernel instead of a Colab runtime | Cell 1 now stops with a clear message if the kernel is not Linux; re-cloning removes read-only git files |
| `/command` call timed out in the notebook | Gemini was overloaded (503) and the retries took about 30 s | Notebook API timeout raised to 120 s; `GEMINI_MODEL` can be set in cell 1 |
| Gemini answers took up to 70 s | API key rate-limited by Google | `GEMINI_TIMEOUT_MS` made configurable (dashboard 20 s, Table V measurement 120 s) |
| Cloudflare tunnel error 1033 / 530 | Colab blocks QUIC (UDP) and stops tunnel processes | Tunnel runs over HTTP/2 and waits for a registered connection; Render added as the stable live option |
| Deploy stopped with `EPERM … rename` on Windows | OneDrive briefly locks files while syncing | State save retries, then writes directly; a step is never left "running" after a failure |
| Access token in the link rejected | A `+` in the token is read as a space in URLs | The server restores `+` in `?token=` |

## Setup: local

Requirements: Node.js 22+ (and, for real mode only, an AWS account plus the IAM user below).

```bash
git clone https://github.com/<you>/deploy-by-command.git
cd deploy-by-command
cp .env.example .env            # keep MODE=mock to start
cd backend  && npm ci && cd ..
cd frontend && npm ci && npm run build && cd ..
cd backend && npm start         # http://127.0.0.1:4000 serves the dashboard + API
```

For frontend development with hot reload, run `npm run dev` in `frontend/` (http://127.0.0.1:5173; `/api` is proxied to the backend).

**Real AWS (billable):** create the IAM user below, configure an AWS CLI profile named `deploy-by-command`, then set `MODE=aws` and `ALLOW_REAL_AWS=yes`. Run `npm run preflight` in `backend/` first: it creates nothing. Always **Terminate** when done.

**Cloudflare Pages (optional):** set `CLOUDFLARE_API_TOKEN` (Pages edit permission) and `CLOUDFLARE_ACCOUNT_ID`, then click *Publish to Cloudflare*. This uses `npx wrangler pages deploy sample-app/public`. The result is reported as **verified** only if the URL answers HTTP 200.

## Setup: Google Colab (via the VS Code Colab extension)

**In the browser:** click the *Open in Colab* badge at the top, then *Runtime → Run all*.

**In VS Code:**

1. Install the **Google Colab** extension in VS Code and sign in with your Google account.
2. Open `colab/Deploy_by_Command_Colab.ipynb`.
3. Click **Select Kernel → Colab → New Colab Server** (CPU, standard RAM).
4. *(Optional)* In Colab's 🔑 Secrets panel add `GEMINI_API_KEY` and grant notebook access. Without it, the rules engine is used and Table V is reported as *not measured*. If Gemini is slow, set `GEMINI_MODEL = "gemini-flash-lite-latest"` in cell 1.
5. The repository is public, so no GitHub token is needed (`PRIVATE_REPO = False`). For a private fork, set `PRIVATE_REPO = True` and add the Colab Secret `GITHUB_TOKEN`.
6. **Run All.** The notebook installs Node 22, clones the repo, runs the 29 tests, reproduces Tables IV/V/VIII and Fig. 14, runs a simulated end-to-end deployment from Python, and opens the dashboard. It tries Colab's port proxy first, then offers a Cloudflare quick tunnel protected by a random access token.
7. The final cell stops the backend and the tunnel (and terminates a real instance if one is tracked).

## Live demo (Render)

`render.yaml` deploys a **public, simulated** demo on Render's free plan. Safety still holds: `PUBLIC_DEMO=1` forces `MODE=mock` (it refuses real AWS), every request except `/health` needs a random `ACCESS_TOKEN` generated by Render, and the backend refuses to bind beyond `127.0.0.1` without `PUBLIC_DEMO=1`.

1. Click **Deploy to Render** above (or *New → Blueprint* in Render and pick this repo). Sign in with GitHub; the free plan needs no card.
2. Wait for the build (about 3–5 minutes).
3. In Render, open the service → **Environment** and copy `ACCESS_TOKEN`.
4. Open `https://<your-service>.onrender.com/?token=<ACCESS_TOKEN>` on any computer. The token is stored in a cookie for that browser.

The free plan sleeps after 15 minutes without traffic, so the first request after that takes about 30–60 s. Simulated state resets when the service restarts. Optionally add `GEMINI_API_KEY` under **Environment** (never in `render.yaml`).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MODE` | `mock` | `mock` (simulated) or `aws` (real) |
| `ALLOW_REAL_AWS` | `no` | Second lock: must be `yes` for real AWS |
| `AWS_REGION` | `ap-south-1` | Region |
| `AWS_PROFILE` | — | Profile of the dedicated IAM user (e.g. `deploy-by-command`) |
| `INSTANCE_TYPE` | `t3.micro` | EC2 instance type |
| `SSH_CIDR` | auto (your IP `/32`) | Source range for SSH. `0.0.0.0/0` is rejected |
| `GEMINI_API_KEY` | — | Enables Gemini. Never sent to the browser |
| `GEMINI_MODEL` | `gemini-flash-latest` | Model alias |
| `GEMINI_TIMEOUT_MS` | `20000` | Time limit per Gemini request; on timeout the rules engine decides |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | — | Cloudflare Pages route |
| `CF_PROJECT_NAME` | `deploy-by-command` | Pages project name |
| `PORT` / `HOST` | `4000` / `127.0.0.1` | Bind address (keep loopback) |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Allowed browser origins |
| `ENV_FILE` | — | Read `.env` from this path (keep secrets outside the project) |
| `MOCK_FAIL_STEP` | — | Make the mock fail at a step (honest-failure demo) |
| `MOCK_DELAY_MS` | `700` | Simulated delay per mock step |
| `COLAB_TUNNEL` / `ACCESS_TOKEN` | — | Colab only: require a token on every request; forces mock |
| `PUBLIC_DEMO` | — | Hosted demo (Render): like `COLAB_TUNNEL`, allows `HOST=0.0.0.0`; forces mock + token |

## IAM policy (least privilege)

Create a dedicated IAM user (for example `deploy-by-command`) with only this policy. Never put access keys in code, in this README, in screenshots or in logs.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Identity",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    },
    {
      "Sid": "LatestAL2023Ami",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters"],
      "Resource": "arn:aws:ssm:ap-south-1::parameter/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
    },
    {
      "Sid": "Describe",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceStatus",
        "ec2:DescribeInstanceTypeOfferings",
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeImages",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeKeyPairs"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CreateInRegion",
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances",
        "ec2:CreateKeyPair",
        "ec2:CreateSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress"
      ],
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "ap-south-1" } }
    },
    {
      "Sid": "TagOnCreateOnly",
      "Effect": "Allow",
      "Action": "ec2:CreateTags",
      "Resource": "*",
      "Condition": {
        "StringEquals": { "ec2:CreateAction": ["RunInstances", "CreateKeyPair", "CreateSecurityGroup"] }
      }
    },
    {
      "Sid": "DeleteOnlyOwnResources",
      "Effect": "Allow",
      "Action": ["ec2:TerminateInstances", "ec2:DeleteSecurityGroup", "ec2:DeleteKeyPair"],
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:ResourceTag/Project": "deploy-by-command" } }
    }
  ]
}
```

## API

Every route is mounted both at `/` and under `/api`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Backend health, includes `mode` |
| POST | `/command` | `{text}` → `{intent, confidence, reason, engine, plan, warning?}`. Interprets only; runs nothing |
| POST | `/launch` · `/configure` · `/deploy` · `/full` · `/restart` | Start an operation (**202**, runs in background) |
| GET | `/status` | Start a STATUS check (**202**) |
| POST | `/terminate` | Needs `{"confirm": "TERMINATE"}` or the instance ID |
| POST | `/cloudflare` | Publish `sample-app/public` to Cloudflare Pages |
| GET | `/logs?since=<id>` | Log lines after `id` |
| GET | `/state` | Sanitized state (no key paths, no secrets) |

Errors are machine-readable: `{"error": {"code": "BUSY" | "NO_INSTANCE" | "NOT_CONFIGURED" | "NOT_DEPLOYED" | "ALREADY_TRACKED" | "INVALID_INPUT" | "CONFIRMATION_REQUIRED" | "CLOUDFLARE_NOT_CONFIGURED" | ..., "message": "<plain English>"}}`.

## Tests, evaluation and benchmark

All commands run in `backend/`:

| Command | Reproduces |
|---|---|
| `npm test` | Table III: 29 tests in 7 areas, prints `29/29` |
| `npm run eval` | Table IV: rule classifier, prints `12 / 12` |
| `npm run observe` | Table V: live Gemini (needs `GEMINI_API_KEY`; otherwise says *not measured*) |
| `npm run bench` | Table VIII: median/p95 for `/health`, `/command`, `/logs` (50 requests each), 429 enforcement, test time, bundle sizes |
| `npm run loc` | Source-line counts |
| `python scripts/plot.py` | Fig. 14 → `results/fig14.png` (needs matplotlib) |

| Area | Tests |
|---|---|
| Health and routing | 2 |
| Rule classifier | 1 |
| Gemini handling | 7 |
| Validation and refusal | 2 |
| Workflow and ordering | 6 |
| Configuration and safety | 4 |
| Cloudflare route | 7 |
| **Total** | **29** |

Tests use the real HTTP interface (supertest against the app factory), the mock provider and a stubbed `fetch` for Gemini and Cloudflare. They finish in a few seconds.

## Status

| Component | Status |
|---|---|
| Backend API, middleware, validation, rate limit | Implemented, tested |
| Workflow (lock, preconditions, skip finished steps, honest failure) | Implemented, tested |
| Rule-based classifier | Implemented, tested (12/12) |
| Gemini interpretation (retry, schema, redaction) | Implemented, stub-tested; live run needs a key |
| Mock provider (end-to-end simulated run) | Implemented, tested |
| AWS provider: pre-flight, launch, rollback, SSH configure, deploy, status, restart, terminate | Written, live run pending |
| Cloudflare Pages route | Stub-tested (Wrangler and `fetch` stubbed); live run pending |
| React dashboard (incl. voice input) | Implemented; voice depends on browser support; no automated UI tests |
| Sample app + Dockerfile | Implemented; container build not run in CI |
| Colab notebook | Run on a Colab runtime: 29/29 tests, Tables IV/V/VIII, Fig. 14, simulated end-to-end run; real-AWS cells disabled by default |
| Live Gemini (Table V) | Measured on Colab with `gemini-flash-lite-latest`: all 3 commands → FULL_DEPLOY via Gemini (0.95 / 0.90 / 0.95); 37–70 s per request that day (rate-limited key) |
| Public demo (Render) | Deployed from `render.yaml` at https://deploy-by-command-demo.onrender.com (simulated, token-protected; `/health` verified) |
| Real-AWS timings (launch / deploy duration) | Not measured |

---

Re-implementation of the architecture described in *Deploy by Command* (Gullapalli & Ruthvika, VIT Vellore).
