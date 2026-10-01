-- 042_schedules_platform.sql — a schedule remembers which chat app it was set up in.
--
-- Delivery used to be inferred from the chat id at boot, which works for a
-- Telegram or WhatsApp chat and fails for the web chat (its id is the user's
-- own), falling back to Telegram on installs that have none. Store it.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS platform text;
