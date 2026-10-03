-- Matches and the players in them, replacing match_results.
--
-- Three tables:
--
--   profiles       who a signed-in player is            (one row per account)
--   matches        what happened in a game              (one row per game)
--   match_players  how each seat did in that game       (one row per seat)
--
-- Every seat gets a row — accounts, guests and bots — so a game can be told
-- in full: who beat whom, head-to-head records, replays later. Only games with
-- at least one signed-in player are stored; all-guest games never reach here.
--
-- Built to change without breaking:
--
--   - Core numbers are real columns, with checks, because stats and rankings
--     depend on them. `matches.details`, `match_players.stats` and
--     `profiles.settings` are JSON objects for anything experimental; promote a
--     key to a column once something filters or ranks by it.
--   - `matches.ruleset` records which version of the rules a game was played
--     under, so a rule change never muddles the numbers.
--   - Browsers and the game server never touch these tables directly. They go
--     through the functions at the bottom, so the tables can be reshaped
--     behind them without a client release.

-- ---------------------------------------------------------------------------
-- Retire the first design. Both were empty when this ran.
-- ---------------------------------------------------------------------------

drop function if exists public.my_profile_summary();
drop table if exists public.match_results;

-- ---------------------------------------------------------------------------
-- profiles: room for preferences, and a last-changed time
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column settings jsonb not null default '{}'::jsonb
    check (jsonb_typeof(settings) = 'object'),
  add column updated_at timestamptz not null default now();

grant update (settings) on public.profiles to authenticated;

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- matches
-- ---------------------------------------------------------------------------

create table public.matches (
  id uuid primary key,
  mode text not null check (mode in ('online', 'solo')),
  -- The code the table was played at; online only.
  table_code text check (char_length(table_code) between 1 and 8),
  -- Bot difficulty; solo only.
  difficulty text check (difficulty in ('easy', 'normal', 'hard')),
  -- Bump RULESET in src/shared/game/results.ts whenever the rules change.
  ruleset smallint not null default 1 check (ruleset >= 1),
  player_count smallint not null check (player_count between 2 and 10),
  turns integer not null default 0 check (turns >= 0),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  recorded_at timestamptz not null default now(),
  check (started_at <= ended_at),
  check ((mode = 'solo') = (difficulty is not null)),
  check (mode = 'online' or table_code is null)
);

create index matches_ended_at on public.matches (ended_at desc);

-- ---------------------------------------------------------------------------
-- match_players
-- ---------------------------------------------------------------------------

create table public.match_players (
  match_id uuid not null references public.matches (id) on delete cascade,
  seat smallint not null check (seat between 0 and 9),
  -- The account, for signed-in players. Empty for guests and bots, and set
  -- empty if the account is later deleted — the game itself still happened.
  player_id uuid references public.profiles (id) on delete set null,
  kind text not null check (kind in ('account', 'guest', 'bot')),
  -- The name as it was at the table, not as it is now.
  display_name text not null check (char_length(btrim(display_name)) between 1 and 24),
  pen_colour smallint not null check (pen_colour between 0 and 9),
  -- 1 for the winner. Players who went off on the same shot share a place.
  place smallint not null check (place between 1 and 10),
  won boolean not null,
  -- Pens this player knocked off (after the opening round).
  knockouts smallint not null default 0 check (knockouts between 0 and 9),
  -- Went off the table on their own shot.
  self_fell boolean not null default false,
  stats jsonb not null default '{}'::jsonb check (jsonb_typeof(stats) = 'object'),
  primary key (match_id, seat),
  check (player_id is null or kind = 'account')
);

-- "My games", fast.
create index match_players_player on public.match_players (player_id, match_id)
  where player_id is not null;

-- An account sits in one seat per game.
create unique index match_players_one_seat_per_account on public.match_players (match_id, player_id)
  where player_id is not null;

-- No direct access for anyone but the database owner and the secret key.
-- Everything goes through the functions below.
alter table public.matches enable row level security;
alter table public.match_players enable row level security;
revoke all on public.matches, public.match_players from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Writing: the game server, for online games
-- ---------------------------------------------------------------------------

-- One finished online game, every seat included. Only the secret key may call
-- this. Saving the same game twice is harmless.
create function public.record_online_match(p_match jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted uuid;
begin
  insert into public.matches
    (id, mode, table_code, ruleset, player_count, turns, started_at, ended_at, details)
  values (
    (p_match ->> 'id')::uuid,
    'online',
    p_match ->> 'table_code',
    coalesce((p_match ->> 'ruleset')::smallint, 1),
    jsonb_array_length(p_match -> 'players'),
    coalesce((p_match ->> 'turns')::integer, 0),
    (p_match ->> 'started_at')::timestamptz,
    (p_match ->> 'ended_at')::timestamptz,
    coalesce(p_match -> 'details', '{}'::jsonb)
  )
  on conflict (id) do nothing
  returning id into inserted;

  if inserted is null then
    return;
  end if;

  insert into public.match_players
    (match_id, seat, player_id, kind, display_name, pen_colour, place, won, knockouts, self_fell, stats)
  select
    inserted,
    p.seat,
    -- An account deleted mid-game is kept as an anonymous seat.
    (select profile.id from public.profiles profile where profile.id = p.player_id),
    p.kind,
    p.display_name,
    p.pen_colour,
    p.place,
    p.won,
    coalesce(p.knockouts, 0),
    coalesce(p.self_fell, false),
    coalesce(p.stats, '{}'::jsonb)
  from jsonb_to_recordset(p_match -> 'players') as p(
    seat smallint, player_id uuid, kind text, display_name text, pen_colour smallint,
    place smallint, won boolean, knockouts smallint, self_fell boolean, stats jsonb
  );
end;
$$;

revoke execute on function public.record_online_match(jsonb) from public, anon, authenticated;
grant execute on function public.record_online_match(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Writing: a signed-in player, for their games against the bots
-- ---------------------------------------------------------------------------

-- Solo games run in the browser, so they are self-reported. A player can only
-- ever file them as themselves: the one seat that is not a bot becomes the
-- caller's account, whatever the request says. Takes a list so a guest's
-- history can be brought across in one call on first sign-in. Returns how
-- many games were newly recorded; malformed ones are skipped, not fatal.
create function public.record_solo_matches(p_matches jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  game jsonb;
  seats jsonb;
  inserted uuid;
  recorded integer := 0;
begin
  if me is null then
    raise exception 'Sign in to record games.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_matches) is distinct from 'array' or jsonb_array_length(p_matches) > 200 then
    raise exception 'Expected a list of at most 200 games.' using errcode = '22023';
  end if;

  for game in select value from jsonb_array_elements(p_matches) loop
    begin
      seats := game -> 'players';
      if jsonb_typeof(seats) is distinct from 'array' then
        raise exception 'missing players';
      end if;
      if (select count(*) from jsonb_array_elements(seats) seat where seat ->> 'kind' is distinct from 'bot') <> 1 then
        raise exception 'a solo game has exactly one player who is not a bot';
      end if;
      if (game ->> 'ended_at')::timestamptz > now() + interval '5 minutes' then
        raise exception 'that game has not happened yet';
      end if;

      inserted := null;
      insert into public.matches
        (id, mode, difficulty, ruleset, player_count, turns, started_at, ended_at, details)
      values (
        (game ->> 'id')::uuid,
        'solo',
        game ->> 'difficulty',
        coalesce((game ->> 'ruleset')::smallint, 1),
        jsonb_array_length(seats),
        coalesce((game ->> 'turns')::integer, 0),
        (game ->> 'started_at')::timestamptz,
        (game ->> 'ended_at')::timestamptz,
        coalesce(game -> 'details', '{}'::jsonb)
      )
      on conflict (id) do nothing
      returning id into inserted;

      if inserted is not null then
        insert into public.match_players
          (match_id, seat, player_id, kind, display_name, pen_colour, place, won, knockouts, self_fell, stats)
        select
          inserted,
          p.seat,
          case when p.kind = 'bot' then null else me end,
          case when p.kind = 'bot' then 'bot' else 'account' end,
          p.display_name,
          p.pen_colour,
          p.place,
          p.won,
          coalesce(p.knockouts, 0),
          coalesce(p.self_fell, false),
          coalesce(p.stats, '{}'::jsonb)
        from jsonb_to_recordset(seats) as p(
          seat smallint, kind text, display_name text, pen_colour smallint,
          place smallint, won boolean, knockouts smallint, self_fell boolean, stats jsonb
        );
        recorded := recorded + 1;
      end if;
    exception when others then
      raise warning 'Skipped a solo game: %', sqlerrm;
    end;
  end loop;

  return recorded;
end;
$$;

revoke execute on function public.record_solo_matches(jsonb) from public, anon;
grant execute on function public.record_solo_matches(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Reading: the profile screen
-- ---------------------------------------------------------------------------

-- Totals, streaks and the record against the bots, worked out from the games
-- themselves so there is no running total to drift.
create function public.my_profile_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select m.id, m.mode, m.difficulty, m.ended_at, me.won, me.knockouts, me.self_fell
    from public.match_players me
    join public.matches m on m.id = me.match_id
    where me.player_id = (select auth.uid())
  ),
  online as (
    select won,
      row_number() over (order by ended_at, id)
        - row_number() over (partition by won order by ended_at, id) as run
    from mine
    where mode = 'online'
  ),
  win_runs as (
    select count(*) as length from online where won group by run
  ),
  last_loss as (
    select max(ended_at) as at from mine where mode = 'online' and not won
  )
  select jsonb_build_object(
    'online', (
      select jsonb_build_object(
        'games', count(*),
        'wins', count(*) filter (where won),
        'knockouts', coalesce(sum(knockouts), 0),
        'selfFalls', count(*) filter (where self_fell)
      )
      from mine where mode = 'online'
    ),
    'bestStreak', coalesce((select max(length) from win_runs), 0),
    'currentStreak', (
      select count(*)
      from mine, last_loss
      where mode = 'online' and won
        and (last_loss.at is null or mine.ended_at > last_loss.at)
    ),
    'solo', coalesce((
      select jsonb_object_agg(difficulty, jsonb_build_object('games', games, 'wins', wins))
      from (
        select difficulty, count(*) as games, count(*) filter (where won) as wins
        from mine where mode = 'solo'
        group by difficulty
      ) by_difficulty
    ), '{}'::jsonb)
  );
$$;

-- The caller's latest games, each with everybody who was at the table.
-- Other players' account ids are never included, only their names.
create function public.my_recent_matches(p_limit integer default 10)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(recent.entry order by recent.ended_at desc), '[]'::jsonb)
  from (
    select m.ended_at, jsonb_build_object(
      'id', m.id,
      'mode', m.mode,
      'difficulty', m.difficulty,
      'tableCode', m.table_code,
      'playerCount', m.player_count,
      'turns', m.turns,
      'endedAt', m.ended_at,
      'you', jsonb_build_object(
        'seat', me.seat,
        'place', me.place,
        'won', me.won,
        'knockouts', me.knockouts,
        'selfFell', me.self_fell
      ),
      'players', (
        select jsonb_agg(jsonb_build_object(
          'seat', p.seat,
          'name', p.display_name,
          'kind', p.kind,
          'penColour', p.pen_colour,
          'place', p.place,
          'won', p.won
        ) order by p.seat)
        from public.match_players p
        where p.match_id = m.id
      )
    ) as entry
    from public.match_players me
    join public.matches m on m.id = me.match_id
    where me.player_id = (select auth.uid())
    order by m.ended_at desc
    limit least(greatest(coalesce(p_limit, 10), 1), 50)
  ) recent;
$$;

revoke execute on function public.my_profile_summary() from public, anon;
revoke execute on function public.my_recent_matches(integer) from public, anon;
grant execute on function public.my_profile_summary() to authenticated;
grant execute on function public.my_recent_matches(integer) to authenticated;
