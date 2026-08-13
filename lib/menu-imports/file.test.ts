import { describe, expect, it } from "vitest";
import {
  ACCEPTED_TYPES_SENTENCE,
  MAX_MENU_BATCH_BYTES,
  MAX_MENU_FILE_BYTES,
  MAX_MENU_FILES,
  MENU_UPLOAD_ACCEPT,
  MENU_UPLOAD_BUCKET,
  checkMenuUpload,
  cleanFileName,
  fileSize,
  isPathInLocation,
  isUuid,
  menuBatchTooLarge,
  menuUploadKind,
  menuUploadPath,
  normalizeContentType,
} from "./file";

const LOCATION = "a10c0000-0000-0000-0000-00000000000a";
const OBJECT = "3f7c9a10-1111-4222-8333-444455556666";

describe("what may be uploaded", () => {
  it("takes the four types the bucket allows", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "application/pdf"]) {
      expect(checkMenuUpload({ contentType: type, size: 1024 }).ok).toBe(true);
    }
  });

  it("offers the picker exactly what it accepts", () => {
    for (const type of MENU_UPLOAD_ACCEPT.split(",")) {
      expect(menuUploadKind(type)).not.toBeNull();
    }
  });

  it("calls a pdf a pdf and a photo an image", () => {
    expect(menuUploadKind("application/pdf")?.sourceType).toBe("pdf");
    expect(menuUploadKind("image/png")?.sourceType).toBe("image");
  });

  it("refuses anything else", () => {
    const result = checkMenuUpload({ contentType: "application/zip", size: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(ACCEPTED_TYPES_SENTENCE);
  });

  it("names HEIC, because a phone will hand one over and nothing downstream reads it", () => {
    const byType = checkMenuUpload({ contentType: "image/heic", size: 1024 });
    const byName = checkMenuUpload({
      fileName: "IMG_0021.HEIC",
      contentType: "application/octet-stream",
      size: 1024,
    });
    expect(byType.ok).toBe(false);
    expect(byName.ok).toBe(false);
    if (!byType.ok) expect(byType.error).toMatch(/JPEG/);
    if (!byName.ok) expect(byName.error).toMatch(/JPEG/);
  });

  it("refuses a file past the bucket's own ceiling", () => {
    expect(checkMenuUpload({ contentType: "image/jpeg", size: MAX_MENU_FILE_BYTES }).ok).toBe(true);
    const over = checkMenuUpload({ contentType: "image/jpeg", size: MAX_MENU_FILE_BYTES + 1 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("10 MB");
  });

  it("refuses an empty file", () => {
    expect(checkMenuUpload({ contentType: "image/jpeg", size: 0 }).ok).toBe(false);
  });

  it("reads a content type with parameters and odd case", () => {
    expect(normalizeContentType("IMAGE/JPEG; charset=binary")).toBe("image/jpeg");
    expect(checkMenuUpload({ contentType: "Image/Jpeg; charset=binary", size: 10 }).ok).toBe(true);
  });

  it("treats a missing content type as unacceptable rather than as anything", () => {
    expect(checkMenuUpload({ contentType: undefined, size: 10 }).ok).toBe(false);
    expect(checkMenuUpload({ contentType: "", size: 10 }).ok).toBe(false);
  });
});

describe("where an upload is put", () => {
  it("keys the object by location, so the first segment is the tenant", () => {
    expect(menuUploadPath(LOCATION, OBJECT, "image/jpeg")).toBe(`${LOCATION}/${OBJECT}.jpg`);
    expect(menuUploadPath(LOCATION, OBJECT, "application/pdf")).toBe(`${LOCATION}/${OBJECT}.pdf`);
  });

  it("never lets a caller-shaped id become a path", () => {
    expect(() => menuUploadPath("../other", OBJECT, "image/jpeg")).toThrow();
    expect(() => menuUploadPath(LOCATION, "../../etc/passwd", "image/jpeg")).toThrow();
    expect(() => menuUploadPath(LOCATION, OBJECT, "application/zip")).toThrow();
  });

  it("recognises only a path inside this location's own folder", () => {
    expect(isPathInLocation(`${LOCATION}/${OBJECT}.jpg`, LOCATION)).toBe(true);
    // Another restaurant's folder, and a path that climbs out of one.
    expect(isPathInLocation(`b10c0000-0000-0000-0000-00000000000b/x.jpg`, LOCATION)).toBe(false);
    expect(isPathInLocation(`${LOCATION}/../other/x.jpg`, LOCATION)).toBe(false);
    expect(isPathInLocation(`${LOCATION}/`, LOCATION)).toBe(false);
    expect(isPathInLocation(OBJECT, LOCATION)).toBe(false);
    expect(isPathInLocation(`${LOCATION}/${OBJECT}.jpg`, "not-a-uuid")).toBe(false);
  });

  it("knows a uuid from a string that merely looks like one", () => {
    expect(isUuid(LOCATION)).toBe(true);
    expect(isUuid("a10c0000-0000-0000-0000-00000000000")).toBe(false);
    expect(isUuid("")).toBe(false);
  });

  it("uploads into one private bucket", () => {
    expect(MENU_UPLOAD_BUCKET).toBe("menu-uploads");
  });
});

describe("what is shown back to a human", () => {
  it("keeps the name the file arrived with, minus control characters", () => {
    expect(cleanFileName("  dinner menu.pdf \n")).toBe("dinner menu.pdf");
    expect(cleanFileName("front\u0007page.jpg")).toBe("frontpage.jpg");
    expect(cleanFileName("x".repeat(400)).length).toBe(120);
  });

  it("says a size the way a person would", () => {
    expect(fileSize(512)).toBe("512 B");
    expect(fileSize(2048)).toBe("2 KB");
    expect(fileSize(2.4 * 1024 * 1024)).toBe("2.4 MB");
    expect(fileSize(MAX_MENU_FILE_BYTES)).toBe("10 MB");
  });
});

describe("the batch ceiling, weighed before anything is fetched", () => {
  it("lets a batch that fits through", () => {
    expect(menuBatchTooLarge([2_000_000, 3_000_000, 1])).toBeNull();
    expect(menuBatchTooLarge([MAX_MENU_BATCH_BYTES])).toBeNull();
    expect(menuBatchTooLarge([])).toBeNull();
  });

  it("refuses one byte past the ceiling, naming the size and the fix", () => {
    const over = menuBatchTooLarge([MAX_MENU_BATCH_BYTES, 1]);
    expect(over).not.toBeNull();
    expect(over!.total).toBe(MAX_MENU_BATCH_BYTES + 1);
    expect(over!.error).toMatch(/16 MB/);
    expect(over!.error).toMatch(/Remove a file/);
  });

  it("refuses the worst batch both other limits allow: ten files of ten megabytes", () => {
    // Neither MAX_MENU_FILES nor MAX_MENU_FILE_BYTES implies this one, so
    // this is the batch that would otherwise be downloaded and base64'd
    // in full before anything said no.
    const worst = Array(MAX_MENU_FILES).fill(MAX_MENU_FILE_BYTES);
    expect(menuBatchTooLarge(worst)!.error).toMatch(/100 MB/);
  });

  it("counts a size it does not have as nothing rather than refusing a menu", () => {
    // byte_size is nullable, and an unknown size is not evidence of a big
    // one. readMenu weighs the real bytes afterwards.
    expect(menuBatchTooLarge([null, undefined, 2_000_000])).toBeNull();
    expect(menuBatchTooLarge([Number.NaN, Number.POSITIVE_INFINITY, -5])).toBeNull();
    // ...and one nonsense size does not hide the ones that are real.
    expect(menuBatchTooLarge([null, MAX_MENU_BATCH_BYTES + 1])).not.toBeNull();
  });

  it("says the same sentence to both callers", async () => {
    // readMenu's own ceiling is this function, so the owner cannot be
    // told two different things about one batch.
    const source = await import("node:fs").then(({ readFileSync }) =>
      readFileSync(new URL("./read.ts", import.meta.url), "utf8"),
    );
    expect(source).toMatch(/menuBatchTooLarge/);
  });
});
