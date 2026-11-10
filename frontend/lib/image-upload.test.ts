import { describe, expect, it } from "vitest";
import { hasAllowedImageType, imageAccept, imageFormatNames } from "./image-upload";

const jpeg = [0xff, 0xd8, 0xff, 0xe0];
const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("image uploads", () => {
  it("includes picker extensions only for image formats allowed by the template", () => {
    expect(imageAccept(["image/png"])).toBe("image/png,.png");
    expect(imageAccept(["image/jpeg"])).toBe("image/jpeg,.jpg,.jpeg");
    expect(imageAccept([])).toBe("");
  });

  it("labels only the formats configured for the template and preserves their order", () => {
    expect(imageFormatNames(["image/png"])).toEqual(["PNG"]);
    expect(imageFormatNames(["image/jpeg"])).toEqual(["JPEG"]);
    expect(imageFormatNames(["image/png", "image/jpeg"])).toEqual(["PNG", "JPEG"]);
  });

  it.each([
    { bytes: jpeg, mime: "image/jpeg" },
    { bytes: png, mime: "image/png" },
  ])("accepts $mime bytes when the file has no declared MIME type", async ({ bytes, mime }) => {
    const file = new File([Uint8Array.from(bytes)], "upload");
    expect(file.type).toBe("");
    await expect(hasAllowedImageType(file, [mime])).resolves.toBe(true);
  });

  it.each([
    { name: "plain text", bytes: [0x41, 0x42, 0x43] },
    { name: "truncated PNG", bytes: png.slice(0, -1) },
    { name: "JPEG bytes in a PNG-only template", bytes: jpeg },
  ])("rejects $name even when the filename and declared MIME claim PNG", async ({ bytes }) => {
    const file = new File([Uint8Array.from(bytes)], "upload.png", { type: "image/png" });
    await expect(hasAllowedImageType(file, ["image/png"])).resolves.toBe(false);
  });
});
