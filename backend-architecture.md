# Backend architecture & rationale

Companion to `CLAUDE.md` and the README's "Backend (Go)" section. This is
the deeper "why" — read this when you need to understand a design
decision, not just what the code does.

## Context: why these three services, in this order of value

The frontend prototype (`src/`) was built frontend-first and UX-led, which
was the right call for a semester project graded on usability evaluation,
not infra. But three things in the original design don't hold up past a
classroom demo:

1. `avgMin` on a `Session` doc is a number a TA typed in once at session
   creation. It has no relationship to how long tickets actually take to
   resolve, and never updates.
2. Every open student tab was its own Firestore `onSnapshot` listener
   (`firebase.ts` re-exports `onSnapshot` directly for components to
   call). Firestore bills per listener-read-stream, so queue size
   directly multiplies cost, and there's nowhere server-side to hang
   presence or push logic.
3. `ticket-clustering.ts` downloads MiniLM (~14MB quantized) and runs
   DBSCAN **in each student's browser**. Beyond the download cost on
   mobile, each client's DBSCAN run is independent — there's no guarantee
   two TAs (or a TA and a student) looking at the "same" queue see the
   same clusters, since floating-point embedding order and per-client
   model state can diverge.

None of these are wrong for a prototype. They're the first three things
that become wrong once real usage shows up.

## Current status: two of three actually wired in

Worth stating plainly, since it's easy to overstate from the code alone:

- **`internal/hub`** (realtime WebSocket relay) and **`internal/waittime`**
  (real ETA + resolution-duration recording) are both wired into the
  running frontend (`src/realtimeHub.ts`, `src/waittimeApi.ts`) and
  verified end-to-end against a live Firebase project — a ticket written
  directly to Firestore showed up live in a connected browser with no
  fallback warning, and a ticket resolved through the actual UI produced a
  `204` on `/resolve` followed by a `source: "topic"` ETA reflecting the
  real measured duration.
- **`internal/cluster`** (server-side embeddings + DBSCAN) is written and
  compiles, but the frontend hasn't been switched over — `src/
  ticket-clustering.ts` / `useTicketClusters.ts` still run MiniLM + DBSCAN
  in-browser today. Nothing calls `/api/sessions/{id}/recluster`. This is
  a designed-and-implemented-but-unplugged foundation, not a shipped
  migration, and it has no verification (automated or manual) beyond
  `go build` and the cache-hit path covered by the emulator tests
  described below.

## `internal/ticket`: why it's a separate, dependency-free package

The trickiest logic in the whole clustering pipeline isn't DBSCAN itself —
it's pin resolution. A TA can manually pin ticket A to ticket B's cluster,
and B can itself be pinned to C, and any node in that chain can point to
`"__noise__"`, and any of that can form a cycle if someone pins carelessly.
Getting this wrong is exactly the kind of bug that only shows up after a TA
has been using pins for twenty minutes, not on first glance at the code —
so it's the one piece that most needs a real, fast, emulator-free test
suite.

By keeping `internal/ticket` free of `cloud.google.com/go/firestore` and
network calls entirely (it operates on a plain Go struct, not a Firestore
document), `go test ./internal/ticket/...` runs in milliseconds with no
setup — currently at 94.9% statement coverage. `internal/cluster` then does
the Firestore-shaped work (querying, batching writes) and calls into
`internal/ticket` for the actual decisions.

This mirrors `ticket-clustering.ts` deliberately closely — same sentinel
value (`NoisePin = "__noise__"`), same "cycle resolves to unpinned" rule,
same "pin-to-noise mints a new manual cluster" behavior — so a TA's
pinning workflow doesn't change depending on whether clustering happens to
run client-side or server-side.

## Embedding cache design (`internal/cluster`)

The original `cluster.go` cached on `ticket.Embedding != nil`, which can't
distinguish "this ticket was embedded and its content hasn't changed
since" from "this ticket has never been embedded." Any ticket that got
embedded once would never be re-embedded again, even after a student
edited their ticket summary.

Fix: store the exact text that produced the embedding
(`EmbeddedContent`) alongside the vector, same idea as
`useTicketClusters.ts`'s `contentHash` on the frontend. Re-embed only when
`ToText(ticket) != ticket.EmbeddedContent`. This is written back to
Firestore on every recluster so the cache survives across function
invocations / server restarts, not just within one run.

## Gemini embeddings: correct endpoint shape

The original code called `https://gemini.googleapis.com/v1/embeddings`
with `textembedding-gecko@001` (a Vertex AI model name) and `Authorization:
Bearer <key>`. Neither the host nor the auth style exists for the public
Generative Language API. Correct shape:

```
POST https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=<GENAI_API_KEY>
Content-Type: application/json

{"content": {"parts": [{"text": "<ticket text>"}]}}
```

Response: `{"embedding": {"values": [0.01, -0.02, ...]}}`. Auth is the
`?key=` query param, not a bearer token — same key already used by
`@google/genai` on the frontend (`GEMINI_API_KEY` in `vite.config.ts`), so
no new credential type to manage.

## DBSCAN correctness (`internal/ticket.RunDBSCAN`)

The original `expandCluster` had two stacked bugs:

1. It referenced a `visited` slice that was local to `run()` and never
   passed into `expandCluster` — doesn't compile as written.
2. Even patched for scope, it indexed `visited[clusterIDs[pn]]` — i.e.,
   using a *cluster ID* (which is `-1` for noise, so a negative index) as
   an index into a *per-point* visited array. This is a classic
   copy-paste artifact from code that used to index by point and got
   refactored sloppily. It would panic on the first noise point
   encountered during expansion.

Rewritten as standard DBSCAN with `visited` and `labels` both indexed
strictly by point index (`0..n`), expansion done via a growable seed-list
(`seeds = append(seeds, ...)`, iterated with a manually-incrementing index
so newly discovered border points get their own neighborhoods checked).
This is the textbook formulation — no cleverness, which is the point after
finding a bug caused by *too much* cleverness.

## Firestore Go client gotchas worth remembering

The Go Firestore client's API shape doesn't match the Node.js SDK's, and
the original code was written as if it did:

- **No `DocumentSnapshot.Exists()`.** In Node, `doc.exists` is a boolean
  you check after every read. In Go, `docRef.Get(ctx)` returns a
  `NotFound` error directly — existence is `err == nil`, not a method
  call on the result.
- **`QuerySnapshot.Documents` is a `*firestore.DocumentIterator`, not a
  slice.** `hub.go` passed it straight into a function expecting
  `[]*firestore.DocumentSnapshot`. Needs `.GetAll()` first:
  ```go
  docs, err := snap.Documents.GetAll()
  ```
- **`status.Code(err)` from `google.golang.org/grpc/status`** is how you
  check *which* error you got (e.g. `codes.NotFound`) — this whole import
  was simply missing from `waittime.go`, alongside `strings` for the
  topic-name normalization helper.
- **`firestore.NewClient` always targets the `"(default)"` database.**
  This project's actual Firestore database is a *named* database
  (`firestoreDatabaseId` in `firebase-applet-config.json` on the
  frontend, matching `getFirestore(app, firebaseConfig.firestoreDatabaseId)`
  in `src/firebase.ts`). Calling `NewClient` against a project with a
  named database fails with a live `NotFound: The database (default) does
  not exist` error — found by actually running the server against a real
  project, not by reading the code. Fixed with
  `firestore.NewClientWithDatabase(ctx, projectID, databaseID)`, which
  required bumping `cloud.google.com/go/firestore` from v1.12.0 to v1.24.0
  (`NewClientWithDatabase` doesn't exist in the older version). `main.go`
  reads the database ID from `FIRESTORE_DATABASE_ID`, defaulting to
  `"(default)"` for projects that do use it.

If something in `internal/waittime` or `internal/cluster` doesn't compile
or connect after `go mod tidy`, it's most likely one of these four
patterns recurring — check there first before assuming a version
mismatch.

## `hub.go`: the two bugs that made it non-functional, not just non-compiling

- **Shadowing:** `HandleWebSocket(w http.ResponseWriter, r *http.Request)`
  followed later by `r := h.joinRoom(sessionID)` redeclares `r` as a
  `*room` in the same scope as the `*http.Request` parameter — compile
  error, not a runtime bug. Renamed the local to `room` throughout.
- **Broadcast fan-out:** the room read `<-r.broadcast` **inside the
  per-client loop**, so it drained one message per client instead of one
  message total. With 1 client this looked fine in a quick test; with 3+
  clients, clients 2 and 3 blocked forever waiting on a channel nothing
  more was ever pushed to for them. Fixed by reading the payload once per
  Firestore snapshot event and writing that same payload to every
  currently-connected client directly, with no intermediate channel that
  implicitly assumed one reader per message. Covered by a regression test
  — see Testing below.

## CORS: needed the moment the frontend actually called an HTTP endpoint

The WebSocket hub never needed CORS handling (browsers don't apply CORS
preflight to the WS upgrade handshake the same way, and gorilla's
`CheckOrigin` was already permissive). But the moment `src/waittimeApi.ts`
started calling `GET /api/sessions/{id}/eta` as a plain `fetch`, every
request was silently blocked by the browser with no
`Access-Control-Allow-Origin` header — caught by the client's fallback
logic (no crash, just silently reverted to the avgMin-based estimate), but
the endpoint was completely unusable until `github.com/go-chi/cors` was
added to `main.go`. Worth remembering: **HTTP and WebSocket endpoints on
the same router don't share a CORS story** — each needs its own check.

## Testing: pure logic vs. Firestore-shaped code

Two genuinely different tiers, and they're tested two different ways:

- **`internal/ticket`** is pure logic with no I/O, so `go test
  ./internal/ticket/...` runs in milliseconds with zero setup — 94.9%
  statement coverage, no emulator, no credentials.
- **`internal/waittime`, `internal/hub`, `internal/cluster`** all touch
  Firestore (and `cluster` also touches the Gemini API), so they need a
  real Firestore to test against. `docker-compose.yml` at the repo root
  runs a local Firestore emulator
  (`gcr.io/google.com/cloudsdktool/cloud-sdk:emulators`); `server/internal/
  testutil` provides a `FirestoreClient(t)` helper that connects to it via
  the standard `FIRESTORE_EMULATOR_HOST` env var (which the Firestore Go
  client detects automatically — no code changes needed to point at the
  emulator vs. production) and skips the test cleanly if the emulator
  isn't running, so `go test ./...` never hard-fails for someone who
  hasn't started it.

  ```bash
  docker compose up -d firestore-emulator
  FIRESTORE_EMULATOR_HOST=localhost:8081 go test ./...
  ```

  What's covered this way: `waittime`'s `EstimateETA`/`RecordResolution`
  EWMA math and topic normalization, `hub`'s WebSocket fan-out (including
  a regression test for the broadcast bug above, run with 3 concurrent
  clients), and `cluster`'s full query → DBSCAN → write-back path using
  tickets seeded with pre-cached embeddings (so it doesn't need a real
  Gemini key). `cluster`'s actual `fetchGeminiEmbedding` call path has one
  additional test that's skipped unless `GENAI_API_KEY` is set, since it
  makes a real, billed API call.

  All nine passed on first run against a real emulator (Apple Silicon,
  under `linux/amd64` emulation since that's the only platform the
  emulator image ships), including `TestHub_FansOutToMultipleClients` —
  the regression test for the historic broadcast bug, run with 3
  concurrent clients.

## Open questions / not yet decided

- `intOrDefault` (query-param parsing in `internal/waittime/http.go`)
  currently accepts negative numbers for `queueLength`/`concurrentTAs` and
  relies on `EstimateETA`'s internal clamping (`if concurrentTAs <= 0 {
  concurrentTAs = 1 }`). Worth deciding whether the HTTP layer should
  reject negative input outright (400) instead of silently clamping —
  clamping is friendlier to a slightly buggy client, rejecting is more
  honest about bad input. Leaning toward reject, haven't committed.
- No decision yet on how `internal/hub` should expose presence (remote vs.
  in-person) — the room struct doesn't currently track *why* a client
  connected, just that it did.
- Firebase ID token verification middleware is referenced as a "quick win"
  but not designed yet — need to decide whether it lives in `main.go` as a
  wrapping `http.Handler` or per-service. The CORS config added above is
  currently wide open (`AllowedOrigins: []string{"*"}`) specifically to
  match this no-auth posture — tighten both together, not one without the
  other.
- `internal/cluster` is not yet called from the frontend at all (see
  "Current status" above) — deciding when/whether to finish that
  migration is a product call, not just an engineering one, since it also
  means every recluster costs a real Gemini API call per changed ticket.
