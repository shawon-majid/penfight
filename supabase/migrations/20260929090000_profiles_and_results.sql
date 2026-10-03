-- Profiles and match results for signed-in players.
--
-- Guests never touch this database: their name, pen colour and solo record
-- live in the browser. A row appears here only once someone signs in.
--
-- Who can write what:
--   - profiles:      a player can read and edit their own row, nothing else.
--   - match_results: online rows are written only by the game server (with the
--                    secret key, which bypasses these policies). A player may
--                    add solo rows for themselves — solo runs in the browser,
--                    so those are self-reported and kept apart from online.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Player'
    check (char_length(btrim(display_name)) between 1 and 24),
  -- Index into the ten pen colours in src/client/render/theme.ts.
  pen_colour smallint not null default 0 check (pen_colour between 0 and 9),
  -- Set once the browser has copied the guest's name and solo record across.
  imported_local boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, pen_colour, imported_local) on public.profiles to authenticated;

create policy "Players read their own profile"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id);

create policy "Players edit their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- A profile for every new sign-in. Only the first word of the Google name is
-- used, so a full real name is not shown at tables unless the player types it.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  google_name text := btrim(coalesce(
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    ''
  ));
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(btrim(left(split_part(google_name, ' ', 1), 24)), ''), 'Player')
  );
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- match_results: one row per signed-in player per finished match
-- ---------------------------------------------------------------------------

create table public.match_results (
  id bigint generated always as identity primary key,
  match_id uuid not null,
  player_id uuid not null references public.profiles (id) on delete cascade,
  mode text not null check (mode in ('online', 'solo')),
  -- Bot difficulty; solo only.
  difficulty text check (difficulty in ('easy', 'normal', 'hard')),
  -- 1 for the winner. Players who went off on the same shot share a place.
  place smallint not null check (place >= 1),
  player_count smallint not null check (player_count between 2 and 10),
  won boolean not null,
  -- Pens this player knocked off the table (after the opening round).
  knockouts smallint not null default 0 check (knockouts >= 0),
  -- Went off the table on their own shot.
  self_fell boolean not null default false,
  -- Everyone else's names, as they were at the table.
  opponents text[] not null default '{}' check (cardinality(opponents) <= 9),
  played_at timestamptz not null default now(),
  unique (match_id, player_id),
  check ((mode = 'solo') = (difficulty is not null))
);

create index match_results_player_recent
  on public.match_results (player_id, played_at desc);

alter table public.match_results enable row level security;

revoke all on public.match_results from anon, authenticated;
grant select, insert on public.match_results to authenticated;

create policy "Players read their own results"
  on public.match_results for select to authenticated
  using ((select auth.uid()) = player_id);

create policy "Players record their own solo games"
  on public.match_results for insert to authenticated
  with check ((select auth.uid()) = player_id and mode = 'solo');

-- ---------------------------------------------------------------------------
-- The numbers on the profile screen, worked out from the results so they can
-- never drift out of step with them.
-- ---------------------------------------------------------------------------

create function public.my_profile_summary()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with mine as (
    select * from public.match_results where player_id = (select auth.uid())
  ),
  online as (
    select won, played_at,
      row_number() over (order by played_at, id)
        - row_number() over (partition by won order by played_at, id) as run
    from mine
    where mode = 'online'
  ),
  win_runs as (
    select count(*) as length from online where won group by run
  ),
  last_loss as (
    select max(played_at) as at from mine where mode = 'online' and not won
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
        and (last_loss.at is null or mine.played_at > last_loss.at)
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

revoke execute on function public.my_profile_summary() from public, anon;
grant execute on function public.my_profile_summary() to authenticated;
