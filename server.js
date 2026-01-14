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

/* ===================== INIT DB ===================== */
async function initDb() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS economia;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;


    -- ======= ENUMS (si ya existen, no falla por IF NOT EXISTS usando DO $$) =======
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

    -- ======= TABLES =======

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
      frequency TEXT NOT NULL, -- 'YEARLY' | 'QUARTERLY' | 'CUSTOM'
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

      concept TEXT NULL,   -- ✅ tu “concepto” opcional (leche, pañales, regalo...)
      note TEXT NULL,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tx_month_date ON economia.transaction(month_id, date_time);
    CREATE INDEX IF NOT EXISTS idx_tx_type ON economia.transaction(type);
    CREATE INDEX IF NOT EXISTS idx_tx_category ON economia.transaction(category_id);
  `);

  // ======= Seed categorías (si no existen) =======
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

  // ======= Seed huchas (2€ y normal) =======
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

/* ===================== BOOT ===================== */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Servidor corriendo en puerto ${PORT}`));
