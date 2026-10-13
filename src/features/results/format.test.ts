import { describe, expect, it } from "vitest";
import { compactCount, formatElapsed, groupDigits } from "./format";

describe("groupDigits", () => {
  it("groups the integer part and keeps sign and fraction verbatim", () => {
    expect(groupDigits("-1234567.890")).toBe("-1,234,567.890");
    expect(groupDigits("1021447.90")).toBe("1,021,447.90");
    expect(groupDigits("3402")).toBe("3,402");
    expect(groupDigits("742")).toBe("742");
    expect(groupDigits("0.000123")).toBe("0.000123");
  });

  it("never loses precision beyond 2^53", () => {
    expect(groupDigits("9007199254740993")).toBe("9,007,199,254,740,993");
    expect(groupDigits("12345678901234567890.123456789")).toBe("12,345,678,901,234,567,890.123456789");
  });

  it("does not group digits after the decimal point or in the exponent", () => {
    expect(groupDigits("1.23456789")).toBe("1.23456789");
    expect(groupDigits("1234.5e+10000")).toBe("1,234.5e+10000");
  });

  it("passes through text that is not a plain decimal", () => {
    for (const s of ["NaN", "Infinity", "-Infinity", "$1,234.00", "", "1.2.3"]) expect(groupDigits(s)).toBe(s);
  });
});

describe("compactCount", () => {
  it("matches the mockup's row estimates", () => {
    expect(compactCount(18_400)).toBe("18.4k");
    expect(compactCount(241_000)).toBe("241k");
    expect(compactCount(612_000)).toBe("612k");
    expect(compactCount(1_200)).toBe("1.2k");
  });

  it("keeps small counts exact and drops a trailing .0", () => {
    expect(compactCount(0)).toBe("0");
    expect(compactCount(999)).toBe("999");
    expect(compactCount(3_000)).toBe("3k");
  });

  it("promotes to the next unit when rounding carries", () => {
    expect(compactCount(999_999)).toBe("1M");
    expect(compactCount(1_234_567)).toBe("1.2M");
    expect(compactCount(2_500_000_000)).toBe("2.5B");
  });
});

describe("formatElapsed", () => {
  it("uses ms under a second and seconds above", () => {
    expect(formatElapsed(38)).toBe("38 ms");
    expect(formatElapsed(1_234)).toBe("1.23 s");
    expect(formatElapsed(75_000)).toBe("1m 15s");
  });
});
