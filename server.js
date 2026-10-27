require("dotenv").config();
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const app = express();

// Initialize PostgreSQL pool using your Neon connection string
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://neondb_owner:npg_rvHkzL0MyJD7@ep-cool-math-b5ganvf8-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  ssl: {
    rejectUnauthorized: false,
  },
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Fallback root route to serve your index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const STATE_ID = 25; // Delta State

app.get("/api/lgas", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT lga_id, lga_name FROM lga WHERE state_id = $1 ORDER BY lga_name",
      [STATE_ID],
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/wards/:lgaId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT ward_id, ward_name FROM ward WHERE lga_id = $1 ORDER BY ward_name",
      [req.params.lgaId],
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/pus/:lgaId/:wardId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT uniqueid, polling_unit_name, polling_unit_number
       FROM polling_unit WHERE lga_id = $1 AND ward_id = $2
       ORDER BY polling_unit_name`,
      [req.params.lgaId, req.params.wardId],
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/results/:puId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.partyid AS party, r.party_score AS score
       FROM party p
       LEFT JOIN announced_pu_results r
         ON r.party_abbreviation = p.partyid AND r.polling_unit_uniqueid = $1
       ORDER BY p.id`,
      [String(req.params.puId)],
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/lga-total/:lgaId", async (req, res) => {
  try {
    const { rows: totals } = await pool.query(
      `SELECT p.partyid AS party, COALESCE(SUM(x.party_score), 0) AS total
       FROM party p
       LEFT JOIN (
         SELECT r.party_abbreviation, r.party_score
         FROM announced_pu_results r
         JOIN polling_unit pu ON pu.uniqueid = r.polling_unit_uniqueid
         WHERE pu.lga_id = $1
       ) x ON x.party_abbreviation = p.partyid
       GROUP BY p.id, p.partyid
       ORDER BY p.id`,
      [req.params.lgaId],
    );

    const metaResult = await pool.query(
      `SELECT COUNT(DISTINCT r.polling_unit_uniqueid) AS units
       FROM announced_pu_results r
       JOIN polling_unit pu ON pu.uniqueid = r.polling_unit_uniqueid
       WHERE pu.lga_id = $1`,
      [req.params.lgaId],
    );
    const units = parseInt(metaResult.rows[0]?.units || 0, 10);

    res.json({ units, totals });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/parties", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT partyid FROM party ORDER BY id");
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/polling-units", async (req, res) => {
  const { lga_id, ward_id, polling_unit_name, entered_by, scores } =
    req.body || {};
  const name = String(polling_unit_name || "").trim();
  const by = String(entered_by || "").trim();

  if (
    !lga_id ||
    !ward_id ||
    !name ||
    !by ||
    typeof scores !== "object" ||
    !scores
  )
    return res.status(400).json({ error: "Please fill in every field." });

  const client = await pool.connect();
  try {
    // Validate LGA and Ward
    const wardRes = await client.query(
      `SELECT w.uniqueid FROM ward w JOIN lga l ON l.lga_id = w.lga_id
       WHERE w.ward_id = $1 AND w.lga_id = $2 AND l.state_id = $3`,
      [ward_id, lga_id, STATE_ID],
    );
    const ward = wardRes.rows[0];
    if (!ward) return res.status(400).json({ error: "Invalid LGA or ward." });

    // Validate scores
    const partiesRes = await client.query(
      "SELECT partyid FROM party ORDER BY id",
    );
    const resultRows = [];
    for (const { partyid } of partiesRes.rows) {
      const v = scores[partyid];
      if (v === "" || v === null || v === undefined || !/^\d+$/.test(String(v)))
        return res
          .status(400)
          .json({ error: `Enter a valid score for ${partyid} (0 or more).` });
      resultRows.push([partyid, parseInt(v, 10)]);
    }

    await client.query("BEGIN");

    const maxRes = await client.query(
      `SELECT COALESCE(MAX(polling_unit_id), 0) + 1 AS n
       FROM polling_unit WHERE lga_id = $1 AND ward_id = $2 FOR UPDATE`,
      [lga_id, ward_id],
    );
    const n = maxRes.rows[0].n;

    const number =
      "DT" +
      String(lga_id).padStart(2, "0") +
      String(ward_id).padStart(2, "0") +
      String(n).padStart(3, "0");
    const ip = String(req.ip || "").slice(0, 50);

    // Insert polling unit and retrieve the generated uniqueid (Postgres uses RETURNING)
    const insRes = await client.query(
      `INSERT INTO polling_unit
       (polling_unit_id, ward_id, lga_id, uniquewardid, polling_unit_number,
        polling_unit_name, entered_by_user, date_entered, user_ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8) RETURNING uniqueid`,
      [n, ward_id, lga_id, ward.uniqueid, number, name, by, ip],
    );
    const puId = insRes.rows[0].uniqueid;

    // Insert results loops for Postgres
    for (const [party, score] of resultRows) {
      await client.query(
        `INSERT INTO announced_pu_results
         (polling_unit_uniqueid, party_abbreviation, party_score,
          entered_by_user, date_entered, user_ip_address) VALUES ($1, $2, $3, $4, NOW(), $5)`,
        [String(puId), party, score, by, ip],
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ uniqueid: puId, polling_unit_number: number });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(e);
    res.status(500).json({ error: "Could not save. Please try again." });
  } finally {
    client.release();
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Running"));
