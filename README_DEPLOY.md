# Deploy: full-universe tick collector trial (InstaBox)

Fresh code, built for the trial Chot 13:46 28/10/2026. No Modal, no R2,
no Worker. The collector writes ONLY to the machine's local disk.
Nothing leaves the machine during the session.

## Files in this package

| File | What it is |
|---|---|
| `collector.py` | The collector (single file, stdlib + vendored websockets). |
| `websockets/` | Vendored websockets 17.3 (pure Python, no compiled parts), copied from the proven relay-2 trial build. |
| `universe_full.json` | Frozen full listing: 1,520 symbols (HOSE 407 / HNX 299 / UPCOM 814). |
| `universe_manifest.json` | Provenance: source, fetch time, count, sha256. |
| `test_smoke.py` | Stub-only smoke tests (63 cases, all passing on the build VM). |

## 1. Get the code onto the machine

The InstaBox dashboard has NO file-upload control. Preferred order:

1. **Git first.** If the package is pushed to a repo, clone it in the
   machine's terminal (SSH or the dashboard's built-in terminal):
   `git clone <repo-url> instabox-collector && cd instabox-collector`.
2. **curl fallback.** If the package is served as a zip/tarball from a
   URL the machine can reach:
   `curl -sS -O <url> && unzip <file>` (or `tar xzf`).
3. **Terminal-paste fallback (last resort).** Paste files one by one
   with heredocs in the built-in terminal, exactly like the probe run:
   `cat > collector.py << 'EOF' ... EOF`. Verify sizes afterwards
   (`wc -c`). The vendored `websockets/` tree is too big to paste by
   hand — if git/curl are both unavailable, install websockets 17.3
   from pip instead (`pip install 'websockets==17.3'`) and delete the
   `websockets/` directory; `collector.py` imports the installed
   package when the vendored copy is absent.

Verify on the machine before running:

```bash
cd instabox-collector
python3 --version        # expect 3.13.x
python3 -c "import sys; sys.path.insert(0,'.'); import collector; print('ok')"
python3 test_smoke.py    # expect 63/63 PASS; stub-only, no network
```

## 2. Inject SSI_PROXY_URL (SSH only, never the desktop keyboard)

The ONLY secret is `SSI_PROXY_URL`, read from the environment. Rules:

- Paste it ONCE, via an SSH/terminal heredoc that exports it and
  launches the collector in the SAME shell. Never type it on the
  desktop GUI keyboard (the VNC Shift bug lowercases typed text).
- NEVER write it to any file (no `.env`, no script, no log). If the
  process restarts, paste it again.
- The value is never printed: the collector logs only `proxy: set`
  or `proxy: unset`.
- Do NOT bake the proxy into a machine snapshot unless Henrry
  explicitly orders it after the snapshot-persistence test (open
  question at build time; the default is env-only, every run).

Launch (session window 08:50-15:05 ICT, weekdays; the date is derived
from the clock, never hardcoded):

```bash
cd instabox-collector
export SSI_PROXY_URL='<paste-once value>'
nohup python3 collector.py --out-dir session-out \
  > collector.log 2>&1 &
```

Pre-open connectivity check (5 minutes, any time of day):

```bash
export SSI_PROXY_URL='<paste-once value>'
python3 collector.py --out-dir check-out --minutes 5
```

## 3. Health checks during the session

Every 60 s the collector prints one health line to stdout:

```
[health] 10:02:11 msgs={'dnse': 1234, ...} conn={...} q=0 flush_ms=12.3 syms=812
```

- `conn` all `True` = all five gates connected.
- `q` staying near 0 = the aggregator keeps up.
- `flush_ms` = the 60 s disk-write cycle; watch it grow with load.
- Per-gate disconnects are logged as `[gate] loi: ...` and recorded
  with their gap windows in `gaps` inside `summary.json`.

Files written under `session-out/<YYYYMMDD>/`:

| File | Content |
|---|---|
| `session.db` | SQLite: gate buckets, merged candles, snapshots, negotiated accumulation, dedup state. |
| `raw_<gate>.jsonl` | Raw normalized ticks/snapshots per gate, append-only. |
| `foreign_merged.json` | Merged foreign flow (normalized gates only, with source flags). Rewritten every 60 s. |
| `checkpoint.json` | Last flush time, counters, gate state (resume metadata). |
| `load.jsonl` | One line per minute: CPU %, RSS MB, msgs/sec per gate, flush ms, symbols with ticks. |
| `summary.json` | Written at 15:05 stop: per-gate totals, gaps, crosscheck, dedup/validity counters. |

## 4. Retrieve the output after the session

The machine pauses after 30 minutes idle and has an 8-hour maximum
run. Retrieve the files BEFORE the machine is deleted or the run
expires. Retrieval path (SSH/SCP, dashboard file download, or the
InstaBox CLI — whichever the operator verifies first on the live
machine; it was never exercised during the build):

```bash
# example once SSH access is confirmed:
scp -r <machine>:instabox-collector/session-out/<YYYYMMDD> ./
```

Then, per the Chot'd post-session flow: raw JSONL files go to R2 as
files; the merged 1-minute candles go to D1 (see schema below). The
collector itself never uploads anything.

## 5. SQLite schema (D1-friendly `candles` table)

One row per symbol-minute, plain column names/types only. This is the
table the post-session D1 loader reads; loading it is a plain
`INSERT OR REPLACE` per row.

```sql
CREATE TABLE candles(
  symbol TEXT NOT NULL,
  minute TEXT NOT NULL,          -- ICT "YYYY-MM-DDTHH:MM"
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume INTEGER NOT NULL,       -- shares (CP)
  source TEXT NOT NULL,          -- winning gate for this minute
  session_date TEXT NOT NULL,    -- "YYYYMMDD"
  PRIMARY KEY (symbol, minute));
```

Column list: `symbol, minute, open, high, low, close, volume, source,
session_date`. Prices are thousand-VND floats, volumes are share
counts, values are VND — the same units as the live pipeline.

Other tables in `session.db` (audit/comparison only, not D1-loaded):
`gate_buckets` (per-gate buckets, same shape + `gate`, `first_ts`,
`last_ts`), `snapshots` (latest per-gate snapshot per symbol),
`put_foreign` (SSI negotiated accumulation), `dedup` (seen trade ids),
`meta` (session marker for resume).

## 6. Known gaps (stated, not guessed)

1. **VNDirect UPCOM floor code: UNDETERMINED.** The code read proves
   HOSE `10` and HNX `02` only. UPCOM symbols are NOT subscribed on
   VNDirect in this build; they are covered by the other four gates.
   The session summary records this. Do not guess a code; determine
   it from the banggia bundle before enabling UPCOM on VNDirect.
2. **SSI foreign definition: UNPROVEN.** SSI snapshots are stored
   per-gate and flagged `normalized: false`; they are never merged
   into the foreign total. KBS foreign is likewise excluded (matched
   only at 38/40; negotiated-add method unproven).
3. **Dedup keeps the last 64 trade ids per (gate, symbol)** per the
   Chot'd trial spec (the old collector kept 65,536; the smaller
   window bounds memory at full-universe scale).
4. **Raw JSONL holds normalized events**, not wire bytes. Buckets
   can be rebuilt from it; bit-exact wire replay is not possible.
5. **Up to 60 s of raw events live only in memory** between flushes;
   a hard crash loses at most one flush cycle.
6. **Snapshot config sources:** SSI credentials resolve env ->
   public FiinTrade bundle scrape -> public snapshot fallback
   (`mqtt-ssi`/`mqtt-ssi`); VNDirect key resolves from the public
   banggia bundle, else anonymous (the broker accepts anonymous).
   Only the SOURCE is ever logged, never any value.
