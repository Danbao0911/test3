import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsvBytes, prepareImportRows } from "../../src/lib/import-service";

describe("CSV import preparation", () => {
  it("parses the fixed 90-row fixture without storing the file", () => {
    process.env.APP_MODE = "demo";
    const fixture = readFileSync(path.join(process.cwd(), "tests/fixtures/accounts-90.csv"));
    const parsed = parseCsvBytes(fixture);
    const prepared = prepareImportRows(parsed, "00000000-0000-4000-8000-000000000001");
    expect(parsed).toHaveLength(90);
    expect(prepared.filter((row) => row.input)).toHaveLength(80);
    expect(prepared.filter((row) => row.errorCode)).toHaveLength(10);
    expect(prepared.filter((row) => row.input).map((row) => row.normalizedProfileUrl)).toHaveLength(80);
  });

  it("rejects unknown columns and over-sized imports", () => {
    expect(() => parseCsvBytes(new TextEncoder().encode("platform,unknown\nYOUTUBE,x"))).toThrow("CSV 列必须严格");
    expect(() => parseCsvBytes(new Uint8Array(2 * 1024 * 1024 + 1))).toThrow("不能超过 2 MiB");
  });

  it("keeps row numbers for exact column-count errors and accepts quoted commas", () => {
    const csv = "platform,nativeId,displayName,profileUrl,organization,serviceTags,region,sourceUrl\nYOUTUBE,a,\"机构, 财富\",https://example.com/demo/youtube/a,机构,财富规划,上海,https://example.com/source\nYOUTUBE,a,b,https://example.com/demo/youtube/b,c,d,e\nYOUTUBE,a,b,https://example.com/demo/youtube/c,c,d,e,f,g\n";
    const parsed = parseCsvBytes(new TextEncoder().encode(csv));
    expect(parsed[0]?.row?.displayName).toBe("机构, 财富");
    expect(parsed.slice(1).map((row) => [row.rowNumber, row.errorCode])).toEqual([[3, "CSV_COLUMN_COUNT"], [4, "CSV_COLUMN_COUNT"]]);
  });
});
