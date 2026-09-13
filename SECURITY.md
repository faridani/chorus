# Security Policy

## Reporting a vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

Report privately via GitHub's **"Report a vulnerability"** button under the
repository's **Security** tab (Security Advisories → Private vulnerability
reporting). If that is unavailable, open a minimal issue asking a maintainer
to contact you privately — do not include details in the issue.

Please include:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected version / commit
- Any suggested remediation

We aim to acknowledge reports within 5 business days and to provide a
remediation timeline after triage. Please give us a reasonable window to
release a fix before any public disclosure.

## Supported versions

Chorus is pre-1.0 and under active development. Security fixes are applied to
the `main` branch. Pin to a commit you have reviewed for production use.

## Security model & operator responsibilities

Chorus orchestrates autonomous coding agents and exposes a local control
plane. Operators should understand the following before deploying it:

- **Network binding.** The daemon/dashboard binds to `0.0.0.0:7878` by
  default, which is reachable from your LAN/overlay network. For anything
  beyond a trusted single host, set `CHORUS_HOST=127.0.0.1` and put it behind
  an authenticated reverse proxy or a private overlay (e.g. Tailscale).
- **No built-in authentication.** The HTTP/WebSocket API is not
  authentication-protected on its own. Do not expose it directly to the
  public internet.
- **Session tokens.** Internal agent sessions are addressed by bearer-style
  tokens in the URL path. Treat daemon logs and request logs as sensitive.
- **Autonomous git/GitHub actions.** Agents create branches and open pull
  requests using your configured `gh`/git credentials. `main` is never pushed
  to autonomously, but review the guardrails before granting credentials.
- **Secrets.** Provide credentials via environment variables / `.env`
  (gitignored). Never commit secrets; agents are instructed not to surface
  secrets in logs or comments, but you remain responsible for scoping the
  credentials you supply.

## Scope

Issues in third-party dependencies should be reported upstream, though we
welcome a heads-up so we can bump the affected dependency.
