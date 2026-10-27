-- 042: academic structure integrity (Phase 8). No data is changed or removed.

-- 1) A soft-deleted unit frees its code, like courses, subjects and students already do (014, 015, 016).
--    Only the constraint is replaced; foreign keys use unique (organization_id, id), which stays.
alter table public.academic_units drop constraint academic_units_organization_id_code_key;
create unique index academic_units_org_code_uidx
  on public.academic_units (organization_id, code) where deleted_at is null;

-- 2) The tree follows the level order: a unit's parent sits on a HIGHER level (smaller position), e.g. Branch under Program.
--    Levels may be skipped (a school can hang Section directly under Class). Because positions strictly decrease on the way
--    up, a unit can never become its own ancestor, so this also prevents cycles.
--    Invoker rights on purpose: the caller can only see units/levels of their own organization, so a foreign parent id is
--    reported as "invalid parent" and reveals nothing about other organizations.
create or replace function app.validate_academic_unit() returns trigger language plpgsql as $$
declare v_pos int; v_parent_pos int;
begin
  if new.deleted_at is not null then
    return new; -- soft delete: the API refuses it while the unit still has children
  end if;
  if tg_op = 'UPDATE' and new.parent_id is not distinct from old.parent_id
     and new.level_id is not distinct from old.level_id and old.deleted_at is null then
    return new; -- rename / status change only
  end if;

  select l.position into v_pos from public.academic_levels l
  where l.organization_id = new.organization_id and l.id = new.level_id;

  if new.parent_id is not null then
    select l.position into v_parent_pos
    from public.academic_units p
    join public.academic_levels l on l.organization_id = p.organization_id and l.id = p.level_id
    where p.organization_id = new.organization_id and p.id = new.parent_id and p.deleted_at is null;
    if v_parent_pos is null then
      raise exception 'INVALID_PARENT_UNIT' using errcode = 'EX400';
    end if;
    if v_pos is not null and v_parent_pos >= v_pos then
      raise exception 'INVALID_UNIT_LEVEL' using errcode = 'EX400';
    end if;
  end if;

  if tg_op = 'UPDATE' and exists (
    select 1 from public.academic_units c
    join public.academic_levels l on l.organization_id = c.organization_id and l.id = c.level_id
    where c.organization_id = new.organization_id and c.parent_id = new.id and c.deleted_at is null
      and l.position <= v_pos
  ) then
    raise exception 'INVALID_UNIT_LEVEL' using errcode = 'EX400';
  end if;
  return new;
end $$;

create trigger trg_validate_academic_unit before insert or update on public.academic_units
  for each row execute function app.validate_academic_unit();

-- Same rule as 041: nothing in schema app is executable by PUBLIC/anon. Triggers fire without EXECUTE privilege.
revoke execute on function app.validate_academic_unit() from public, anon;
