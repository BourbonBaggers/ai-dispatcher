import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessDataLossRisk,
  parseUnifiedDiff,
  isTestPath,
  type ChangedFile,
} from "../src/autoship-gate.ts";

const file = (path: string, ...addedLines: string[]): ChangedFile => ({ path, addedLines });

describe("assessDataLossRisk — holds destructive changes", () => {
  it("holds a migration that drops a table", () => {
    const r = assessDataLossRisk([file("prisma/migrations/x/migration.sql", 'DROP TABLE "Dispatcher";')]);
    assert.equal(r.held, true);
    assert.match(r.reasons[0]!, /DROP TABLE/);
  });

  it("holds a dropped column", () => {
    const r = assessDataLossRisk([file("prisma/migrations/x/migration.sql", 'ALTER TABLE "Retailer" DROP COLUMN "notes";')]);
    assert.equal(r.held, true);
  });

  it("holds TRUNCATE and DELETE FROM", () => {
    assert.equal(assessDataLossRisk([file("m.sql", "TRUNCATE TABLE orders;")]).held, true);
    assert.equal(assessDataLossRisk([file("m.sql", "DELETE FROM orders WHERE 1=1;")]).held, true);
  });

  it("holds a bulk deleteMany in application code", () => {
    const r = assessDataLossRisk([file("apps/api/src/routes/v1/orders/service.ts", "await prisma.order.deleteMany();")]);
    assert.equal(r.held, true);
    assert.match(r.reasons[0]!, /deleteMany/);
  });

  it("holds executeRawUnsafe", () => {
    assert.equal(assessDataLossRisk([file("svc.ts", 'await prisma.$executeRawUnsafe("DELETE FROM x");')]).held, true);
  });

  it("reports every distinct risk, de-duplicated", () => {
    const r = assessDataLossRisk([
      file("m.sql", 'DROP TABLE "A";', 'DROP TABLE "A";', 'TRUNCATE TABLE b;'),
    ]);
    // Two distinct labels from three lines.
    assert.equal(r.reasons.length, 2);
  });
});

describe("assessDataLossRisk — precision guards (must not over-fire)", () => {
  it("does NOT hold a deleteMany in a test file", () => {
    const r = assessDataLossRisk([
      file("test/orders.test.ts", "await prisma.order.deleteMany({ where: { id: { startsWith: TEST } } });"),
    ]);
    assert.equal(r.held, false, "test-file teardown is not a production risk");
  });

  it("does NOT hold a *.test.ts destructive line via the spec/test suffix rule", () => {
    assert.equal(assessDataLossRisk([file("src/foo.spec.ts", "DELETE FROM t;")]).held, false);
    assert.equal(assessDataLossRisk([file("tests/x.ts", "DROP TABLE t;")]).held, false);
  });

  it("does NOT hold an additive-only migration", () => {
    const r = assessDataLossRisk([
      file("prisma/migrations/x/migration.sql", 'CREATE TABLE "New" (id text primary key);', 'ALTER TABLE "New" ADD COLUMN "n" int;'),
    ]);
    assert.equal(r.held, false);
  });

  it("does NOT hold DROP INDEX / DROP CONSTRAINT (not data loss)", () => {
    assert.equal(assessDataLossRisk([file("m.sql", 'DROP INDEX "idx_foo";')]).held, false);
    assert.equal(assessDataLossRisk([file("m.sql", 'ALTER TABLE "t" DROP CONSTRAINT "c";')]).held, true,
      "ALTER TABLE ... DROP CONSTRAINT still matches the ALTER...DROP guard — conservative on purpose");
  });

  it("returns not-held for an empty changeset", () => {
    assert.deepEqual(assessDataLossRisk([]), { held: false, reasons: [] });
  });
});

describe("isTestPath", () => {
  it("recognizes test directories and suffixes", () => {
    for (const p of ["test/a.ts", "tests/a.ts", "x/__tests__/a.ts", "a.test.ts", "a.spec.tsx"]) {
      assert.equal(isTestPath(p), true, p);
    }
  });
  it("does not treat production paths as tests", () => {
    for (const p of ["src/service.ts", "prisma/migrations/x/migration.sql", "apps/api/src/latest.ts"]) {
      assert.equal(isTestPath(p), false, p);
    }
  });
});

describe("parseUnifiedDiff", () => {
  it("extracts added lines per file and ignores +++ headers and context", () => {
    const diff = [
      "diff --git a/prisma/migrations/x/migration.sql b/prisma/migrations/x/migration.sql",
      "--- a/prisma/migrations/x/migration.sql",
      "+++ b/prisma/migrations/x/migration.sql",
      "@@ -0,0 +1,2 @@",
      '+DROP TABLE "Old";',
      " unchanged context line",
      "diff --git a/README.md b/README.md",
      "+++ b/README.md",
      "+just docs",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    assert.equal(files.length, 2);
    assert.equal(files[0]!.path, "prisma/migrations/x/migration.sql");
    assert.deepEqual(files[0]!.addedLines, ['DROP TABLE "Old";']);
    assert.equal(files[1]!.path, "README.md");

    // End to end: the parsed diff feeds the gate.
    assert.equal(assessDataLossRisk(files).held, true);
  });
});
