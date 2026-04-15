// Windowed retrieval_utilization analyzer.
// Connects to the same SurrealDB kongcode uses and runs time-bucketed
// aggregations to separate lifetime-average lag from recent-window signal.
//
// Run: node .upgrade/tools/check-utilization.mjs

import { Surreal } from "surrealdb";

const db = new Surreal();

try {
  await db.connect("ws://localhost:8000/rpc", {
    namespace: "kong",
    database: "memory",
    authentication: { username: process.env.SURREAL_USER || "root", password: process.env.SURREAL_PASS || "root" },
  });

  const [lifetime] = await db.query(`
    SELECT
      math::mean(utilization) AS avg,
      count() AS n,
      math::min(utilization) AS min,
      math::max(utilization) AS max
    FROM retrieval_outcome
    GROUP ALL;
  `);

  const [last1h] = await db.query(`
    SELECT
      math::mean(utilization) AS avg,
      count() AS n
    FROM retrieval_outcome
    WHERE created_at > time::now() - 1h
    GROUP ALL;
  `);

  const [last24h] = await db.query(`
    SELECT
      math::mean(utilization) AS avg,
      count() AS n
    FROM retrieval_outcome
    WHERE created_at > time::now() - 1d
    GROUP ALL;
  `);

  const [last7d] = await db.query(`
    SELECT
      math::mean(utilization) AS avg,
      count() AS n
    FROM retrieval_outcome
    WHERE created_at > time::now() - 7d
    GROUP ALL;
  `);

  const [last30d] = await db.query(`
    SELECT
      math::mean(utilization) AS avg,
      count() AS n
    FROM retrieval_outcome
    WHERE created_at > time::now() - 30d
    GROUP ALL;
  `);

  const schemaProbe = await db.query(`
    SELECT * FROM retrieval_outcome ORDER BY created_at DESC LIMIT 3;
  `);

  const fmt = (row) => {
    if (!row || row.length === 0 || !row[0]) return "no data";
    const r = row[0];
    const avg = r.avg != null ? Number(r.avg).toFixed(4) : "null";
    const n = r.n ?? 0;
    return `avg=${avg} n=${n}`;
  };

  console.log("=== RETRIEVAL UTILIZATION BY WINDOW ===");
  console.log(`  lifetime:   ${fmt(lifetime)}`);
  console.log(`  last 1h:    ${fmt(last1h)}`);
  console.log(`  last 24h:   ${fmt(last24h)}`);
  console.log(`  last 7d:    ${fmt(last7d)}`);
  console.log(`  last 30d:   ${fmt(last30d)}`);

  const life = lifetime?.[0];
  const recent = last24h?.[0];
  if (life && recent && recent.n > 0 && recent.avg != null && life.avg != null) {
    const delta = Number(recent.avg) - Number(life.avg);
    const ratio = Number(recent.avg) / Math.max(Number(life.avg), 0.0001);
    console.log("");
    console.log("=== DELTA: recent vs lifetime ===");
    console.log(`  last 24h - lifetime = ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}`);
    console.log(`  last 24h / lifetime = ${ratio.toFixed(2)}x`);
    if (ratio > 1.5) {
      console.log(`  → recent utilization is ${ratio.toFixed(1)}x lifetime — phase 1 is moving the needle`);
    } else if (ratio > 1.1) {
      console.log(`  → recent is modestly above lifetime — some improvement, watch trend`);
    } else if (ratio < 0.9) {
      console.log(`  → recent is BELOW lifetime — regression, investigate`);
    } else {
      console.log(`  → recent matches lifetime — no change yet (too early or phase 1 not helping)`);
    }
  }

  console.log("");
  console.log("=== SCHEMA PROBE (3 most recent retrieval_outcome records) ===");
  const rows = Array.isArray(schemaProbe) && schemaProbe[0] ? schemaProbe[0] : [];
  rows.slice(0, 3).forEach((r, i) => {
    const keys = Object.keys(r).slice(0, 8).join(", ");
    console.log(`  [${i}] id=${r.id ?? "?"} util=${r.utilization ?? "?"} created=${r.created_at ?? "?"}`);
    console.log(`      keys: ${keys}`);
  });

  await db.close();
} catch (err) {
  console.error("ERROR:", err.message);
  console.error(err.stack?.slice(0, 500));
  process.exit(1);
}
