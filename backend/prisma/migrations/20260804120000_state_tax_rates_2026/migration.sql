-- Refresh the built-in state sales-tax list to the Tax Foundation's 2026 figures, as of
-- 2026-01-01 -- https://taxfoundation.org/data/all/state/sales-tax-rates/
--
-- COLUMN TAKEN: "Combined State & Average Local Sales Tax Rate", NOT the bare state rate
-- (Ran's call, 2026-08-04: "take the highest value, i.e. 8.54% for NY"). The old values here
-- were the state-only column, so almost every row moves - e.g. NY 4.00% -> 8.54%,
-- LA 4.45% -> 10.11%, AK 0.00% -> 1.82%, TN 7.00% -> 9.61%.
--
-- NJ is the one row where "combined" is LOWER than the state rate (6.625% -> 6.60%): its
-- Urban Enterprise Zones charge half rate, which drags the local average negative.
--
-- These are AVERAGES of local rates, so no row is the legally exact rate for any one address.
-- An org that needs its true combined rate defines a custom org rate (org_tax_rates).
--
-- Every row is re-asserted so this file is the single statement of record for the table and
-- stays correct against a DB that was never seeded. INSERT ... ON CONFLICT DO UPDATE, so it
-- is idempotent and safe to re-apply.
INSERT INTO state_tax_rates (state_code, state_name, tax_rate) VALUES
  ('AL', 'Alabama',              0.09460),
  ('AK', 'Alaska',               0.01820),
  ('AZ', 'Arizona',              0.08520),
  ('AR', 'Arkansas',             0.09460),
  ('CA', 'California',           0.08990),
  ('CO', 'Colorado',             0.07890),
  ('CT', 'Connecticut',          0.06350),
  ('DE', 'Delaware',             0.00000),
  ('DC', 'District of Columbia', 0.06000),
  ('FL', 'Florida',              0.06980),
  ('GA', 'Georgia',              0.07490),
  ('HI', 'Hawaii',               0.04500),
  ('ID', 'Idaho',                0.06030),
  ('IL', 'Illinois',             0.08960),
  ('IN', 'Indiana',              0.07000),
  ('IA', 'Iowa',                 0.06940),
  ('KS', 'Kansas',               0.08690),
  ('KY', 'Kentucky',             0.06000),
  ('LA', 'Louisiana',            0.10110),
  ('ME', 'Maine',                0.05500),
  ('MD', 'Maryland',             0.06000),
  ('MA', 'Massachusetts',        0.06250),
  ('MI', 'Michigan',             0.06000),
  ('MN', 'Minnesota',            0.08140),
  ('MS', 'Mississippi',          0.07060),
  ('MO', 'Missouri',             0.08440),
  ('MT', 'Montana',              0.00000),
  ('NE', 'Nebraska',             0.06980),
  ('NV', 'Nevada',               0.08240),
  ('NH', 'New Hampshire',        0.00000),
  ('NJ', 'New Jersey',           0.06600),
  ('NM', 'New Mexico',           0.07670),
  ('NY', 'New York',             0.08540),
  ('NC', 'North Carolina',       0.07000),
  ('ND', 'North Dakota',         0.07090),
  ('OH', 'Ohio',                 0.07290),
  ('OK', 'Oklahoma',             0.09060),
  ('OR', 'Oregon',               0.00000),
  ('PA', 'Pennsylvania',         0.06340),
  ('RI', 'Rhode Island',         0.07000),
  ('SC', 'South Carolina',       0.07490),
  ('SD', 'South Dakota',         0.06110),
  ('TN', 'Tennessee',            0.09610),
  ('TX', 'Texas',                0.08200),
  ('UT', 'Utah',                 0.07420),
  ('VT', 'Vermont',              0.06390),
  ('VA', 'Virginia',             0.05770),
  ('WA', 'Washington',           0.09510),
  ('WV', 'West Virginia',        0.06590),
  ('WI', 'Wisconsin',            0.05720),
  ('WY', 'Wyoming',              0.05560)
ON CONFLICT (state_code) DO UPDATE
  SET state_name = EXCLUDED.state_name,
      tax_rate   = EXCLUDED.tax_rate;
