// lib/db-driver-pg.js — Vanilla-Postgres driver.
//
// Emulates the subset of the supabase-js / PostgREST query surface that
// ClosedHand actually uses, so the app can run on plain Postgres + pgvector
// (the OSS default) with no call-site changes. Selected in db.js via
// DB_DRIVER=pg. James's hosted instance stays on the supabase-js driver until
// the P6 migration; this driver is the OSS golden path.
//
// Implemented: SELECT with
//   .eq .neq .in .gt .gte .lt .lte .like .ilike .is .not .or
//   .order .limit .range .single .maybeSingle, count-head, and to-one embeds;
// writes: .insert / .update / .upsert({onConflict}) / .delete, with RETURNING
// when .select() is chained; and .rpc(name, args) via SELECT * FROM name(...).
// .storage and .channel are later phases; they are present as non-throwing stubs
// that resolve to a truthy error (callers all branch on `if (error)`), so nothing
// crashes.
//
// Vendored duplicate: webapp/db-driver-pg.js must be kept byte-identical.
// `require("pg")` is deferred to first real connection so the SQL compiler is
// unit-testable with no database and before `pg` is installed.

// --- identifier / json-path compilation -------------------------------------

function quoteIdent(id) {
  return String(id)
    .split(".")
    .map((p) => (p === "*" ? "*" : `"${p.replace(/"/g, '""')}"`))
    .join(".");
}

// PostgREST-style JSON path: "data->>subject" -> "data"->>'subject',
// "a->b->>c" -> "a"->'b'->>'c'. The base is an identifier; each key is a
// string literal (object access; array-index keys are out of scope here).
function compileJsonPath(expr) {
  const parts = String(expr).split(/(->>|->)/);
  let sql = quoteIdent(parts[0].trim());
  for (let i = 1; i < parts.length; i += 2) {
    const key = String(parts[i + 1]).trim().replace(/'/g, "''");
    sql += parts[i] + "'" + key + "'";
  }
  return sql;
}

// Split on `delim` at paren-depth 0 (so "id, profiles(*)" and an or-DSL with
// "in.(a,b)" split correctly).
function splitTopLevel(str, delim) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of String(str)) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === delim && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// PostgREST operator token -> SQL, for .not(col,op,val) and the .or() DSL.
const OP_SQL = {
  eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=",
  like: "LIKE", ilike: "ILIKE", is: "IS",
};

function isLiteral(val) {
  if (val === null || val === "null") return "NULL";
  if (val === true || val === "true") return "TRUE";
  if (val === false || val === "false") return "FALSE";
  return "NULL";
}

// Prepare a JS value for a write parameter, given the target column's
// information_schema data_type. The tricky case is a JS array: it must become a
// JSON string for a `jsonb`/`json` column (`messages`, `tokens`) but pass through
// for a NATIVE array column (`agent_tasks.tools_used text[]`) so node-pg builds an
// array literal. Objects to jsonb are stringified too. Everything else (strings
// like the pre-encoded `facts.value TEXT`, numbers, Date, Buffer) passes through
// untouched, so nothing is double-encoded. When the type is unknown, only the
// node-pg default applies (objects still stringify; arrays stay native-array).
function pgParam(v, dataType) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if ((dataType === "jsonb" || dataType === "json") && typeof v === "object") return JSON.stringify(v);
  return v;
}

// A pure numeric-array literal, e.g. "[0.1,-0.2,3e-4]" — the shape of a stringified
// pgvector embedding. Used to add an explicit ::vector cast on RPC args so Postgres
// resolves the function overload (text -> vector is not implicit).
const VECTOR_LITERAL = /^\[[\d.,\se+-]*\]$/;

// Compile a `.rpc(name, args)` call to `SELECT * FROM name(argname => $n, …)` using
// named-argument notation (matches supabase-js semantics: omitted args fall back to
// the function's DEFAULTs). Pure — no DB access — so it is unit-testable.
function compileRpc(name, args = {}) {
  const keys = Object.keys(args || {});
  const values = keys.map((k) => pgParam(args[k]));
  const named = keys
    .map((k, i) => {
      const cast = typeof args[k] === "string" && VECTOR_LITERAL.test(args[k]) ? "::vector" : "";
      return `${quoteIdent(k)} => $${i + 1}${cast}`;
    })
    .join(", ");
  return { text: `SELECT * FROM ${quoteIdent(name)}(${named})`, values };
}

// To-one relationship map for embeds. Only chat_links -> profiles is used today
// (user-store.js:622); add rows here as new embeds appear rather than
// introspecting the schema at runtime.
const EMBEDS = {
  chat_links: {
    profiles: { local: "user_id", table: "profiles", ref: "id" },
  },
};

// --- query builder (chainable, lazy thenable) -------------------------------

class PgQueryBuilder {
  constructor(pool, table, typeCache) {
    this._pool = pool;
    this._table = table;
    this._typeCache = typeCache; // Map<table, Map<column, data_type>>, shared per client

    this._columns = "*";
    this._filters = [];
    this._orders = [];
    this._limit = null;
    this._offset = null;
    this._single = false;
    this._maybeSingle = false;
    this._countHead = false;
    this._hasSelect = false;
    this._mutation = null; // set by insert/update/upsert/delete
  }

  // reads
  select(columns = "*", opts = {}) {
    this._columns = columns == null ? "*" : columns;
    this._hasSelect = true;
    if (opts && opts.head) this._countHead = true;
    return this;
  }
  eq(col, val) { this._filters.push({ col, op: "=", val }); return this; }
  neq(col, val) { this._filters.push({ col, op: "<>", val }); return this; }
  gt(col, val) { this._filters.push({ col, op: ">", val }); return this; }
  gte(col, val) { this._filters.push({ col, op: ">=", val }); return this; }
  lt(col, val) { this._filters.push({ col, op: "<", val }); return this; }
  lte(col, val) { this._filters.push({ col, op: "<=", val }); return this; }
  like(col, val) { this._filters.push({ col, op: "LIKE", val }); return this; }
  ilike(col, val) { this._filters.push({ col, op: "ILIKE", val }); return this; }
  in(col, arr) { this._filters.push({ col, op: "= ANY", val: arr, array: true }); return this; }
  is(col, val) { this._filters.push({ kind: "is", col, val }); return this; }
  not(col, op, val) { this._filters.push({ kind: "not", col, op, val }); return this; }
  or(dsl) { this._filters.push({ kind: "or", dsl }); return this; }
  order(col, opts = {}) {
    this._orders.push({ col, ascending: opts.ascending !== false, nullsFirst: opts.nullsFirst });
    return this;
  }
  limit(n) { this._limit = n; return this; }
  range(from, to) { this._offset = from; this._limit = to - from + 1; return this; }
  single() { this._single = true; return this; }
  maybeSingle() { this._maybeSingle = true; return this; }

  // writes — chainable so .insert(rows).select().single() and
  // .update(x).eq(...).select() work; compiled by _compileMutation(), with
  // RETURNING added when .select() is chained.
  insert(rows) { this._mutation = { kind: "insert", rows }; return this; }
  update(row) { this._mutation = { kind: "update", row }; return this; }
  upsert(rows, opts) { this._mutation = { kind: "upsert", rows, opts }; return this; }
  delete() { this._mutation = { kind: "delete" }; return this; }

  // Column reference in a filter/order clause. Qualify plain identifiers with
  // the base table when an embed JOIN is present, to avoid ambiguity.
  _colRef(col, hasEmbed) {
    const s = String(col).trim();
    if (s.includes("->")) return compileJsonPath(s);
    if (s === "*") return "*";
    return hasEmbed ? `${quoteIdent(this._table)}.${quoteIdent(s)}` : quoteIdent(s);
  }

  _compileWhere(hasEmbed, push) {
    const where = [];
    for (const f of this._filters) {
      const ref = (c) => this._colRef(c, hasEmbed);
      if (f.kind === "is") {
        where.push(`${ref(f.col)} IS ${isLiteral(f.val)}`);
      } else if (f.kind === "not") {
        if (f.op === "is") {
          where.push(`${ref(f.col)} IS NOT ${isLiteral(f.val)}`);
        } else if (f.op === "in") {
          const items = splitTopLevel(String(f.val).replace(/^\(|\)$/g, ""), ",")
            .map((s) => s.trim())
            .filter((s) => s.length);
          where.push(`${ref(f.col)} NOT IN (${items.map((v) => push(v)).join(", ")})`);
        } else {
          where.push(`NOT (${ref(f.col)} ${OP_SQL[f.op] || "="} ${push(f.val)})`);
        }
      } else if (f.kind === "or") {
        const terms = splitTopLevel(f.dsl, ",").map((t) => t.trim()).filter(Boolean);
        const ors = terms.map((term) => {
          const i1 = term.indexOf(".");
          const i2 = term.indexOf(".", i1 + 1);
          const col = term.slice(0, i1);
          const op = term.slice(i1 + 1, i2);
          const val = term.slice(i2 + 1);
          return `${ref(col)} ${OP_SQL[op] || "="} ${push(val)}`;
        });
        where.push(`(${ors.join(" OR ")})`);
      } else if (f.array) {
        // .in(col, [..]) -> col IN ($1,$2,..). One param per element (portable;
        // avoids array-param typing issues). Empty list matches nothing.
        const arr = Array.isArray(f.val) ? f.val : [];
        where.push(arr.length ? `${ref(f.col)} IN (${arr.map((v) => push(v)).join(", ")})` : "false");
      } else {
        where.push(`${ref(f.col)} ${f.op} ${push(f.val)}`);
      }
    }
    return where;
  }

  // Compile to a single parameterised statement. Pure — no DB access — so it is
  // directly unit-testable.
  _compile() {
    const values = [];
    const push = (v) => { values.push(v); return "$" + values.length; };
    const base = this._table;
    const embedMap = EMBEDS[base] || {};

    const raw = this._columns == null || this._columns === "" ? "*" : String(this._columns);
    const entries = splitTopLevel(raw, ",").map((s) => s.trim());
    const hasEmbed = entries.some((e) => {
      const m = e.match(/^(\w+)\s*\((.*)\)$/);
      return m && embedMap[m[1]];
    });

    const embedJoins = [];
    let selectSql;
    if (this._countHead) {
      selectSql = "count(*)::int AS count";
    } else {
      const cols = [];
      for (const e of entries) {
        const m = e.match(/^(\w+)\s*\((.*)\)$/);
        if (m && embedMap[m[1]]) {
          const rel = embedMap[m[1]];
          embedJoins.push(rel);
          cols.push(
            `CASE WHEN ${quoteIdent(rel.table)}.${quoteIdent(rel.ref)} IS NULL THEN NULL ` +
              `ELSE to_jsonb(${quoteIdent(rel.table)}) END AS ${quoteIdent(m[1])}`
          );
        } else if (e === "*") {
          cols.push(hasEmbed ? `${quoteIdent(base)}.*` : "*");
        } else if (e.includes("->")) {
          cols.push(compileJsonPath(e));
        } else {
          cols.push(hasEmbed ? `${quoteIdent(base)}.${quoteIdent(e)}` : quoteIdent(e));
        }
      }
      selectSql = cols.join(", ");
    }

    let sql = `SELECT ${selectSql} FROM ${quoteIdent(base)}`;
    for (const rel of embedJoins) {
      sql += ` LEFT JOIN ${quoteIdent(rel.table)} ON ${quoteIdent(base)}.${quoteIdent(rel.local)} = ${quoteIdent(rel.table)}.${quoteIdent(rel.ref)}`;
    }

    const where = this._compileWhere(hasEmbed, push);
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;

    if (!this._countHead && this._orders.length) {
      const orderSql = this._orders
        .map((o) => {
          const dir = o.ascending ? "ASC" : "DESC";
          const nulls = o.nullsFirst === true ? " NULLS FIRST" : o.nullsFirst === false ? " NULLS LAST" : "";
          return `${this._colRef(o.col, hasEmbed)} ${dir}${nulls}`;
        })
        .join(", ");
      sql += ` ORDER BY ${orderSql}`;
    }

    if (!this._countHead) {
      let lim = this._limit;
      if (this._single || this._maybeSingle) lim = 2; // detect the >1-row case
      if (lim != null) sql += ` LIMIT ${Number(lim)}`;
      if (this._offset != null) sql += ` OFFSET ${Number(this._offset)}`;
    }

    return { text: sql, values };
  }

  // Column data_type from information_schema (cached per client), used to decide
  // how to encode a written value (jsonb vs native array vs scalar).
  _typeOf(col) {
    const t = this._typeCache && this._typeCache.get(this._table);
    return t ? t.get(col) : undefined;
  }

  async _ensureTypes() {
    if (!this._typeCache || this._typeCache.has(this._table)) return;
    try {
      const res = await this._pool.query(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public'",
        [this._table]
      );
      const m = new Map();
      for (const r of res.rows) m.set(r.column_name, r.data_type);
      this._typeCache.set(this._table, m);
    } catch (_) {
      this._typeCache.set(this._table, new Map()); // empty -> node-pg default encoding
    }
  }

  // RETURNING column list (plain columns / arrow paths / *). No embeds.
  _compileReturning() {
    const raw = this._columns == null || this._columns === "" ? "*" : String(this._columns);
    return splitTopLevel(raw, ",")
      .map((s) => s.trim())
      .map((e) => (e === "*" ? "*" : e.includes("->") ? compileJsonPath(e) : quoteIdent(e)))
      .join(", ");
  }

  // Compile INSERT / UPDATE / UPSERT / DELETE to one parameterised statement.
  _compileMutation() {
    const values = [];
    const push = (v, dataType) => { values.push(pgParam(v, dataType)); return "$" + values.length; };
    const T = quoteIdent(this._table);
    const m = this._mutation;
    const returning = this._hasSelect ? ` RETURNING ${this._compileReturning()}` : "";

    if (m.kind === "delete") {
      const where = this._compileWhere(false, push);
      return { text: `DELETE FROM ${T}${where.length ? " WHERE " + where.join(" AND ") : ""}${returning}`, values };
    }

    if (m.kind === "update") {
      const row = m.row || {};
      const sets = Object.keys(row).map((k) => `${quoteIdent(k)} = ${push(row[k], this._typeOf(k))}`);
      const where = this._compileWhere(false, push);
      return { text: `UPDATE ${T} SET ${sets.join(", ")}${where.length ? " WHERE " + where.join(" AND ") : ""}${returning}`, values };
    }

    // insert / upsert — rows may be a single object or an array of objects.
    const rows = Array.isArray(m.rows) ? m.rows : [m.rows || {}];
    const cols = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    const colSql = cols.map(quoteIdent).join(", ");
    const tuples = rows.map(
      (r) => "(" + cols.map((c) => (Object.prototype.hasOwnProperty.call(r, c) ? push(r[c], this._typeOf(c)) : "DEFAULT")).join(", ") + ")"
    );
    let sql = `INSERT INTO ${T} (${colSql}) VALUES ${tuples.join(", ")}`;

    if (m.kind === "upsert" && m.opts && m.opts.onConflict) {
      const confCols = String(m.opts.onConflict).split(",").map((s) => s.trim());
      const conflictSql = confCols.map(quoteIdent).join(", ");
      const updateCols = cols.filter((c) => !confCols.includes(c));
      sql += updateCols.length
        ? ` ON CONFLICT (${conflictSql}) DO UPDATE SET ${updateCols.map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`).join(", ")}`
        : ` ON CONFLICT (${conflictSql}) DO NOTHING`;
    }

    return { text: sql + returning, values };
  }

  async _run() {
    let res;
    try {
      if (this._mutation) await this._ensureTypes();
      const { text, values } = this._mutation ? this._compileMutation() : this._compile();
      res = await this._pool.query(text, values);
    } catch (e) {
      return { data: null, error: { message: e.message, code: e.code, details: e.detail } };
    }

    // count-head (reads only)
    if (!this._mutation && this._countHead) {
      return { data: null, error: null, count: res.rows[0] ? res.rows[0].count : 0 };
    }
    // a write without .select() returns no rows (supabase-js shape)
    if (this._mutation && !this._hasSelect) {
      return { data: null, error: null };
    }

    // shared row coercion for reads and RETURNING writes
    const rows = res.rows;
    if (this._single) {
      if (rows.length === 0) {
        return { data: null, error: { code: "PGRST116", message: "JSON object requested, 0 rows returned", details: "The result contains 0 rows" } };
      }
      if (rows.length > 1) {
        return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple rows returned" } };
      }
      return { data: rows[0], error: null };
    }
    if (this._maybeSingle) {
      if (rows.length === 0) return { data: null, error: null };
      if (rows.length > 1) {
        return { data: null, error: { code: "PGRST116", message: "multiple rows returned by maybeSingle" } };
      }
      return { data: rows[0], error: null };
    }
    return { data: rows, error: null, count: null };
  }

  // thenable — awaiting compiles + runs; it resolves (never rejects) with
  // { data, error }, matching supabase-js.
  then(onFulfilled, onRejected) { return this._run().then(onFulfilled, onRejected); }
  catch(onRejected) { return this._run().catch(onRejected); }
  finally(onFinally) { return this._run().finally(onFinally); }
}

// --- not-yet-implemented surfaces (later phases) ----------------------------

const NOT_IMPL = (feature, phase) => () =>
  Promise.resolve({ data: null, error: { message: `pg driver: ${feature} not implemented yet (${phase})`, code: "PG_DRIVER_TODO" } });

const storageBucketStub = {
  upload: NOT_IMPL("storage.upload", "phase 4"),
  download: NOT_IMPL("storage.download", "phase 4"),
  remove: NOT_IMPL("storage.remove", "phase 4"),
  list: NOT_IMPL("storage.list", "phase 4"),
  createSignedUrl: NOT_IMPL("storage.createSignedUrl", "phase 4"),
  getPublicUrl: () => ({ data: { publicUrl: "" } }),
};

// --- client factory ---------------------------------------------------------

function createPgClient({ connectionString, pool } = {}) {
  // `pool` is a test-only injection seam (e.g. a pg-mem pool). In production it
  // is omitted and a real pg.Pool is built; require("pg") is deferred to here so
  // it is only needed when the pg driver is actually selected.
  if (!pool) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString });
  }

  const typeCache = new Map(); // Map<table, Map<column, data_type>>, shared per client
  return {
    _pool: pool,
    from(table) { return new PgQueryBuilder(pool, table, typeCache); },
    async rpc(name, args) {
      try {
        const { text, values } = compileRpc(name, args);
        const res = await pool.query(text, values);
        return { data: res.rows, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message, code: e.code, details: e.detail } };
      }
    },
    storage: { from: () => storageBucketStub },
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => ch };
      return ch;
    },
    removeChannel: () => {},
    removeAllChannels: () => {},
  };
}

module.exports = {
  createPgClient,
  // exported for unit tests (compile without a database):
  PgQueryBuilder,
  _internals: { quoteIdent, compileJsonPath, splitTopLevel, compileRpc },
};
