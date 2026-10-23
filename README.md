# @pipeworx/fl-medicaid-rates

Florida Medicaid reimbursement rates by provider and rate semester: FQHC and rural health clinic per-visit encounter rates, nursing home, skilled nursing unit, swing bed, hospice and hospital rates, with statewide min/median/max and the effective date.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1875+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `fl_fqhc_rates(period?, provider?, limit?)` — Florida Medicaid (not Medicare) FQHC per-visit PPS encounter rate for each clinic in a semester, with statewide min/median/max/mean.
- `fl_medicaid_rates(schedule, period?, provider?, limit?)` — the same shape for any schedule: `fqhc`, `rhc`, `pb_rhc`, `snu`, `swing_bed`, `hospice_level_of_care`, `hospice_room_board`, `nursing_home`, `hospital`.
- `fl_rate_periods(schedule?)` — which effective periods are published for each schedule.

## Auth

Keyless.

## Data sources

- Florida Agency for Health Care Administration (AHCA), Medicaid cost reimbursement rate schedules — the per-semester provider rate tables the agency publishes for each rate type. Public, no account.

Each call reads the agency's current publication list and the one table asked for, so new semesters appear without a code change. Nothing is bundled. Tables are small, and parsed results are held for ten minutes within an isolate.

Things worth knowing:

- The agency states that published rates are those in effect on the first day of the semester and are not updated for later revisions to an individual provider's cost data. Responses repeat this.
- Effective dates come from the publication's naming, which is not uniform across rate types; undated entries are listed as `undated`.
- FQHC/RHC tables carry one rate column whose header embeds the MEI percentage for the year. Rate columns are detected by being numeric and not an identifier, so a header change flows through rather than breaking.
- The nursing home workbook has more than one sheet; rows carry a `Sheet` column.
- Provider number is a string in the FQHC/RHC tables (leading zeros) and a number in others; the provider filter matches the digits either way.
- **`hospital` is the state mental health hospital per diem table only (3 hospitals).** The agency's own page says community-hospital inpatient is paid by DRG (since July 2013) and outpatient by EAPG (since July 2017) and posts no per diem for them; only the state mental health hospitals still get one. A community hospital is not missing from the data, it is not in this schedule. Responses carry a `scope` line saying so. `snu` is the complete hospital-based skilled nursing unit table the agency posts (3 units in October 2026).
- A 0 in a rate cell is the agency's "no rate for this service" (the hospital table shows 0 for outpatient on every state hospital). It is returned as `null`, listed in `null_rate_cells`/`null_rate_note`, and left out of `statewide`, so no statewide mean is computed over zeros.
- Rates are rounded to the cent (some workbooks store float noise such as 159.18499999999997).
- A partial read is refused, not answered: the reader counts the cells it read against the cells in the sheet, refuses a workbook with a sheet it could not open or a data sheet with no header row, and refuses a latest table with fewer provider rows than a per-schedule floor.
- Rate-letter and calculation-sheet PDFs, and the reimbursement plans, are not parsed.

## Freshness and refusals

Each file is read from the agency at most once a day per region and kept; `retrieved_at` is when the agency was last actually read and `from_cache` says whether this answer used a stored copy. If the agency refuses a fresh read and an earlier copy exists, the earlier copy answers and the response carries `upstream_refused` with the agency's reason. If it refuses and there is no earlier copy, the call fails and says why. The agency's firewall refuses requests from some regions; the pack does not disguise itself or rotate addresses.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "fl-medicaid-rates": {
      "url": "https://gateway.pipeworx.io/fl-medicaid-rates/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/fl-medicaid-rates/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1875+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/fl_fqhc_rates \
  -H 'Content-Type: application/json' \
  -d '{"period":"October 2025","provider":"Escambia","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/fl_fqhc_rates`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "fl-medicaid-rates": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-fl-medicaid-rates"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-fl-medicaid-rates
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Fl Medicaid Rates data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
