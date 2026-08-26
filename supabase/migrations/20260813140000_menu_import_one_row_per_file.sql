-- One stored object, one menu_imports row.
--
-- recordMenuImport (app/menu-imports/actions.ts) is reached twice for the
-- same file more often than it looks: a client retry after a slow
-- response, a double submit, a POST to the action id written by hand.
-- Nothing stopped the second call writing a second 'pending' row against
-- the same path, and a duplicate row here is not a cosmetic one:
--
--   * discardMenuImport deletes the object and then the row. Run it on
--     one of the two and the other is left pointing at a file that is not
--     there -- precisely the "row pointing at a file nobody can read"
--     that the comment above recordMenuImport says it refuses to write.
--   * extraction reads pending rows, so one photo is sent to the model
--     twice. The bill for that lands on the restaurant.
--
-- source_path is `<location_id>/<uuid>.<ext>`, so it already carries the
-- tenant boundary; unique on the path alone is the honest statement of
-- the invariant ("one object, one row") and also refuses a row that
-- claims another location's object.
--
-- Partial because a 'url' import has no stored object and any number of
-- those may exist. Postgres treats NULLs as distinct in a unique index
-- anyway, so this changes nothing about the rows it excludes -- it says
-- out loud which rows the invariant is about.
create unique index if not exists menu_imports_source_path_key
  on menu_imports (source_path)
  where source_path is not null;

comment on index menu_imports_source_path_key is
  'One stored object, one import row: a retried or duplicated upload must not leave a second row against the same file, which discarding either would then orphan.';
