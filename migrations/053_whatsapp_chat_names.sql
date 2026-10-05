-- 053_whatsapp_chat_names.sql: give stored WhatsApp chats their names.
--
-- Live messages were stored with no chat names, so most chats were filed
-- under a number ("24134042030322") and recall lost the words that say who
-- the chat is with. This names every numbered chat from what the stored rows
-- already know: a real name any row of the chat carries (contact book,
-- group subject), or else, in a one-to-one chat, the name the other person or
-- business gives themselves on their own messages. It returns each chat's
-- name, so the hourly digest can rename the day summaries it wrote earlier.
-- Safe to run again: a named row is left alone.

CREATE OR REPLACE FUNCTION name_whatsapp_chats(match_user_id uuid)
RETURNS TABLE(chat text, name text)
LANGUAGE sql AS $fn$
  WITH names AS (
    SELECT DISTINCT ON (c.chat) c.chat, c.name FROM (
      SELECT dc.data->>'chat' AS chat, dc.data->>'chat_name' AS name, 1 AS pref, dc.received_at
        FROM data_cache dc
       WHERE dc.user_id = match_user_id AND dc.source = 'whatsapp'
         AND coalesce(dc.data->>'chat_name', '') !~ '^[0-9+() -]*$'
      UNION ALL
      SELECT dc.data->>'chat', dc.data->>'sender', 2, dc.received_at
        FROM data_cache dc
       WHERE dc.user_id = match_user_id AND dc.source = 'whatsapp'
         AND dc.data->>'chat' NOT LIKE '%@g.us'
         AND dc.data->>'sender' <> 'me'
         AND coalesce(dc.data->>'sender', '') !~ '^[0-9+() -]*$'
    ) c
    WHERE c.chat IS NOT NULL
    ORDER BY c.chat, c.pref, c.received_at DESC NULLS LAST
  ), renamed AS (
    -- Runs whether or not anything reads it, as every data-changing WITH does.
    UPDATE data_cache dc
       SET data = jsonb_set(dc.data, '{chat_name}', to_jsonb(n.name))
      FROM names n
     WHERE dc.user_id = match_user_id AND dc.source = 'whatsapp'
       AND dc.data->>'chat' = n.chat
       AND coalesce(dc.data->>'chat_name', '') ~ '^[0-9+() -]*$'
    RETURNING 1
  )
  SELECT n.chat, n.name FROM names n;
$fn$;
