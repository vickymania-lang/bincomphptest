require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");

const app = express();
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
});

app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json());

const STATE_ID = 25; // Delta State

app.get("/api/lgas", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT lga_id, lga_name FROM lga WHERE state_id = ? ORDER BY lga_name",
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
    const [rows] = await pool.query(
      "SELECT ward_id, ward_name FROM ward WHERE lga_id = ? ORDER BY ward_name",
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
    const [rows] = await pool.query(
      `SELECT uniqueid, polling_unit_name, polling_unit_number
       FROM polling_unit WHERE lga_id = ? AND ward_id = ?
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
    // party table drives the rows, so parties with no score still appear
    const [rows] = await pool.query(
      `SELECT p.partyid AS party, r.party_score AS score
       FROM party p
       LEFT JOIN announced_pu_results r
         ON r.party_abbreviation = p.partyid AND r.polling_unit_uniqueid = ?
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
    const [totals] = await pool.query(
      `SELECT p.partyid AS party, COALESCE(SUM(x.party_score), 0) AS total
       FROM party p
       LEFT JOIN (
         SELECT r.party_abbreviation, r.party_score
         FROM announced_pu_results r
         JOIN polling_unit pu ON pu.uniqueid = r.polling_unit_uniqueid
         WHERE pu.lga_id = ?
       ) x ON x.party_abbreviation = p.partyid
       GROUP BY p.id, p.partyid
       ORDER BY p.id`,
      [req.params.lgaId],
    );
    const [[meta]] = await pool.query(
      `SELECT COUNT(DISTINCT r.polling_unit_uniqueid) AS units
       FROM announced_pu_results r
       JOIN polling_unit pu ON pu.uniqueid = r.polling_unit_uniqueid
       WHERE pu.lga_id = ?`,
      [req.params.lgaId],
    );
    res.json({ units: meta.units, totals });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/parties", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT partyid FROM party ORDER BY id");
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

  const conn = await pool.getConnection();
  try {
    // validate LGA (Delta State) and that the ward belongs to it
    const [[ward]] = await conn.query(
      `SELECT w.uniqueid FROM ward w JOIN lga l ON l.lga_id = w.lga_id
       WHERE w.ward_id = ? AND w.lga_id = ? AND l.state_id = ?`,
      [ward_id, lga_id, STATE_ID],
    );
    if (!ward) return res.status(400).json({ error: "Invalid LGA or ward." });

    // every party must have a whole-number score >= 0
    const [parties] = await conn.query("SELECT partyid FROM party ORDER BY id");
    const resultRows = [];
    for (const { partyid } of parties) {
      const v = scores[partyid];
      if (v === "" || v === null || v === undefined || !/^\d+$/.test(String(v)))
        return res
          .status(400)
          .json({ error: `Enter a valid score for ${partyid} (0 or more).` });
      resultRows.push([partyid, parseInt(v, 10)]);
    }

    await conn.beginTransaction();
    const [[{ n }]] = await conn.query(
      `SELECT COALESCE(MAX(polling_unit_id), 0) + 1 AS n
       FROM polling_unit WHERE lga_id = ? AND ward_id = ? FOR UPDATE`,
      [lga_id, ward_id],
    );
    const number =
      "DT" +
      String(lga_id).padStart(2, "0") +
      String(ward_id).padStart(2, "0") +
      String(n).padStart(3, "0");
    const ip = String(req.ip || "").slice(0, 50);

    const [ins] = await conn.query(
      `INSERT INTO polling_unit
        (polling_unit_id, ward_id, lga_id, uniquewardid, polling_unit_number,
         polling_unit_name, entered_by_user, date_entered, user_ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
      [n, ward_id, lga_id, ward.uniqueid, number, name, by, ip],
    );
    const puId = ins.insertId;

    await conn.query(
      `INSERT INTO announced_pu_results
        (polling_unit_uniqueid, party_abbreviation, party_score,
         entered_by_user, date_entered, user_ip_address) VALUES ?`,
      [
        resultRows.map(([party, score]) => [
          String(puId),
          party,
          score,
          by,
          new Date(),
          ip,
        ]),
      ],
    );

    await conn.commit();
    res.status(201).json({ uniqueid: puId, polling_unit_number: number });
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.error(e);
    res.status(500).json({ error: "Could not save. Please try again." });
  } finally {
    conn.release();
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Running"));
