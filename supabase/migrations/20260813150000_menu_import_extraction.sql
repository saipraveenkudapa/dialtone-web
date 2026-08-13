-- What a model read off a photograph, and the one thing it must never be
-- mistaken for.
--
-- Comments only. No column changes, no data changes: raw_extraction and
-- status already exist and already say what they need to say structurally
-- (the CHECK on this table still refuses 'confirmed' without a
-- confirmed_at). What was missing is written down here, next to the
-- column, where the next person to write a query against it will read it.

comment on column menu_imports.raw_extraction is
  'What a model read off the uploaded file, verbatim and never edited: the '
  'proposal a human confirms, not a menu. Shape and version live in '
  'lib/menu-imports/extraction.ts (schema_version 1). Written once by the '
  'read step; the review step writes menu_items, never this. '
  'Prices are integer cents under items[].price.cents and exist only where '
  'price.known is true -- a price the model could not read comes back '
  '{"known": false} with the printed text, never a guess. '
  'INGREDIENTS ARE NOT AN ALLERGEN LIST. items[].ingredients is what the '
  'card happened to print, marked verified:false, and nothing may promote '
  'it to an allergen claim: a laminated menu cannot know the fryer is '
  'shared or that a dish is finished in butter. Any allergy, intolerance '
  'or celiac question still transfers to a human, unchanged '
  '(lib/agent/prompt.ts). In particular, confirming an import must not '
  'copy these into menu_items.allergen_note.';

comment on column menu_imports.status is
  'pending: uploaded, not read. needs_review: a model has read it and the '
  'result is in raw_extraction, waiting on a human -- this is as far as an '
  'extraction alone may ever move a price. confirmed: a human signed for '
  'it and menu_items was written (confirmed_at is required by the CHECK on '
  'this table). discarded: a human read it and rejected it.';
