-- Migration: 001_create_acquisitions
-- Creates the core acquisitions table and supporting indexes for the
-- Who-Is-Buying-What M&A intelligence pipeline.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS acquisitions (
  -- Identity
  id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint               TEXT          UNIQUE NOT NULL,
  accession_number          TEXT          NOT NULL,
  source_filings            TEXT[]        NOT NULL DEFAULT '{}',

  -- Acquirer
  acquirer                  TEXT          NOT NULL,
  acquirer_ticker           TEXT,
  acquirer_market_cap       BIGINT,

  -- Target
  target                    TEXT          NOT NULL,
  target_ticker             TEXT,
  target_market_cap         BIGINT,
  target_is_private         BOOLEAN       NOT NULL DEFAULT FALSE,

  -- Transaction
  transaction_value_usd     BIGINT,
  transaction_value_raw     TEXT,
  payment_type              TEXT,
  deal_size_category        TEXT,

  -- Analysis
  executive_summary         TEXT,
  classification_confidence FLOAT,
  extraction_confidence     FLOAT,
  corroboration_url         TEXT,
  flags                     TEXT[]        NOT NULL DEFAULT '{}',
  requires_review           BOOLEAN       NOT NULL DEFAULT FALSE,

  -- Filing timestamps
  filed_at                  TIMESTAMPTZ   NOT NULL,
  amended_at                TIMESTAMPTZ,
  amendment_count           INT           NOT NULL DEFAULT 0,

  -- Record lifecycle
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Index on filed_at: supports time-range queries ("deals from last 30 days")
CREATE INDEX IF NOT EXISTS idx_acquisitions_filed_at
  ON acquisitions (filed_at DESC);

-- Index on transaction_value_usd: supports threshold alerts and sorting by deal size
CREATE INDEX IF NOT EXISTS idx_acquisitions_value_usd
  ON acquisitions (transaction_value_usd DESC NULLS LAST);

-- Index on acquirer: supports per-company history lookups and cooldown checks
CREATE INDEX IF NOT EXISTS idx_acquisitions_acquirer
  ON acquisitions (acquirer);

-- The fingerprint column already has a UNIQUE constraint (implicit B-tree index);
-- a named index makes pg_indexes queries readable and allows explicit DROP INDEX.
CREATE INDEX IF NOT EXISTS idx_acquisitions_fingerprint
  ON acquisitions (fingerprint);

-- Trigger: keep updated_at current on every UPDATE without application changes
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_acquisitions_updated_at ON acquisitions;
CREATE TRIGGER trg_acquisitions_updated_at
  BEFORE UPDATE ON acquisitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
