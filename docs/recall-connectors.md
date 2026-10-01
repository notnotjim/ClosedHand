# Automatic recall for connections

ClosedHand uses one ingestion protocol for connected APIs, MCP collections and
enumerated resources. It keeps useful records in `data_cache`, embeds their
passages in `data_vectors`, and retrieves them alongside existing sources and
indexed files before the primary LLM responds.

Discovery, recipe validation, fetching and scheduling do not call an LLM. Changing
the primary or support LLM does not change a source's recipe or stored vectors.
Embeddings use the independently configured recall model, which can be local.

## What should be remembered

The decision is per collection, not per company or connection technology. Personal
and work records such as notes, documents, messages, bookings, tasks and invoices
provide lasting context. Current weather, prices, availability, playback state,
telemetry, calculations and action confirmations stay on demand. A research note
about weather is still a useful document. Merely returning JSON is not enough.

The compiler checks the reader's declared purpose, stable record IDs and readable
fields. It excludes secret fields and does not turn raw numeric readings into
semantic memory. An ambiguous collection needs a description; it is not silently
treated as fully remembered. Original records stay at their source.

## Connection descriptions

An ordinary API connection carries its approved API origins in
`connections.config.recall_api.origins`. OAuth setup saves the integration's API,
profile and token origins, and the webapp backfills descriptions for existing
connections. Integration definitions can supply `apiBaseUrl` and `openapiUrl`.
Credentials are injected only when reading the approved source, never embedded in
recipes. Discovery requests are anonymous, redirects are rejected, and a schema
cannot send the connection's credential to another origin.

The worker accepts an OpenAPI 3 document from `config.recall.openapi`, from
`config.recall.openapiUrl`, or from the configured integration's `openapiUrl`.
Otherwise it checks `/.well-known/openapi.json`, `/openapi.json` and `/swagger.json`
at the approved origins. It compiles documented JSON collection readers, resolving
local schema references and common nested record fields. Undocumented URLs are
never guessed. Existing GitHub/GitLab descriptions use this same compiler and
runner; they are compatibility data, not a gate on other service names.

MCP discovery considers both explicitly enumerated resources and readable tools.
Tools must declare read-only behaviour or have an explicit verified reader
description. Write-like operations and destructive annotations cannot be overridden
by a misleading read-only label. Structured tool results and JSON text are
supported. When `outputSchema` is absent, a bounded sample of a declared list
reader can establish the record shape. Empty collections are retried later.

Required scope arguments can come from a declared default, a selected scope in
the recipe, or another documented collection. For example, `list_projects` can
supply the `project_id` required by `list_notes`. The compiler links a parent only
when there is one unambiguous matching reader. Explicit `scope` mappings cover
other names. Parent graphs are bounded and cannot contain cycles. Required search
terms and ambiguous scopes remain explicit, rather than being invented.

## A source-specific mapping without source-specific code

An MCP tool may include this in `_meta["closedhand/recall"]`. An API operation can
include the same object in `x-closedhand-recall`. A saved connection description
can also include it in `collections`, with `operation` naming a discovered tool
or an OpenAPI operation ID.

```json
{
  "operation": "list_journal_entries",
  "value": "durable",
  "items": "result.entries",
  "fields": {
    "id": "entry_number",
    "title": "heading",
    "text": ["heading", "narrative"],
    "updated": "modified_at",
    "deleted": "deleted"
  },
  "args": { "journal_id": "the-selected-journal" },
  "pagination": {
    "kind": "cursor",
    "param": "after",
    "next": "result.next_cursor",
    "sizeParam": "limit",
    "size": 100
  },
  "complete": true
}
```

Supported pagination kinds are `cursor`, `page`, `offset` and `none`. Numbered
pagination includes `param`, `sizeParam`, `size` and `start`; an optional `more`
field identifies an explicit has-more flag. A source must explicitly declare
`complete: true` to allow deletion reconciliation for an unpaginated listing.
Without proof of completeness, fetched records can still be used, but unseen
records are not treated as deleted.

A recipe can use a separate full-record reader:

```json
{
  "detail": {
    "operation": "read_journal_entry",
    "param": "entry_id",
    "idField": "entry_number",
    "result": "entry"
  }
}
```

Here `idField` comes from the list item. The recipe's `fields` mapping describes
the full record returned by the detail reader. The detail operation must also be
documented and read-only. Recipes are data, with no JavaScript, shell commands or
arbitrary header expressions.

For a nested collection, `"scope": { "operation": "list_projects", "param":
"project_id" }` supplies each listed project's stable ID. The parent must itself
have a valid collection recipe. A child is complete only when both parent and
child listings complete. IDs are scoped by parent, so identically numbered
records in separate projects cannot overwrite each other.

The authenticated `GET /api/recall-sources` endpoint and `recall_sources` tool show
coverage and reasons for omissions without exposing credentials. Descriptions can
be updated through `PUT /api/recall-sources/:kind/:id` or
`configure_source_recall`. `kind` is `connection` or `mcp`; all reads and updates
are scoped to the current user. The LLM can help supply a documented mapping, but
the worker still validates it and routine syncing never depends on that LLM.

## Updates, deletions and incomplete reads

Recipes are saved beside the connection, invalidated when its description
changes, and reused across restarts. Readers use the same 15-minute scheduling,
content hashes, passage splitting and missing-vector retry logic. Unchanged
records are not embedded again. The runner supports explicit boolean tombstones
and reconciles deletions only after a complete collection read. Shortened records
lose their obsolete passages even when the overall collection is partial.

Collections have independent IDs and completion states. A failed page in one
collection cannot erase another. Repeated cursors, repeated record IDs, malformed
responses and limits leave an explicit error or partial state. Current limits are
100 pages, 10,000 records per collection, 8 MiB per HTTP response and 200,000
characters per record. These limits are reported, not represented as full
coverage. MCP binary resources continue through the existing file/tool path.

Removed connections, revoked access and collections reclassified as transient
stop supplying automatic context. The existing explicit choice to retain cached
OAuth records on disconnect is respected.
