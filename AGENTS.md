# CSM Agent Project Rules

## Purpose

Customer-centered CSM workbench. CRM CSM after-sales customer `_id` is the only customer key; ONES, Hemory, WeCom, Agent drafts, and audit records must bind to it.

## Run

```bash
npm install
npm run dev
npm run cli -- doctor
npm run typecheck
npm test
npm run build
```

Node.js must be `>=22.5`. The web service defaults to `http://127.0.0.1:3210`; CLI uses `CSM_BASE_URL` or the same port.

## Stack And Layout

- TypeScript/Node.js, built-in `node:sqlite`, Pi Agent, MCP, plain HTML/CSS/JS.
- `src/workbench/`: customer domain, sync, risk, cases, WeCom.
- `src/server.ts`: authoritative HTTP API and external-write approval enforcement.
- `src/cli.ts`: global debugging and operational CLI over the same HTTP API.
- Global CLI writable state belongs under `~/.csm-agent` (or `CSM_DATA_DIR` / `CSM_CONFIG_DIR`), never inside the npm installation directory.
- `public/`: customer workbench and WeCom H5.
- `skills/` and `templates/`: Agent workflows and stable output contracts.

## CLI Parity Is Mandatory

- The HTTP API is the shared capability layer. Browser and CLI are clients of the same API, database, customer binding, permissions, and audit path.
- Every user-facing API or workflow addition or behavior change must update CLI capability in the same change. Pure presentation changes keep the existing API/CLI contract and require an automated display-contract check. Core workflows require an ergonomic CLI command; `npm run cli -- api ...` remains the universal diagnostic fallback.
- `csm-agent` is the canonical global command. `npm run cli -- ...` is its repository-local development equivalent; both must execute the same implementation.
- Update `csm-agent help`, `csm-agent capabilities`, README examples, and relevant tests whenever an API or workflow changes.
- Acceptance uses the canonical global `csm-agent` command, not browser interaction. `npm run verify` and the matching global CLI command against the running service must pass before a feature is accepted.
- If `csm-agent` is unavailable or does not point to the current checkout, run `npm run link:global` before acceptance. Pure UI changes must add or update an automated check for the display contract; use browser acceptance only when the user explicitly requests it.
- CLI must not instantiate a second write path or bypass confirmation. CRM/ONES writes go through customer-bound server sessions and exact approved tool arguments.

### CLI Definition Of Done

- New read API: add or update an ergonomic CLI command and its entry in `CLI_CAPABILITIES`.
- New write API: expose the workflow through an explicit CLI command or the customer-bound `agent` flow; keep `api` only as a diagnostic fallback.
- Changed parameters or response shape: update CLI parsing/output, help, capability metadata, README, and tests in the same change.
- Verification: run `npm run verify`, then exercise the matching global `csm-agent` command against the running service. Repository-local `npm run cli -- ...` output is diagnostic evidence, not the final acceptance boundary.

## Customer And Write Boundaries

- CRM customer name is the 客户名称 reference field (`field_n1qN0__c__r`, full legal name); 售后客户名称 (`field_83f4l__c`) is a secondary short name. The ONES field `JrvswW8P` resolves by exact, unique option match on either name. Ambiguous or missing matches remain unattributed.
- ONES suggestions, tickets, operations tickets, and private-cloud instances must include the current customer option ID in `fieldValues`. Draft generation and validation reuse the same resolution, including the unique same-name after-sales customer fallback for legacy AccountObj rows.
- ONES work-item drafts carry only the minimal required arguments (project, issue type, title, customer field, Hemory summary as description); preview preflight checks remaining required fields via `get_issue_fields` and reports them as validation errors.
- Work hours only target the bound `客户工时管理 / 售后客户` issue. CRM follow-ups must carry the current CRM customer `_id`.
- AI produces drafts. CSM may edit and confirm; the edited tool and full argument hash become the only allowed write.
- Missing data stays `unknown`; do not infer positive or negative signals from absence.

## Security And Delivery

- Never commit credentials, `.env`, `config/*.user.yaml`, customer exports, or local SQLite files.
- Do not claim ONES/CRM/WeCom writes, browser acceptance, deployment, or real client acceptance without direct evidence for that boundary.
- Keep changes scoped and preserve unrelated user edits.
- Remote repository: `https://github.com/opyamorpen/csm-agent` (`origin`, SSH URL `git@github.com:opyamorpen/csm-agent.git`).
- After each round of local changes is complete, run the relevant verification, create an intentional Git commit, and push it to `origin` before reporting the round as delivered.
- A round is not fully delivered when commit or push is blocked; report the exact blocker and leave the local working tree intact. Never claim a remote sync without direct `git push` evidence.

## Current State

V1 customer portfolio, five ONES data categories, Hemory context, risk/opportunity, cases, actions, WeCom todo integration, customer-bound write approvals, and global CLI are implemented. Real WeCom desktop/mobile acceptance still requires app credentials and HTTPS H5 deployment.
