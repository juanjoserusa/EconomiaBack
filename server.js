require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

/* ===================== CORS + JSON ===================== */
app.use(
  cors({
    origin: "*",
    methods: "GET, POST, PUT, DELETE",
    allowedHeaders: "Content-Type",
  })
);
app.use(express.json());

/* ===================== POSTGRES ===================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => console.error("❌ Error en PostgreSQL:", err));

/* ===================== HELPERS ===================== */

function parseMoneyToCents(input) {
  if (input === null || input === undefined) return null;

  let s = String(input).trim();
  if (!s) return null;

  // Permite "3,50" o "3.50"
  s = s.replace(",", ".");

  // Quita todo salvo dígitos y punto
  s = s.replace(/[^\d.]/g, "");

  // Si hay más de un punto, deja solo el primero
  const firstDot = s.indexOf(".");
  if (firstDot !== -1) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "");
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  return Math.round(n * 100);
}

function centsToMoney(cents) {
  if (cents === null || cents === undefined) return null;
  return Math.round(Number(cents)) / 100;
}


function toPeriodKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function toDateOnly(d) {
  // YYYY-MM-DD in local time
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfWeekMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 Sun ... 6 Sat
  const diff = (day === 0 ? -6 : 1) - day; // move to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/* ===================== INIT DB ===================== */
async function initDb() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS economia;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'month_status' AND typnamespace = 'economia'::regnamespace) THEN
        CREATE TYPE economia.month_status AS ENUM ('OPEN','CLOSED');
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'week_status' AND typnamespace = 'economia'::regnamespace) THEN
        CREATE TYPE economia.week_status AS ENUM ('OPEN','CLOSED');
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attribution' AND typnamespace = 'economia'::regnamespace) THEN
        CREATE TYPE economia.attribution AS ENUM ('MINE','PARTNER','HOUSE');
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_method' AND typnamespace = 'economia'::regnamespace) THEN
        CREATE TYPE economia.payment_method AS ENUM ('CARD','CASH','TRANSFER');
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tx_type' AND typnamespace = 'economia'::regnamespace) THEN
        CREATE TYPE economia.tx_type AS ENUM (
          'EXPENSE',
          'EXTRA_INCOME',
          'CASH_WITHDRAWAL',
          'CASH_RETURN',
          'CONSOLIDATE_TO_SAFETY',
          'EMERGENCY_FROM_SAFETY',
          'PIGGYBANK_DEPOSIT'
        );
      END IF;
    END
    $$;

    CREATE TABLE IF NOT EXISTS economia.month (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      period_key TEXT UNIQUE NOT NULL, -- 'YYYY-MM'
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      income_amount INT NOT NULL,
      weekly_budget_amount INT NOT NULL,
      saving_goal_amount INT NOT NULL,
      status economia.month_status NOT NULL DEFAULT 'OPEN',
      closed_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS economia.week (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      month_id UUID NOT NULL REFERENCES economia.month(id) ON DELETE CASCADE,
      week_index INT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      cash_withdraw_amount INT NOT NULL,
      cash_returned_to_bank_amount INT NOT NULL DEFAULT 0,
      status economia.week_status NOT NULL DEFAULT 'OPEN',
      closed_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (month_id, week_index)
    );

    CREATE TABLE IF NOT EXISTS economia.category (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT UNIQUE NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS economia.planned_expense (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      amount INT NOT NULL,
      frequency TEXT NOT NULL,
      next_due_date DATE NOT NULL,
      attribution economia.attribution NOT NULL,
      category_id UUID NULL REFERENCES economia.category(id) ON DELETE SET NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS economia.piggy_bank (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      type TEXT NOT NULL, -- 'TWO_EURO' | 'NORMAL'
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (type)
    );

    CREATE TABLE IF NOT EXISTS economia.piggy_bank_entry (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      piggy_bank_id UUID NOT NULL REFERENCES economia.piggy_bank(id) ON DELETE CASCADE,
      date_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      amount INT NOT NULL,
      note TEXT NULL,
      month_id UUID NULL REFERENCES economia.month(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS economia.transaction (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      date_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      amount INT NOT NULL CHECK (amount > 0),
      direction TEXT NOT NULL CHECK (direction IN ('OUT','IN')),
      type economia.tx_type NOT NULL,

      month_id UUID NOT NULL REFERENCES economia.month(id) ON DELETE CASCADE,
      week_id UUID NULL REFERENCES economia.week(id) ON DELETE SET NULL,
      category_id UUID NULL REFERENCES economia.category(id) ON DELETE SET NULL,

      attribution economia.attribution NOT NULL,
      payment_method economia.payment_method NOT NULL,

      concept TEXT NULL,
      note TEXT NULL,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tx_month_date ON economia.transaction(month_id, date_time);
    CREATE INDEX IF NOT EXISTS idx_tx_type ON economia.transaction(type);
    CREATE INDEX IF NOT EXISTS idx_tx_category ON economia.transaction(category_id);
  `);

  // Seed categorías
  const categories = [
    "Alquiler",
    "Estudios",
    "Café",
    "Tabaco",
    "Farmacia",
    "Compra",
    "Bares",
    "Ocio",
    "Comida a domicilio",
    "Bebé",
    "Pádel",
    "Gasolina",
    "Extra",
  ];

  for (const name of categories) {
    await pool.query(
      `INSERT INTO economia.category (name) VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      [name]
    );
  }

  // Seed huchas
  await pool.query(
    `INSERT INTO economia.piggy_bank (name, type)
     VALUES ($1,$2)
     ON CONFLICT (type) DO NOTHING`,
    ["Hucha 2€", "TWO_EURO"]
  );

  await pool.query(
    `INSERT INTO economia.piggy_bank (name, type)
     VALUES ($1,$2)
     ON CONFLICT (type) DO NOTHING`,
    ["Hucha normal", "NORMAL"]
  );

  console.log("✅ Economia DB OK (tablas + seed)");
}

initDb().catch((err) => {
  console.error("❌ Error en initDb:", err);
  process.exit(1);
});

/* ===================== ROUTES ===================== */
app.get("/", (_req, res) => res.send("Economia API funcionando correctamente"));
app.get("/health", (_req, res) => res.json({ ok: true }));

/* ===================== CATEGORIES ===================== */
app.get("/categories", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, is_active, created_at
       FROM economia.category
       WHERE is_active = true
       ORDER BY name ASC`
    );
    res.json(rows);
  } catch (error) {
    console.error("❌ Error en GET /categories:", error);
    res.status(500).json({ error: "Error obteniendo categorías" });
  }
});

/* ===================== MONTHS ===================== */
app.get("/month/current", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM economia.month WHERE status='OPEN' ORDER BY created_at DESC LIMIT 1`
    );
    res.json(rows[0] || null);
  } catch (error) {
    console.error("❌ Error en GET /month/current:", error);
    res.status(500).json({ error: "Error obteniendo mes actual" });
  }
});

app.get("/week/current", async (_req, res) => {
  try {
    // Mes OPEN
    const m = await pool.query(
      `SELECT * FROM economia.month WHERE status='OPEN' ORDER BY created_at DESC LIMIT 1`
    );
    if (!m.rows.length) return res.json(null);

    const month = m.rows[0];

    // Semana donde hoy (CURRENT_DATE) está dentro del rango de la semana
    const w = await pool.query(
      `SELECT *
       FROM economia.week
       WHERE month_id = $1
         AND start_date <= CURRENT_DATE
         AND end_date >= CURRENT_DATE
       ORDER BY week_index ASC
       LIMIT 1`,
      [month.id]
    );

    // Si por lo que sea hoy no cae en ninguna (ej: start_date del mes no incluye hoy),
    // devolvemos la última semana creada del mes.
    if (!w.rows.length) {
      const fallback = await pool.query(
        `SELECT *
         FROM economia.week
         WHERE month_id = $1
         ORDER BY week_index DESC
         LIMIT 1`,
        [month.id]
      );
      return res.json(fallback.rows[0] || null);
    }

    res.json(w.rows[0]);
  } catch (error) {
    console.error("❌ Error en GET /week/current:", error);
    res.status(500).json({ error: "Error obteniendo semana actual" });
  }
});

app.get("/summary/current", async (_req, res) => {
  try {
    // Mes OPEN
    const m = await pool.query(
      `SELECT * FROM economia.month WHERE status='OPEN' ORDER BY created_at DESC LIMIT 1`
    );
    if (!m.rows.length) return res.json(null);

    const month = m.rows[0];

    // Semana actual
    const w = await pool.query(
      `SELECT *
       FROM economia.week
       WHERE month_id = $1
         AND start_date <= CURRENT_DATE
         AND end_date >= CURRENT_DATE
       ORDER BY week_index ASC
       LIMIT 1`,
      [month.id]
    );
    const week = w.rows[0] || null;

    // Totales del mes
    const totals = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN direction='OUT' AND type='EXPENSE' THEN amount ELSE 0 END),0)::int AS total_expenses,
         COALESCE(SUM(CASE WHEN direction='IN' AND type='EXTRA_INCOME' THEN amount ELSE 0 END),0)::int AS extra_income
       FROM economia.transaction
       WHERE month_id = $1`,
      [month.id]
    );

    const totalExpenses = totals.rows[0].total_expenses;
    const extraIncome = totals.rows[0].extra_income;

    const totalIncome = (month.income_amount || 0) + extraIncome;
    const remainingMonth = totalIncome - totalExpenses;

    // Gastado esta semana (si hay week)
    let weekSpent = 0;
    let remainingWeek = null;

    if (week) {
      const ws = await pool.query(
        `SELECT COALESCE(SUM(amount),0)::int AS week_spent
         FROM economia.transaction
         WHERE month_id=$1
           AND direction='OUT'
           AND type='EXPENSE'
           AND date_time::date >= $2::date
           AND date_time::date <= $3::date`,
        [month.id, week.start_date, week.end_date]
      );
      weekSpent = ws.rows[0].week_spent;
      remainingWeek = (month.weekly_budget_amount || 0) - weekSpent;
    }

    // Split por attribution (solo gastos EXPENSE)
    const split = await pool.query(
      `SELECT
         attribution,
         COALESCE(SUM(amount),0)::int AS total
       FROM economia.transaction
       WHERE month_id=$1
         AND direction='OUT'
         AND type='EXPENSE'
       GROUP BY attribution`,
      [month.id]
    );

    const byAttr = { MINE: 0, PARTNER: 0, HOUSE: 0 };
    for (const r of split.rows) {
      if (byAttr[r.attribution] !== undefined) byAttr[r.attribution] = r.total;
    }

    // Días restantes (incluyendo hoy)
    const daysLeftQ = await pool.query(
      `SELECT GREATEST(1, (economia.month.end_date - CURRENT_DATE + 1))::int AS days_left
       FROM economia.month
       WHERE id=$1`,
      [month.id]
    );
    const daysLeft = daysLeftQ.rows[0].days_left;
    const dailyPace = remainingMonth / daysLeft;

    res.json({
      month,
      week,
      totals: {
        totalIncome,
        extraIncome,
        totalExpenses,
        remainingMonth,
        weekSpent,
        remainingWeek,
        daysLeft,
        dailyPace,
        byAttr,
      },
    });
  } catch (error) {
    console.error("❌ Error en GET /summary/current:", error);
    res.status(500).json({ error: "Error obteniendo summary" });
  }
});



app.post("/month/start", async (req, res) => {
  const client = await pool.connect();
  try {
    const { incomeAmount, savingGoalAmount, weeklyBudgetAmount, startDate } = req.body;

    if (!incomeAmount || !savingGoalAmount || !weeklyBudgetAmount) {
      return res.status(400).json({
        error: "incomeAmount, savingGoalAmount y weeklyBudgetAmount son obligatorios",
      });
    }

    const open = await client.query(
      `SELECT id FROM economia.month WHERE status='OPEN' LIMIT 1`
    );
    if (open.rows.length) {
      return res.status(400).json({ error: "Ya existe un mes OPEN" });
    }

    const start = startDate ? new Date(startDate) : new Date();
    const periodKey = toPeriodKey(start);

    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);

    await client.query("BEGIN");

    const monthIns = await client.query(
      `INSERT INTO economia.month
        (period_key, start_date, end_date, income_amount, weekly_budget_amount, saving_goal_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,'OPEN')
       RETURNING *`,
      [
        periodKey,
        toDateOnly(start),
        toDateOnly(end),
        parseInt(incomeAmount, 10),
        parseInt(weeklyBudgetAmount, 10),
        parseInt(savingGoalAmount, 10),
      ]
    );

    const month = monthIns.rows[0];

    // Generar semanas lunes-domingo que intersecten con [start..end]
    let cursor = startOfWeekMonday(start);
    const endDate = new Date(end);
    endDate.setHours(0, 0, 0, 0);

    let weekIndex = 1;
    while (cursor <= endDate) {
      const wStart = cursor;
      const wEnd = addDays(wStart, 6);

      const rangeStart = new Date(start);
      rangeStart.setHours(0, 0, 0, 0);

      const realStart = wStart < rangeStart ? rangeStart : wStart;
      const realEnd = wEnd > endDate ? endDate : wEnd;

      await client.query(
        `INSERT INTO economia.week
          (month_id, week_index, start_date, end_date, cash_withdraw_amount, status)
         VALUES ($1,$2,$3,$4,$5,'OPEN')`,
        [
          month.id,
          weekIndex,
          toDateOnly(realStart),
          toDateOnly(realEnd),
          parseInt(weeklyBudgetAmount, 10),
        ]
      );

      weekIndex += 1;
      cursor = addDays(cursor, 7);
    }

    await client.query("COMMIT");
    res.json(month);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error en POST /month/start:", error);
    res.status(500).json({ error: "Error creando mes" });
  } finally {
    client.release();
  }
});

app.post("/month/close", async (req, res) => {
  const client = await pool.connect();
  try {
    const { monthId } = req.body;
    if (!monthId) return res.status(400).json({ error: "monthId es obligatorio" });

    await client.query("BEGIN");

    const m = await client.query(`SELECT * FROM economia.month WHERE id=$1`, [monthId]);
    if (!m.rows.length) return res.status(404).json({ error: "Mes no encontrado" });

    const month = m.rows[0];
    if (month.status !== "OPEN") return res.status(400).json({ error: "El mes no está OPEN" });

    const out = await client.query(
      `SELECT COALESCE(SUM(amount),0)::int AS total
       FROM economia.transaction
       WHERE month_id=$1 AND direction='OUT' AND type IN ('EXPENSE')`,
      [monthId]
    );

    const extra = await client.query(
      `SELECT COALESCE(SUM(amount),0)::int AS total
       FROM economia.transaction
       WHERE month_id=$1 AND direction='IN' AND type='EXTRA_INCOME'`,
      [monthId]
    );

    const totalIncome = month.income_amount + extra.rows[0].total;
    const remainder = totalIncome - out.rows[0].total;

    // A consolidar = todo lo que queda (si es positivo). Si queda 0 o negativo, 0.
    const toConsolidate = Math.max(0, remainder);

    if (toConsolidate > 0) {
      await client.query(
        `INSERT INTO economia.transaction
          (date_time, amount, direction, type, month_id, attribution, payment_method, concept, note)
         VALUES (NOW(), $1, 'IN', 'CONSOLIDATE_TO_SAFETY', $2, 'HOUSE', 'TRANSFER', 'Cierre de mes', 'Ahorro objetivo + sobrante')`,
        [toConsolidate, monthId]
      );
    }

    const closed = await client.query(
      `UPDATE economia.month
       SET status='CLOSED', closed_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [monthId]
    );

    await client.query("COMMIT");
    res.json({
      month: closed.rows[0],
      totals: {
        totalIncome,
        totalExpenses: out.rows[0].total,
        remainder,
        consolidated: toConsolidate,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error en POST /month/close:", error);
    res.status(500).json({ error: "Error cerrando mes" });
  } finally {
    client.release();
  }
});

/* ===================== WEEKS ===================== */
app.post("/weeks/:id/cash-return", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { amount } = req.body;

    if (!amount) return res.status(400).json({ error: "amount es obligatorio" });

    await client.query("BEGIN");

    const w = await client.query(`SELECT * FROM economia.week WHERE id=$1`, [id]);
    if (!w.rows.length) return res.status(404).json({ error: "Semana no encontrada" });

    const week = w.rows[0];

    const up = await client.query(
      `UPDATE economia.week
       SET cash_returned_to_bank_amount = cash_returned_to_bank_amount + $1
       WHERE id=$2
       RETURNING *`,
      [parseInt(amount, 10), id]
    );

    await client.query(
      `INSERT INTO economia.transaction
        (date_time, amount, direction, type, month_id, week_id, attribution, payment_method, concept, note)
       VALUES (NOW(), $1, 'IN', 'CASH_RETURN', $2, $3, 'HOUSE', 'CASH', 'Devolver billetes', NULL)`,
      [parseInt(amount, 10), week.month_id, id]
    );

    await client.query("COMMIT");
    res.json(up.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error en POST /weeks/:id/cash-return:", error);
    res.status(500).json({ error: "Error devolviendo efectivo al banco" });
  } finally {
    client.release();
  }
});

/* ===================== TRANSACTIONS ===================== */
app.post("/transactions", async (req, res) => {
  try {
    const {
      date_time,
      amount,
      type,
      direction,
      month_id,
      week_id,
      category_id,
      attribution,
      payment_method,
      concept,
      note,
    } = req.body;

    const amountCents = parseMoneyToCents(amount);

    if (!amountCents || amountCents <= 0 || !month_id || !attribution || !payment_method) {
      return res.status(400).json({
        error: "amount, month_id, attribution y payment_method son obligatorios (amount válido)",
      });
    }

    const finalType = type || "EXPENSE";
    const finalDirection = direction || (finalType === "EXTRA_INCOME" ? "IN" : "OUT");

    if (finalType === "EXPENSE" && !category_id) {
      return res.status(400).json({
        error: "category_id es obligatorio cuando type=EXPENSE",
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO economia.transaction
        (date_time, amount, direction, type, month_id, week_id, category_id, attribution, payment_method, concept, note)
       VALUES
        (COALESCE($1, NOW()), $2, $3, $4::economia.tx_type, $5, $6, $7, $8::economia.attribution, $9::economia.payment_method, $10, $11)
       RETURNING
         *,
         (amount / 100.0) AS amount_eur`,
      [
        date_time || null,
        amountCents,
        finalDirection,
        finalType,
        month_id,
        week_id || null,
        category_id || null,
        attribution,
        payment_method,
        concept && String(concept).trim() ? String(concept).trim() : null,
        note || null,
      ]
    );

    res.json(rows[0]);
  } catch (error) {
    console.error("❌ Error en POST /transactions:", error);
    res.status(500).json({ error: "Error creando transacción" });
  }
});


app.get("/transactions", async (req, res) => {
  try {
    const { monthId } = req.query;
    if (!monthId) return res.status(400).json({ error: "monthId es obligatorio" });

    const { rows } = await pool.query(
      `SELECT
         t.*,
         (t.amount / 100.0) AS amount_eur,
         c.name AS category_name
       FROM economia.transaction t
       LEFT JOIN economia.category c ON c.id = t.category_id
       WHERE t.month_id = $1
       ORDER BY t.date_time DESC`,
      [String(monthId)]
    );

    res.json(rows);
  } catch (error) {
    console.error("❌ Error en GET /transactions:", error);
    res.status(500).json({ error: "Error obteniendo transacciones" });
  }
});


/* ===== NUEVO: GET/PUT/DELETE para editar/borrar ===== */
app.get("/transactions/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `SELECT
         t.*,
         (t.amount / 100.0) AS amount_eur,
         c.name AS category_name
       FROM economia.transaction t
       LEFT JOIN economia.category c ON c.id = t.category_id
       WHERE t.id = $1
       LIMIT 1`,
      [id]
    );

    if (!rows.length) return res.status(404).json({ error: "Movimiento no encontrado" });

    res.json(rows[0]);
  } catch (error) {
    console.error("❌ Error en GET /transactions/:id:", error);
    res.status(500).json({ error: "Error obteniendo movimiento" });
  }
});


app.put("/transactions/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      date_time,
      amount,
      category_id,
      attribution,
      payment_method,
      concept,
      note,
    } = req.body;

    const amountCents = parseMoneyToCents(amount);

    if (!amountCents || amountCents <= 0 || !attribution || !payment_method) {
      return res.status(400).json({
        error: "amount, attribution y payment_method son obligatorios (amount válido)",
      });
    }

    const { rows } = await pool.query(
      `UPDATE economia.transaction
       SET
         date_time = COALESCE($1, date_time),
         amount = $2,
         category_id = $3,
         attribution = $4::economia.attribution,
         payment_method = $5::economia.payment_method,
         concept = $6,
         note = $7
       WHERE id = $8
       RETURNING
         *,
         (amount / 100.0) AS amount_eur`,
      [
        date_time || null,
        amountCents,
        category_id || null,
        attribution,
        payment_method,
        concept && String(concept).trim() ? String(concept).trim() : null,
        note || null,
        id,
      ]
    );

    if (!rows.length) return res.status(404).json({ error: "Movimiento no encontrado" });

    res.json(rows[0]);
  } catch (error) {
    console.error("❌ Error en PUT /transactions/:id:", error);
    res.status(500).json({ error: "Error editando movimiento" });
  }
});


app.delete("/transactions/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const r = await pool.query(
      `DELETE FROM economia.transaction WHERE id=$1 RETURNING id`,
      [id]
    );

    if (!r.rows.length) return res.status(404).json({ error: "Movimiento no encontrado" });
    res.json({ ok: true });
  } catch (error) {
    console.error("❌ Error en DELETE /transactions/:id:", error);
    res.status(500).json({ error: "Error borrando movimiento" });
  }
});

/* ===================== PIGGYBANKS ===================== */
app.get("/piggybanks", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM economia.piggy_bank ORDER BY type ASC`
    );
    res.json(rows);
  } catch (error) {
    console.error("❌ Error en GET /piggybanks:", error);
    res.status(500).json({ error: "Error obteniendo huchas" });
  }
});

app.post("/piggybanks/:id/entries", async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, note, month_id } = req.body;
    if (!amount) return res.status(400).json({ error: "amount es obligatorio" });

    const { rows } = await pool.query(
      `INSERT INTO economia.piggy_bank_entry (piggy_bank_id, amount, note, month_id)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [id, parseInt(amount, 10), note || null, month_id || null]
    );

    // Opcional: registrar también como transacción (tracking)
    if (month_id) {
      await pool.query(
        `INSERT INTO economia.transaction
          (date_time, amount, direction, type, month_id, attribution, payment_method, concept, note)
         VALUES (NOW(), $1, 'OUT', 'PIGGYBANK_DEPOSIT', $2, 'HOUSE', 'CASH', 'Aporte hucha', $3)`,
        [parseInt(amount, 10), month_id, note || null]
      );
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("❌ Error en POST /piggybanks/:id/entries:", error);
    res.status(500).json({ error: "Error creando entrada en hucha" });
  }
});

/* ===================== SAFETY FUND ===================== */
app.get("/safety/balance", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type='CONSOLIDATE_TO_SAFETY' THEN amount ELSE 0 END),0)::int
         - COALESCE(SUM(CASE WHEN type='EMERGENCY_FROM_SAFETY' THEN amount ELSE 0 END),0)::int
         AS balance
       FROM economia.transaction`
    );
    res.json({ balance: rows[0].balance });
  } catch (error) {
    console.error("❌ Error en GET /safety/balance:", error);
    res.status(500).json({ error: "Error calculando fondo de seguridad" });
  }
});

app.post("/safety/emergency", async (req, res) => {
  try {
    const { month_id, amount, note } = req.body;
    if (!month_id || !amount || !note) {
      return res.status(400).json({ error: "month_id, amount y note son obligatorios" });
    }

    const { rows } = await pool.query(
      `INSERT INTO economia.transaction
        (date_time, amount, direction, type, month_id, attribution, payment_method, concept, note)
       VALUES (NOW(), $1, 'OUT', 'EMERGENCY_FROM_SAFETY', $2, 'HOUSE', 'TRANSFER', 'Imprevisto', $3)
       RETURNING *`,
      [parseInt(amount, 10), month_id, note]
    );

    res.json(rows[0]);
  } catch (error) {
    console.error("❌ Error en POST /safety/emergency:", error);
    res.status(500).json({ error: "Error usando fondo de seguridad" });
  }
});

app.get("/safety/history", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);

    const { rows } = await pool.query(
      `SELECT
         id,
         date_time,
         amount,
         direction,
         type,
         month_id,
         concept,
         note
       FROM economia.transaction
       WHERE type IN ('CONSOLIDATE_TO_SAFETY','EMERGENCY_FROM_SAFETY')
       ORDER BY date_time DESC
       LIMIT $1`,
      [limit]
    );

    res.json(rows);
  } catch (error) {
    console.error("❌ Error en GET /safety/history:", error);
    res.status(500).json({ error: "Error obteniendo histórico del fondo" });
  }
});

/* ===================== BORRAR MESES ===================== */

app.delete("/month/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    // Comprueba que existe
    const m = await client.query(`SELECT * FROM economia.month WHERE id=$1`, [id]);
    if (!m.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Mes no encontrado" });
    }

    // Borra el mes:
    // - weeks se borran por ON DELETE CASCADE
    // - transactions del mes se borran por ON DELETE CASCADE
    // - piggy_bank_entry month_id pasa a NULL por ON DELETE SET NULL
    await client.query(`DELETE FROM economia.month WHERE id=$1`, [id]);

    await client.query("COMMIT");

    res.json({ ok: true, deletedMonthId: id });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error en DELETE /month/:id:", error);
    res.status(500).json({ error: "Error borrando el mes" });
  } finally {
    client.release();
  }
});

app.get("/months", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         id,
         period_key,
         start_date,
         end_date,
         income_amount,
         weekly_budget_amount,
         saving_goal_amount,
         status,
         created_at,
         closed_at
       FROM economia.month
       ORDER BY start_date DESC`
    );
    res.json(rows);
  } catch (error) {
    console.error("❌ Error en GET /months:", error);
    res.status(500).json({ error: "Error obteniendo meses" });
  }
});

app.put("/month/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { incomeAmount, savingGoalAmount, weeklyBudgetAmount } = req.body;

    // al menos uno debe venir
    if (
      incomeAmount === undefined &&
      savingGoalAmount === undefined &&
      weeklyBudgetAmount === undefined
    ) {
      return res.status(400).json({
        error: "Debes enviar incomeAmount, savingGoalAmount o weeklyBudgetAmount (al menos uno).",
      });
    }

    await client.query("BEGIN");

    const m = await client.query(`SELECT * FROM economia.month WHERE id=$1`, [id]);
    if (!m.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Mes no encontrado" });
    }

    const month = m.rows[0];

    // No bloqueamos por status: puedes corregir incluso CLOSED si quieres.
    // Si prefieres bloquear CLOSED, dímelo y lo hacemos.

    const newIncome =
      incomeAmount === undefined ? month.income_amount : parseInt(incomeAmount, 10);
    const newSaving =
      savingGoalAmount === undefined ? month.saving_goal_amount : parseInt(savingGoalAmount, 10);
    const newWeekly =
      weeklyBudgetAmount === undefined ? month.weekly_budget_amount : parseInt(weeklyBudgetAmount, 10);

    if (!Number.isFinite(newIncome) || newIncome < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "incomeAmount inválido" });
    }
    if (!Number.isFinite(newSaving) || newSaving < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "savingGoalAmount inválido" });
    }
    if (!Number.isFinite(newWeekly) || newWeekly < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "weeklyBudgetAmount inválido" });
    }

    const up = await client.query(
      `UPDATE economia.month
       SET income_amount=$1,
           saving_goal_amount=$2,
           weekly_budget_amount=$3
       WHERE id=$4
       RETURNING *`,
      [newIncome, newSaving, newWeekly, id]
    );

    // Si cambia el weekly budget, actualiza semanas OPEN (no tocamos las CLOSED)
    if (weeklyBudgetAmount !== undefined && newWeekly !== month.weekly_budget_amount) {
      await client.query(
        `UPDATE economia.week
         SET cash_withdraw_amount=$1
         WHERE month_id=$2 AND status='OPEN'`,
        [newWeekly, id]
      );
    }

    await client.query("COMMIT");
    res.json(up.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error en PUT /month/:id:", error);
    res.status(500).json({ error: "Error actualizando el mes" });
  } finally {
    client.release();
  }
});

/* =====================  HUCHAS ===================== */

app.get("/piggybanks/summary", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.type,
        COALESCE(SUM(e.amount), 0)::int AS balance,
        COUNT(e.id)::int AS entries_count,
        MAX(e.date_time) AS last_entry_at
      FROM economia.piggy_bank p
      LEFT JOIN economia.piggy_bank_entry e ON e.piggy_bank_id = p.id
      GROUP BY p.id, p.name, p.type
      ORDER BY p.type ASC
    `);

    res.json(rows);
  } catch (error) {
    console.error("❌ Error en GET /piggybanks/summary:", error);
    res.status(500).json({ error: "Error obteniendo resumen de huchas" });
  }
});

app.get("/piggybanks/:id/entries", async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `SELECT *
       FROM economia.piggy_bank_entry
       WHERE piggy_bank_id = $1
       ORDER BY date_time DESC`,
      [id]
    );

    res.json(rows);
  } catch (error) {
    console.error("❌ Error en GET /piggybanks/:id/entries:", error);
    res.status(500).json({ error: "Error obteniendo entradas de la hucha" });
  }
});



/* ===================== BOOT ===================== */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Servidor corriendo en puerto ${PORT}`));
