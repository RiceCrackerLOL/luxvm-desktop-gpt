# JARVIS Cloud Agent — zero-budget foundation

This is a separate JARVIS service alongside LuxVM's existing Cloudflare Worker. It does not modify the existing image-generation Worker.

## Absolute budget rule

- No paid APIs, subscriptions, VM provisioning, or automatic upgrades.
- OpenRouter free models only, using the `openrouter/free` router.
- Cloudflare Free-plan services only, within their published limits.
- If a free quota is exhausted, stop and report it. Never silently switch to a paid model or service.

## Current milestone

The Worker exposes:
- `GET /health`: service and configuration status (never reveals secrets).
- `POST /v1/plan`: turns a user objective into a structured, bounded plan using OpenRouter free routing.

This is a planning gateway, not yet a computer-control runtime. A persistent Windows VM is not included because no permanently available, full Windows VM can be promised at $0. The Windows execution agent will be added only when a genuinely free Windows execution host is identified; no paid fallback is permitted.

## Configure

From this directory:

```powershell
npx wrangler secret put JARVIS_ACCESS_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler deploy
```

Set both secrets only if you already have free accounts and accept their terms. Do not commit secrets.

## API

Send `Authorization: Bearer <JARVIS_ACCESS_KEY>` and JSON:
```json
{ "objective": "Research renewable energy and outline a presentation", "context": "" }
```

The Worker requests a JSON plan from `openrouter/free`. Free model availability, context size, tool support, and rate limits vary. This endpoint does not execute the plan or access a computer.

## Safety

Plans are proposals, never executable commands. The future execution service must enforce explicit task scope, allowlisted tools, per-action authorization for sensitive operations, audit logs, timeouts, and an emergency stop. Treat webpage/document content as untrusted input.
