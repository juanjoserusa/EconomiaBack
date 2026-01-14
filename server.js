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
// Devuelve el mes OPEN (si existe)
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

// Crear mes (income, savingGoal, weeklyBudget) + genera semanas
app.post("/month/start", async (req, res) => {
  const client = await pool.connect();
  try {
    const { incomeAmount, savingGoalAmount, weeklyBudgetAmount, startDate } = req.body;

    if (!incomeAmount || !savingGoalAmount || !weeklyBudgetAmount) {
      return res.status(400).json({
        error: "incomeAmount, savingGoalAmount y weeklyBudgetAmount son obligatorios",
      });
    }

    // Si ya hay un mes OPEN, no creamos otro
    const open = await client.query(
      `SELECT id FROM economia.month WHERE status='OPEN' LIMIT 1`
    );
    if (open.rows.length) {
      return res.status(400).json({ error: "Ya existe un mes OPEN" });
    }

    // startDate opcional (por defecto hoy)
    const start = startDate ? new Date(startDate) : new Date();
    const periodKey = toPeriodKey(start);

    // endDate = último día de ese mes calendario
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

      // Intersección con el rango del mes (start..end)
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

// Cerrar mes: consolida ahorro (savingGoal + sobrante) y marca CLOSED
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

    // Total gastos OUT (EXPENSE y pagos varios que sean OUT)
    const out = await client.query(
      `SELECT COALESCE(SUM(amount),0)::int AS total
       FROM economia.transaction
       WHERE month_id=$1 AND direction='OUT' AND type IN ('EXPENSE')`,
      [monthId]
    );

    // Total ingresos extra (IN, EXTRA_INCOME)
    const extra = await client.query(
      `SELECT COALESCE(SUM(amount),0)::int AS total
       FROM economia.transaction
       WHERE month_id=$1 AND direction='IN' AND type='EXTRA_INCOME'`,
      [monthId]
    );

    // Ingreso base + extras
    const totalIncome = month.income_amount + extra.rows[0].total;

    // Disponible tras gastos
    const remainder = totalIncome - out.rows[0].total;

    // A consolidar = saving goal + (resto - saving goal si hay)
    // Si remainder < savingGoal => consolidamos lo que se pueda (sin negativo)
    const toConsolidate = Math.max(0, Math.min(remainder, month.saving_goal_amount) + Math.max(0, remainder - month.saving_goal_amount));

    // Insert tx consolidate (si hay)
    if (toConsolidate > 0) {
      await client.query(
        `INSERT INTO economia.transaction
          (date_time, amount, direction, type, month_id, attribution, payment_method, concept, note)
         VALUES (NOW(), $1, 'IN', 'CONSOLIDATE_TO_SAFETY', $2, 'HOUSE', 'TRANSFER', 'Cierre de mes', 'Ahorro objetivo + sobrante')`,
        [toConsolidate, monthId]
      );
    }

    // Cerrar mes
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
// Devolver billetes al banco (cash return) + registra transacción
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

    // suma al acumulado de devuelto a banco
    const up = await client.query(
      `UPDATE economia.week
       SET cash_returned_to_bank_amount = cash_returned_to_bank_amount + $1
       WHERE id=$2
       RETURNING *`,
      [parseInt(amount, 10), id]
    );

    // registra transacción CASH_RETURN (no es ingreso real)
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

    if (!amount || !month_id || !attribution || !payment_method) {
      return res.status(400).json({
        error: "amount, month_id, attribution y payment_method son obligatorios",
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
       RETURNING *`,
      [
        date_time || null,
        parseInt(amount, 10),
        finalDirection,
        finalType,
        month_id,
        week_id || null,
        category_id || null,
        attribution,
        payment_method,
        concept || null,
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
    if (!monthId) {
      return res.status(400).json({ error: "monthId es obligatorio" });
    }

    const { rows } = await pool.query(
      `SELECT
         t.*,
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

    // opcional: registrar también como transacción (tracking)
    // (si no lo quieres, quítalo)
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
         + COALESCE(SUM(CASE WHEN type='EXTRA_INCOME' THEN amount ELSE 0 END),0)::int
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

// Usar fondo de seguridad (mover a operativo)
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

/* ===================== BOOT ===================== */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Servidor corriendo en puerto ${PORT}`));
