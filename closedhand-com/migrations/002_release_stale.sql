-- When an address first worked. A reservation that never works within a day
-- is released, so names cannot be held without being used; an address that
-- did work stays owned even after removal, so an old bookmark can never lead
-- to somebody else's computer.
ALTER TABLE addresses ADD COLUMN activated_at timestamptz;
UPDATE addresses SET activated_at = updated_at WHERE state = 'active';
