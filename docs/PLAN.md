# Plan

## Problem
Turn each `orders/create` webhook into exactly one courier shipment, even though:
- the store may deliver the same webhook (or the same order) more than once,
- the courier rate-limits, 5xx's, and sometimes times out *after* creating the shipment,
- the courier itself is not idempotent (same reference twice = two shipments).

## Invariant everything is built around
> Before we ever `POST /shipments` for an order, we ask the courier
> `GET /shipments?reference=<orderId>`. If one exists, we adopt it instead of creating.

Our DB stores at most one row per order (primary key), and only one worker can hold an
order at a time (atomic claim). Together: duplicates at the edge are absorbed by the DB,
and "did my last POST land?" is answered by the courier itself.

## Components
| Piece | Choice | Why |
|---|---|---|
| HTTP | `node:http` | One route; no framework needed. Need raw body for HMAC anyway. |
| DB | SQLite via built-in `node:sqlite` | Zero install, file-backed, transactional. |
| Queue | DB-backed (the `orders` row *is* the job) | Durable across restarts, visible, replayable with SQL. No Redis to run. |
| Worker | Polling loop in the same process (also runnable alone) | Simple. Claim is a single atomic `UPDATE ... RETURNING`. |
| Tests | `node:test` | No deps. |

## Order state machine
```
pending --claim--> processing --ok--> shipped
   ^                   |
   |  retryable error  |  (5xx, timeout, 429, network)
   +-------------------+
                       |  attempts >= MAX or non-retryable 4xx
                       v
                     dead  --replay script--> pending
```
`processing` rows carry `locked_until`; if a worker crashes, the lease expires and the row is
claimable again (the GET-first rule makes that safe).

## Retry policy
- 429: wait `Retry-After` seconds (fallback to backoff).
- 5xx / timeout / network: exponential backoff `base * 2^(attempt-1)` with full jitter, capped.
- Other 4xx: not retryable → dead immediately.
- After `MAX_ATTEMPTS` → dead.

## Reconciliation
Finds orders without a confirmed shipment (pending past due, stale processing, dead).
For each: GET by reference → if found, mark shipped; else reset to pending so the normal
worker path (GET-first, then POST) handles it. Reconcile never POSTs itself.

## Build order (each is a commit)
1. Plan + scaffold
2. Mock courier + signed webhook sender
3. HMAC + webhook route + idempotent ingest (+ tests)
4. Courier client + worker with retries/backoff/dead-letter (+ tests)
5. Reconcile + replay scripts (+ tests)
6. One-command dev runner, end-to-end check, README
