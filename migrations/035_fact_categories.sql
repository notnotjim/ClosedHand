-- 035_fact_categories.sql — group saved notes instead of one flat list.
--
-- Every fact sat in one namespace, so `family-wife-saya` was a sibling of
-- `no-strings-eori`, and the only grouping was whatever the model chose to put
-- in the key string. Two things follow from a real category. Context Brain can
-- show the notes grouped rather than as one long list, and "is there already a
-- note about this person?" becomes a lookup on (category, subject) instead of
-- a judgement the model has to make from a paragraph of tool description.
--
-- Additive and nullable: an existing row without a category still reads and
-- writes exactly as before, and anything unclassified is shown as 'topic'.

alter table facts add column if not exists category text;
alter table facts add column if not exists subject text;

-- The five the assistant may use. Deliberately short: a long list means the
-- model picks a different one for the same thing on different days, which is
-- the flat namespace again wearing a category's clothes.
--   person     someone in the user's life: family, colleagues, customers
--   business   a company, product or project the user runs or works on
--   profile    who the user is: where they live, key dates, circumstances
--   preference how the user wants ClosedHand to behave
--   topic      anything durable that is none of the above (the fallback)
alter table facts drop constraint if exists facts_category_check;
alter table facts add constraint facts_category_check
  check (category is null or category in ('person', 'business', 'profile', 'preference', 'topic'));

-- Grouping the dashboard list, and finding an existing note for a subject.
create index if not exists idx_facts_user_category on facts(user_id, category);
create index if not exists idx_facts_user_subject on facts(user_id, lower(subject));
