# Ease Disease Backend — CLAUDE.md

Companion docs: `api-flow.md` (locked v1 API contract), `backend-plan.md` (System Plan v3).

## Repo shape

- **Two separate repos**, not a monorepo: this repo (`ease-disease-backend`) and `ease-disease-angular` (frontend) are independent.
- This backend repo is a **single monolithic service** (NestJS) — not split into microservices. Login, payments, bookings, and admin concerns all live here for now.

## Workflow conventions
- Large features are built slice by slice from a plan doc in the repo. After each slice: build or test green, update the plan doc, then commit.
- When I ask for a plan, write docs only. Make no code changes unless I explicitly ask.
- Verify assumptions about existing behavior in the code, not from comments. Examples: whether a function mutates substage_id, or what settlementModeId means.
- End long sessions with a handoff doc and a kickoff prompt for the next session, saved under claude-code/.
- These are real production products (CafePOS for real cafes, the payee portal, the booking platform). Treat security and correctness seriously.
