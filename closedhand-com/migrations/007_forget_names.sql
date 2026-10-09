-- A Closedhand account keeps only the sign-in's email, linked to its personal
-- URL. Names were saved from the sign-in but never used: forget them all.
ALTER TABLE owners DROP COLUMN IF EXISTS name;
