-- 056_reminder_event_time.sql: a reminder keeps the time of the thing it is
-- about, apart from when it fires.
--
-- "Remind me before my 9am dentist appointment" fires at 07:30, and that
-- was the only time a reminder had, so the dashboard showed the appointment
-- at 07:30. event_at is the moment of the event itself, when there is one;
-- Upcoming shows it, with the reminder's own time beside it.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS event_at timestamptz;
