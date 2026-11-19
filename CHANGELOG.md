# Changelog

## 0.3.0

Decoded-session cache is no longer capped at two entries, and the first-paint
snapshot drops the fields nothing renders.

The host memoises decoded sessions in `coldLogMemo` with a hard-coded capacity of
`COLD_LOG_MEMO_MAX_ENTRIES = 2`. Two slots are not enough when a user moves between
three or four long sessions: every hop evicts the one before it, so coming back
costs a full decode again. Measured on this profile:

- A 61.4 MB / B 57.8 MB / C 43.5 MB opened in order: 4374 / 3555 / 2687 ms
- A again: 7 ms (hit). B again: **3329 ms** — B had been evicted by C

`lib/memo-budget.js` replaces only the eviction policy: a byte budget with LRU
(default 1500 MB) instead of two entries. The cached values are still the host's
own frozen objects; eviction drops a reference, it never mutates anything, and the
`revision` comparison that guards reuse is untouched. A heap-pressure sweep after
each insert trims back to half the budget if `heapUsed` passes a high-water mark
(default 3000 MB).

Measured with five of the largest sessions, second pass in order:

| | A 61.4 MB | B 57.8 MB | C 43.5 MB | D 41.0 MB | E 28.8 MB |
|---|---|---|---|---|---|
| host (2 entries) | 7 ms | **3329 ms** | **2687 ms** | — | — |
| 1500 MB budget | 9 ms | 7 ms | 8 ms | 7 ms | 7 ms |

Hit rate goes from 2/5 to 5/5; `heapUsed` peaks at 1380 MB of a 4192 MB limit.
Residency is about 4.6 KB per event (61.4 MB / 78557 events grows the heap by 357 MB).

A CPU profile of four large opens (19219 ms sampled) shows what a hit avoids:

```
consumeEventLine  7726 ms  40.2%     decodeFrame   2957 ms  15.4%
GC                1464 ms   7.6%     freeze        1144 ms   6.0%
utf8Slice         1049 ms   5.5%     row checks     243 ms   1.3%
```

First-paint trimming now also drops `job/registered` and `job/settled` `label` —
the tool command text, which the `tool/call` of the same turn already carries
verbatim — and their `owner`, which is always the session's own id. Neither type has
any renderer in the client: of the 19 files that mention them, only the API
controller's known-type allowlist includes them. Across eight large sessions the
tail window goes from 2221 KB to 1105 KB (50.2%); `job.label` alone accounts for
75 KB of a 950 KB sample.

Collapsed tool details are deliberately left intact. `tool/call.arguments` and
`tool/result.content` are what the collapsed row itself renders — `deriveSummary()`
in the tool UI parses `argsRaw` and falls back to `firstLine(argsRaw)`. And because
this plugin discards the host's full opening to avoid a duplicate decode, the tail
window is the only copy the client ever gets: truncating those fields would leave
an expanded tool card permanently empty.

History paging no longer rewrites the returned page. The client's `native`
consumption branch performs no anchor compensation and relies on the browser's
`overflow-anchor`, which the same file sets to `none` while scroll motion is
active; the two together made upstream scrolling jump. `historyRewrite` defaults
to `false` and only the timing probes remain.

Also fixed: `memo-budget` located the host object by a static prototype walk, which
produced a `MEMOBUDGET-SKIP` after a hot reload. It now anchors on the prototype
that owns `open` (the path `profile.js` uses) and falls back through three more
strategies, logging the whole prototype chain when none match.