import { describe, expect, it } from "vitest";
import {
  ONE_CHEFS_SPECIAL_REFUSAL,
  PICK_CAP_REFUSAL,
  PICK_LABEL,
  pickLabelFromControl,
  pickRefusal,
} from "@/lib/menu";

/* THE TWO RULES, IN THE RESTAURANT'S OWN WORDS.
 *
 * Both are the database's: menu_items_staff_pick_cap raises 23514 and
 * menu_items_one_chefs_special_idx raises 23505. lib/admin/edit.ts
 * already turns each into a sentence for the OPERATOR, who administers
 * many restaurants and reads "This restaurant already has...". The owner
 * has one restaurant and it is theirs, so these are their own sentences
 * rather than a reused pair -- and, more than that, the pair has to stay
 * a PAIR: "clear one of your three picks" is no help at all to somebody
 * who has called two dishes the chef's special and has only picked two.
 */

describe("what the owner is told when the database refuses a pick", () => {
  it("names the cap for 23514, and the cap alone", () => {
    // menu_items_staff_pick_cap: `raise exception ... using errcode =
    // 'check_violation'`, supabase/migrations/20260818000100_pick_labels.sql.
    const said = pickRefusal("23514");
    expect(said).toBe(PICK_CAP_REFUSAL);
    expect(said).toContain("three");
    // The way back out, on the screen they are already looking at.
    expect(said).toContain("not a pick");
    // Not the chef's special: the owner may be at three best sellers.
    expect(said).not.toContain("chef");
  });

  it("names the one-chefs-special rule for 23505, and not the cap", () => {
    // menu_items_one_chefs_special_idx, same migration.
    const said = pickRefusal("23505");
    expect(said).toBe(ONE_CHEFS_SPECIAL_REFUSAL);
    expect(said).toContain("chef");
    // The defect this separation exists for: an owner with two picks who
    // is told to clear one of their three has been sent to look for a
    // rule they have not hit.
    expect(said).not.toContain("three");
  });

  it("keeps the two apart", () => {
    expect(pickRefusal("23514")).not.toBe(pickRefusal("23505"));
  });

  it("says something plain, and never the database's own words, for anything else", () => {
    // A PostgrestError's `message`, `details` and `hint` name columns,
    // constraints and sometimes row values. None of that reaches a
    // restaurant owner: only the code is ever read.
    for (const code of ["42501", "PGRST301", "", undefined]) {
      const said = pickRefusal(code);
      expect(said).not.toBe(PICK_CAP_REFUSAL);
      expect(said).not.toBe(ONE_CHEFS_SPECIAL_REFUSAL);
      expect(said.length).toBeGreaterThan(0);
      expect(said).not.toMatch(/menu_items|pick_label|violat|constraint|23\d\d\d/i);
    }
  });

  it("is refusal text and nothing else -- no code, no identifier", () => {
    for (const said of [PICK_CAP_REFUSAL, ONE_CHEFS_SPECIAL_REFUSAL]) {
      expect(said).not.toMatch(/menu_items|pick_label|23514|23505|SQLSTATE/i);
    }
  });
});

describe("the value the pick control hands back", () => {
  // The <select> has exactly three options, and this is what turns the
  // one it was left on into the column's own vocabulary. "" is the
  // column's null -- there is no third member of PickLabel for "not a
  // pick", which is why the column is nullable.
  it("reads the two kinds the column admits", () => {
    expect(pickLabelFromControl("best_seller")).toBe("best_seller");
    expect(pickLabelFromControl("chefs_special")).toBe("chefs_special");
    expect(Object.keys(PICK_LABEL)).toEqual(["best_seller", "chefs_special"]);
  });

  it("reads the empty option as not-a-pick", () => {
    expect(pickLabelFromControl("")).toBeNull();
  });

  it("refuses to invent a kind the column would reject", () => {
    /* The column's own check constraint raises 23514 -- the CAP's
       SQLSTATE -- so a value that is not one of the two would be
       reported to the owner as a limit they have not reached. Nothing
       but the control calls this, and the control has three options; a
       value from anywhere else is not a pick, which is the safe reading
       because it is the one that praises no dish. */
    expect(pickLabelFromControl("staff_pick")).toBeNull();
    expect(pickLabelFromControl("BEST_SELLER")).toBeNull();
  });
});
