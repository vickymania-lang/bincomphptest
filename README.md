# Bincom Polling Unit Results

Node.js + Express + MySQL solution to the Bincom Experienced Software Developer test.

**Live demo:** `<your-live-url>`

| Question | Page        | Description                                                              |
| -------- | ----------- | ------------------------------------------------------------------------ |
| 1        | `/`         | View the results of any polling unit (LGA, then Ward, then Polling Unit) |
| 2        | `/lga.html` | Summed results of all polling units under a selected LGA                 |
| 3        | `/add.html` | Store results for all parties for a new polling unit                     |

## Tech stack

Node.js, Express, `mysql2` (connection pool), MySQL, plain HTML/CSS/JavaScript.

## Setup

1. Clone the repo and install dependencies:
   ```bash
   npm install
   ```
2. Create the database and import the dump:
   ```bash
   mysql -u root -p -e "CREATE DATABASE bincomphptest"
   mysql -u root -p bincomphptest < bincom_test.sql
   ```
   On Windows PowerShell, use `Get-Content bincom_test.sql | mysql -u root -p bincomphptest`.
3. Copy `.env.example` to `.env` and fill in your database details:
   ```
   DB_HOST=localhost
   DB_USER=root
   DB_PASSWORD=
   DB_NAME=bincomphptest
   PORT=3000
   ```
4. Start the server and open `http://localhost:3000`:
   ```bash
   node server.js
   ```

## API endpoints

| Method | Route                     | Purpose                                      |
| ------ | ------------------------- | -------------------------------------------- |
| GET    | `/api/lgas`               | LGAs in Delta State (state id 25)            |
| GET    | `/api/wards/:lgaId`       | Wards in an LGA                              |
| GET    | `/api/pus/:lgaId/:wardId` | Polling units in a ward                      |
| GET    | `/api/results/:puId`      | Party scores for one polling unit            |
| GET    | `/api/lga-total/:lgaId`   | Summed party scores for an LGA               |
| GET    | `/api/parties`            | Party list                                   |
| POST   | `/api/polling-units`      | Create a polling unit with all party results |

## Design decisions

- **Parameterised queries** are used everywhere to prevent SQL injection.
- **Party list comes from the `party` table**, not hardcoded. The party table drives a `LEFT JOIN`, so a party with no recorded score still shows up (as a dash in Q1, as 0 in Q2).
- **Q2 does not use `announced_lga_results`.** As instructed, totals are computed by joining `announced_pu_results` to `polling_unit` on `uniqueid` and filtering by `polling_unit.lga_id`.
- **Q3 uses a transaction.** The new polling unit and all its result rows are saved together, or not at all.
- **Q3 validation** happens on both the client and the server. Every party needs a whole-number score of 0 or more, and the ward must belong to the chosen LGA.
- **Join key:** results join on `polling_unit.uniqueid = announced_pu_results.polling_unit_uniqueid`, not on `polling_unit_id`, as the test brief warns. Note that the results column is a `varchar`.

## Assumptions and data observations

- **Duplicate rows:** polling unit 10 has two rows for each of several parties in `announced_pu_results`. Q2 uses a plain `SUM`, so this unit is counted twice. I left the data as given rather than guess which rows are correct.
- **Sparse results:** only 18 polling units have results, spread over 8 LGAs. Other LGAs show a "no results" message in Q2.
- **Orphan polling units:** 170 polling units have `lga_id = 0` and belong to no real LGA, so they never appear under an LGA.
- **`uniquewardid` is inconsistent** in the existing data (it matches `ward.uniqueid` for only some rows). For new polling units in Q3, I set it to the correct `ward.uniqueid`.
- **Generated values in Q3:**
  - `polling_unit_id` is the next number within the ward (`MAX + 1`).
  - `polling_unit_number` follows the existing pattern `DT` + LGA (2 digits) + ward (2 digits) + unit (3 digits), for example `DT1901004`.
  - `date_entered` is set by the server, and `user_ip_address` is taken from the request.
- **Delta State only:** the LGA lists are filtered to `state_id = 25`.

## Known limitations

- No authentication. Anyone who can open `/add.html` can add results. In production this would sit behind login, with rate limiting.
- No duplicate check on polling unit names within a ward.
- Raw SQL is used instead of an ORM, because the schema is an existing legacy dump.
