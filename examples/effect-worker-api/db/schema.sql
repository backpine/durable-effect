-- The ledger example's tables, applied by `scripts/postgres.mjs up`. Every amount is whole cents in an `integer`, and
-- every count the app reads is cast to `int`, so no value arrives as a bigint.

CREATE TABLE ledger_batch (
  batch_id     text PRIMARY KEY,
  mode         text NOT NULL CHECK (mode IN ('instance', 'invocation')),
  status       text NOT NULL CHECK (status IN ('open', 'settled')),
  entry_count  integer NOT NULL CHECK (entry_count > 0),
  posted_count integer NOT NULL DEFAULT 0 CHECK (posted_count >= 0 AND posted_count <= entry_count),
  total_cents  integer NOT NULL,
  steps        integer NOT NULL DEFAULT 0,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  settled_at   timestamptz
);

CREATE TABLE ledger_entry (
  batch_id     text NOT NULL REFERENCES ledger_batch (batch_id) ON DELETE CASCADE,
  seq          integer NOT NULL CHECK (seq > 0),
  account      text NOT NULL,
  amount_cents integer NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted')),
  PRIMARY KEY (batch_id, seq)
);

CREATE INDEX ledger_entry_pending_idx ON ledger_entry (batch_id, seq) WHERE status = 'pending';

CREATE TABLE account_balance (
  account       text PRIMARY KEY,
  balance_cents integer NOT NULL,
  postings      integer NOT NULL
);

-- One row per thing a task hook did, written inside that hook's transaction:
-- a rolled-back hook leaves no row.
CREATE TABLE ledger_audit (
  id       bigserial PRIMARY KEY,
  batch_id text NOT NULL,
  hook     text NOT NULL,
  detail   text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_audit_batch_idx ON ledger_audit (batch_id, id);
