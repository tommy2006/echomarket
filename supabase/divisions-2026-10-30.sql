-- Echo divisions, 30 October 2026: Proxima is now Lior, Uzuri is the tenth division, new display order.
-- Run once in Supabase → SQL Editor. Safe to run again.
--
-- Proxima → Lior: the division row is renamed, which renames it on every airline profile automatically
-- (airlines.alliance follows it). Orders keep a copy of the alliance names, so they are updated here too, so
-- the statistics and order cards show Lior. Old Discord posts and timeline messages keep the old name.
begin;

update public.alliances set name = 'Lior' where name = 'Proxima'
    and not exists (select 1 from public.alliances where name = 'Lior');

insert into public.alliances (name, sort_order) values
    ('Kyra', 1), ('Aegis', 2), ('Elysium', 3), ('Lior', 4), ('Rhea', 5),
    ('Vilis', 6), ('Elion', 7), ('Aura', 8), ('Eos', 9), ('Uzuri', 10)
on conflict (name) do update set sort_order = excluded.sort_order;

-- Orders: the buyer's alliance, the seller's alliance, and the copies inside the JSON lists.
update public.orders set alliance = 'Lior' where alliance = 'Proxima';
update public.orders set seller_alliance = 'Lior' where seller_alliance = 'Proxima';
update public.orders o set airlines = (
    select jsonb_agg(case when e->>'alliance' = 'Proxima' then jsonb_set(e, '{alliance}', '"Lior"') else e end order by n)
    from jsonb_array_elements(o.airlines) with ordinality as x(e, n))
where o.airlines @> '[{"alliance": "Proxima"}]';
update public.orders o set helpers = (
    select jsonb_agg(case when e->>'seller_alliance' = 'Proxima' then jsonb_set(e, '{seller_alliance}', '"Lior"') else e end order by n)
    from jsonb_array_elements(o.helpers) with ordinality as x(e, n))
where o.helpers @> '[{"seller_alliance": "Proxima"}]';
update public.orders o set previous_sellers = (
    select jsonb_agg(case when e->>'seller_alliance' = 'Proxima' then jsonb_set(e, '{seller_alliance}', '"Lior"') else e end order by n)
    from jsonb_array_elements(o.previous_sellers) with ordinality as x(e, n))
where o.previous_sellers @> '[{"seller_alliance": "Proxima"}]';

commit;

-- Check: the ten divisions in order, and nothing left called Proxima (all zeros).
select (select string_agg(name, ', ' order by sort_order) from public.alliances) as divisions,
       (select count(*) from public.airlines where alliance = 'Proxima') as airlines_left,
       (select count(*) from public.orders where alliance = 'Proxima' or seller_alliance = 'Proxima'
            or airlines @> '[{"alliance": "Proxima"}]' or helpers @> '[{"seller_alliance": "Proxima"}]'
            or previous_sellers @> '[{"seller_alliance": "Proxima"}]') as orders_left;
