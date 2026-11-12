# Order → Shipment integration service

A small Node.js service that receives `orders/create` webhooks and creates exactly one
courier shipment per order, even though the store re-delivers webhooks and the courier
rate-limits, returns 5xx errors, and sometimes times out **after** creating the shipment.

**No dependencies.** It uses only Node built-ins (`node:http`, `node:crypto`, `node:sqlite`, `node:test`).

> **Branch `post-review-fixes`:** fixes for two bugs found in review. `main` is unchanged, exactly as submitted.
> 1. **Reconcile requeued dead orders every 60s with a fresh attempt budget.** An order the courier always
>    rejects (e.g. 400) was re-POSTed about 1,440 times a day and never stayed parked. Reconcile now only *adopts*
>    for dead orders and otherwise leaves them for a manual `npm run replay`. A test simulates a day of
>    reconcile runs: 1,440 POSTs before the fix, 1 after.
> 2. **A slow-committing courier could get a duplicate.** If the courier commits after our 3s timeout, a retry
>    250–500ms later GETs before the first POST is visible and POSTs again. After a timeout the retry now waits
>    at least `AMBIGUOUS_SETTLE_MS` (default 30s). The wait is stored in `next_attempt_at`, so it holds across
>    worker processes. The mock courier gained `commitDelayMs`: one test reproduces the duplicate without the
>    settle window, and one shows it fixed.

## Run it

Requires Node **22.13+** (built-in SQLite). Tested on Node 24.

```bash
npm start
```
That starts the mock courier on `:4000` and the service (HTTP + worker + scheduled reconcile) on `:3000`.
No `npm install` is needed.

In another terminal, send a signed webhook. The script then sends the same delivery again,
the same order under a new webhook id, and one request with a bad signature:
```bash
npm run send -- 1001
```
```
1. first delivery            -> 200 {"ok":true,"orderId":"1001","duplicate":false}
2. same webhook again        -> 200 {"ok":true,"orderId":"1001","duplicate":"webhook"}
3. same order, new webhook   -> 200 {"ok":true,"orderId":"1001","duplicate":"order"}
4. bad signature             -> 401 {"error":"invalid signature"}
```
The script also prints the equivalent `curl` command.

Check results:
```bash
npm run status                              # orders by status + anything not shipped
curl localhost:4000/__control/stats          # shipments per reference at the courier; "duplicates" must be []
curl localhost:3000/orders/1001
```

Operations:
```bash
npm run reconcile                 # one reconciliation pass (also runs every 60s inside the service)
npm run replay -- 1001            # replay a dead order
npm run replay -- --all-dead
npm test                          # 24 tests, about 7s
```

Configuration lives in `.env` (see `.env.example`). The defaults work without any changes.
`WEBHOOK_SECRET` must match between the service and `npm run send`, and both read the same `.env`.

## How it works

```
store ──POST /webhooks/orders-create──► verify HMAC (raw body) ──► SQLite tx: insert delivery + order
                                                                    (unique webhook_id, PK order_id)
                                         ◄── 200 in ms (no network I/O)
worker loop ──claim (atomic UPDATE…RETURNING + lease)──► GET /shipments?reference=orderId
                                                          ├─ found → adopt it, mark shipped
                                                          └─ none  → POST /shipments → mark shipped
            on failure: 429 → wait Retry-After · 5xx → exp. backoff + jitter
                        timeout → wait ≥ AMBIGUOUS_SETTLE_MS (courier may still be committing)
                        non-retryable 4xx or attempts ≥ MAX → status=dead (visible, replayable)
reconcile ──for orders not shipped (dead / overdue / expired lease)──► GET by reference
                                                          ├─ found → adopt
                                                          ├─ none, overdue pending → make due now (worker path)
                                                          └─ none, dead → leave parked (manual replay)
```

Order states: `pending → processing → shipped`. On a retryable failure the order goes from
`processing` back to `pending`. When it runs out of attempts it goes from `processing` to `dead`,
and only a manual replay moves it from `dead` back to `pending`. Reconcile can mark a dead order
`shipped` if the courier turns out to have it.

## Design decisions and why

**1. Check the courier before every create.** The courier isn't idempotent, and a timeout
doesn't tell us whether the shipment was created. So the worker always calls
`GET /shipments?reference=<orderId>` before `POST`, and adopts a shipment if one already exists.
This one rule covers three failures: the courier creating then timing out, the process crashing
between `POST` and saving the result, and a stale lease being reclaimed. It costs one extra GET
per attempt, which is cheap insurance. A test proves this: if the GET is removed, 3 tests fail.

**2. Two idempotency layers at ingest.** A delivery is deduped on `X-Shop-Webhook-Id`
(`webhook_deliveries` PK), and the order is deduped on order id (`orders` PK). Both happen in one
`BEGIN IMMEDIATE` transaction, so concurrent duplicate deliveries can't race. A duplicate gets a
**200**, not a 4xx, so the store stops retrying.

**3. HMAC on the raw bytes.** The body is read as a Buffer and verified before it is parsed.
Re-serialised JSON can differ in key order, whitespace or unicode escaping, which would change the digest.
The comparison uses `crypto.timingSafeEqual`, with a length check first because it throws on mismatched lengths.

**4. Queue = the `orders` table (DB-backed queue).**

| Option | Pros | Cons |
|---|---|---|
| In-process (array) | Simplest | Jobs lost on restart. No visibility. |
| **DB-backed (chosen)** | Durable. The job *is* the order row, so its state, attempts and last error can be queried with SQL. Replay is an `UPDATE`. Nothing extra to run. | Polling. A single SQLite writer limits throughput. |
| BullMQ/Redis | Built-in retries and delays, scales out, dashboards | An extra service to run, plus job state split between Redis and the DB, so they can disagree. |

At this scale, durability and visibility matter more than throughput. Claiming is a single
atomic `UPDATE … WHERE order_id = (SELECT … LIMIT 1) RETURNING *` with a lease (`locked_until`).
If a worker dies, its lease expires and another worker picks the job up, which is safe because of
decision 1. `npm run worker` can run as a separate process against the same DB (WAL mode).

**5. Retry policy.** For a `429`, the worker waits exactly `Retry-After` (seconds or an HTTP date).
For `5xx` and network errors it uses exponential backoff with equal jitter, so the wait is
never zero and never synchronised across jobs. It is capped at `BACKOFF_MAX_MS`. A **timeout** is
ambiguous (the courier may still commit the POST), so its retry waits at least `AMBIGUOUS_SETTLE_MS`
(default 30s). This must be longer than the courier's worst-case commit latency, otherwise the next
GET can run too early, find nothing, and POST a duplicate. Any other `4xx`
can't be fixed by retrying, so the job goes straight to `dead`. After `MAX_ATTEMPTS` (default 6)
the job is parked as `dead` with `last_error` saved.

**6. Reconcile never creates, and never revives dead orders.** It only looks up the shipment. If the
courier has it, reconcile adopts it. If not, an overdue `pending` order is made due now, but a `dead` order stays
parked: dead means a human should look (a 400, or retries exhausted), and auto-requeueing would re-POST
it forever. That leaves one code path that can `POST`, and reconcile skips orders a live worker is holding.
Running it twice is a no-op, and a test checks this.

**7. Timeouts vs. leases.** The courier timeout is 3s and the lease is 30s. The lease must
be longer than a full attempt (GET + POST) so a slow job isn't stolen while it's still running.

## Tests (`npm test`)

| Area | What it proves |
|---|---|
| HMAC | Correct / wrong / missing / wrong-length signatures. The digest is computed over the raw body, not re-serialised JSON. |
| Ingest | The same webhook twice, the same order under a new id, and 10 concurrent duplicates each produce one order. A bad signature returns 401 and stores nothing. Bad JSON returns 400. The handler responds in under 1s. |
| Worker | Timeout after create: the retry adopts the shipment and no duplicate is made. A 429 schedules the retry at Retry-After. 5xx errors back off and then succeed. Max attempts leads to dead. A crashed worker's lease is reclaimed without a double create. A slow-committing courier: a retry inside the commit window duplicates, and the settle window prevents it. |
| Chaos | 40 orders, 4 concurrent workers, the courier's real random failure rates: every shipment exists exactly once. |
| Reconcile | Adopts a shipment the courier created. Leaves a dead order parked when the courier has none; a manual replay then ships it once. Over a simulated day, an order the courier always 400s is POSTed once. Is idempotent. Leaves held orders alone. Survives the courier being down. |

I also ran it end to end. 8 orders were each sent 3 times against the live mock courier with
10s hangs. Result: 8 shipments, 0 duplicates, and one order went through the timeout-then-adopt path.

## Changes to `mock-courier.js`
The behaviour required by the brief is unchanged. I added:
- configurable failure rates and hang time
- `POST /__control/script` to force the next outcomes (deterministic tests)
- `GET /__control/stats` (shipments per reference + `duplicates`)
- `POST /__control/reset`
- `400` when `reference` is missing
- `commitDelayMs` (`MOCK_COMMIT_DELAY_MS`): a shipment becomes visible to GET, and the POST answers, only after
  this delay, to model a courier that commits asynchronously

## What I deliberately left out
- **A GET-then-POST race between two *different* systems.** If something other than this service
  also creates shipments for the same reference, a gap between our GET and our POST could still
  produce a duplicate. Within this service the order lease prevents it. The real fix is an
  idempotency key on the courier side.
- **Docker / docker-compose.** There's nothing to containerise: no DB server and no Redis.
  `npm start` is the one command.
- **Rate-limit budget sharing.** A 429 delays only that order. Other workers don't slow down globally.
- **A 429 doesn't spend extra attempt budget.** It counts as an attempt like any other failure.
  With the defaults this is fine. In production I'd count it separately.
- **Payload validation** beyond "has an id". Address and items are forwarded as received.
- **Auth on `/orders/:id` and `/health`**, metrics and structured logging.
- **Webhook timestamp / replay-window checks.** The brief's header format has no timestamp.

## With another day
- Postgres with `SELECT … FOR UPDATE SKIP LOCKED` for multi-node workers, plus a migration tool.
- A global rate limiter (token bucket) shared by workers, driven by `Retry-After`.
- Prometheus metrics (queue depth, age of the oldest pending order, dead count) and an alert on dead > 0.
- A small admin endpoint for replay instead of a CLI.
- Ask the courier for idempotency-key support. That removes the need for the GET-before-POST round trip.
- Structured JSON logs with order id / webhook id correlation.

## How I used AI
I used Claude Code as a pair programmer. I wrote the plan first ([docs/PLAN.md](docs/PLAN.md)), built around
one rule: always check the courier by reference before creating a shipment. Then I built it in the order
the commits show, with tests alongside each step. To confirm the tests guard the critical
behaviour, I deliberately removed the check-before-create step: 3 tests failed, so I restored it.
I also ran it end to end against the live mock courier and fixed a small bug the run exposed
(`replay --all-dead` printed usage instead of "nothing to replay").

## Layout
```
mock-courier.js         mock courier (from the brief, plus test controls)
src/index.js            server + worker + scheduled reconcile
src/app.js              HTTP: webhook route, /health, /orders/:id
src/hmac.js             signature verify
src/db.js               schema + all SQL (ingest, claim, retry, dead, adopt, requeue)
src/courier.js          courier client, error classification, Retry-After parsing
src/worker.js           claim → check courier → create; retry/backoff/dead-letter
src/reconcile.js        reconciliation logic
src/worker-main.js      run the worker as its own process
scripts/                dev runner, send-webhook, reconcile, replay, status
test/                   node:test suites
docs/PLAN.md            the plan written before coding
```
