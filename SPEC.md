# Chorus — Capabilities Spec

> Chorus is a self-hosted, 24/7 AI engineering team: a single orchestrator
> coordinates role-based agents driven by subscription CLI tools, manages git
> branches, tracks cost, and merges work for human review before it reaches
> `main`.

## Platform & deployment

- Run natively on Linux, macOS, and Windows via WSL.
- Be self-hostable on a single machine designed to run 24/7.
- Be reachable remotely over Tailscale (or similar overlay/VPN/tunnel tools) rather than requiring public exposure.
- Run as a long-lived background service/daemon that survives restarts and resumes work.

## Architecture (hub-and-spoke)

- Use a single orchestrator (the hub) that coordinates all agents (the spokes).
- Orchestrator owns task assignment, work review, branch merging, and human notifications.
- Agents are stateless workers that receive a role, context, and guardrails, then execute.
- Agents build upon each other's work rather than operating in isolation.

## Agent roles & permissions

- Let the user define agent roles (e.g., product designer, QA, project controller, software dev, user impersonator).
- Define each role's allowed and forbidden actions (capabilities + guardrails) per role.
- Configure roles either via the web UI (visually) or via CLI/config files.
- Every agent is made aware of: what the overall project is building, its own role, and the global + role-specific guardrails.

## AI backend (subscription, not API)

- Drive agents through subscription-based CLI tools in non-interactive mode (start with Codex; design for Claude and Gemini terminals later).
- Abstract the AI backend behind a common interface so new CLIs can be plugged in.
- Maximize use of available subscription tokens/quota: keep agents working as long as quota remains.
- Detect quota/token exhaustion and pause/wait gracefully, then auto-resume when quota refreshes.

## Cost & usage monitoring

- Track token/quota usage across all agents.
- Estimate and display cost (or quota consumption) on the dashboard in real time.
- Surface remaining quota and projected time-until-exhaustion.

## Version control (git)

- Use local git for all version control.
- Allow each agent to work on its own branch when appropriate.
- Have the orchestrator merge completed agent work into a shared integration branch (never directly to `main`).
- Detect when an agent's work is "done" and trigger the merge into the integration branch.
- Let agents continuously build on the evolving integration branch.

## Human-in-the-loop review & merge

- Let the human test the integration branch before anything reaches `main`.
- Require explicit human approval to merge the integration branch into `main`.
- Keep `main` protected from autonomous merges.

## Issue / ticket tracking

- Use a free/open-source ticketing system, or ship a built-in one.
- Let the user define and assign tickets to roles.
- Have the orchestrator turn tickets into agent tasks and track their status.

## Notifications & changelog

- On each merge into the integration branch, notify the human (iMessage and/or email) with a summary of the changes.
- Maintain a running changelog that records what changed, by which agent, and when.
- Make the changelog visible in the dashboard and persisted to the repo.

## Web UI / dashboard

- Provide a web-based control panel, accessible remotely.
- Show: live agent status, current tasks, cost/quota, branch state, recent merges, and the changelog.
- Allow starting/stopping/pausing agents and the orchestrator from the UI.
- Allow creating/editing roles, guardrails, and tickets from the UI.
