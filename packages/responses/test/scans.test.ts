import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createResponseStore } from "../dist/index.js";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const principal = { kind: "local" as const, workspaceId };

it("calculates independent fixture aggregates and preserves exact chunk coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "tack-scans-"));
  const store = await createResponseStore({ root, workspaceId });
  const rows = Array.from({ length: 257 }, (_, index) => ({
    id: index,
    category: index % 2 ? "odd" : "even",
    value: index * 3,
    text: "界".repeat(80),
  }));
  try {
    const parent = await store.retain(
      principal,
      {
        formatVersion: 1,
        kind: "tool-response",
        upstreamOutcome: "succeeded",
        data: rows,
        text: "",
      },
      { upstreamOutcome: "succeeded", operationId: "fixture" },
    );
    const expected = rows.filter((row) => row.category === "even");
    for (const operation of ["sum", "min", "max", "count"] as const) {
      const result = await store.scan(principal, {
        id: parent.id,
        pointer: "/data",
        spec: {
          operation,
          ...(operation !== "count" ? { value: "/value" } : {}),
          where: [{ pointer: "/category", op: "eq", value: "even" }],
        },
      });
      expect(result.data).toBe(
        operation === "sum"
          ? expected.reduce((sum, row) => sum + row.value, 0)
          : operation === "min"
            ? Math.min(...expected.map((row) => row.value))
            : operation === "max"
              ? Math.max(...expected.map((row) => row.value))
              : expected.length,
      );
      expect(result.provenance.coverage).toMatchObject({
        complete: true,
        scanned: 257,
        matched: 129,
        nextOffset: null,
      });
    }
    const collected: unknown[] = [];
    let offset = 0;
    do {
      const result = await store.scan(principal, {
        id: parent.id,
        pointer: "/data",
        spec: {
          operation: "rows",
          select: [
            { name: "id", pointer: "/id" },
            { name: "text", pointer: "/text" },
          ],
        },
        offset,
        limit: 71,
        response: "inline",
        maxBytes: 10_000,
      });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
        10_000,
      );
      expect(result.provenance.coverage.complete).toBe(false);
      collected.push(...(result.data as unknown[]));
      const next = result.provenance.coverage.nextOffset;
      if (next === null) break;
      expect(next).toBeGreaterThan(offset);
      offset = next;
    } while (true);
    expect(collected).toEqual(rows.map(({ id, text }) => ({ id, text })));
    const overshoot = await store.scan(principal, {
      id: parent.id,
      pointer: "/data",
      spec: { operation: "count" },
      offset: 1000,
    });
    expect(overshoot.provenance.coverage).toMatchObject({
      complete: false,
      scanned: 0,
      nextOffset: null,
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("auto-stores large rows, survives restart, and inherits parent authorization and expiry", async () => {
  const root = await mkdtemp(join(tmpdir(), "tack-scan-lineage-"));
  let allowed = true;
  let clock = Date.now();
  const options = {
    root,
    workspaceId,
    now: () => clock,
    policy: { authorizeOrigin: () => allowed },
  };
  let store = await createResponseStore(options);
  try {
    const parent = await store.retain(
      principal,
      {
        formatVersion: 1,
        kind: "tool-response",
        upstreamOutcome: "succeeded",
        data: Array.from({ length: 1000 }, (_, id) => ({
          id,
          text: "x".repeat(100),
        })),
        text: "",
      },
      { upstreamOutcome: "succeeded", operationId: "fixture" },
    );
    clock += 1000;
    const derived = await store.scan(principal, {
      id: parent.id,
      pointer: "/data",
      spec: { operation: "rows" },
    });
    expect(derived.delivery).toBe("stored");
    expect(derived.response?.expiresAt).toBe(parent.expiresAt);
    const id = derived.response!.id;
    await store.close();
    store = await createResponseStore(options);
    expect(
      await store.read(principal, {
        id,
        pointer: "/data",
        offset: 999,
        limit: 1,
      }),
    ).toMatchObject({ value: [{ id: 999 }] });
    await expect(
      store.read({ kind: "user", workspaceId, userId: "other" }, { id }),
    ).rejects.toMatchObject({ code: "response_not_found" });
    allowed = false;
    await expect(store.describe(principal, id)).rejects.toMatchObject({
      code: "response_not_found",
    });
    allowed = true;
    await store.delete(principal, parent.id);
    await expect(store.read(principal, { id })).rejects.toMatchObject({
      code: "response_not_found",
    });
    expect((await store.list({ principal })).records).toEqual([]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("reports skipped types and rejects overflow and executable specifications", async () => {
  const root = await mkdtemp(join(tmpdir(), "tack-scan-types-"));
  const store = await createResponseStore({ root, workspaceId });
  try {
    const parent = await store.retain(
      principal,
      {
        formatVersion: 1,
        kind: "tool-response",
        upstreamOutcome: "succeeded",
        data: [{ n: 2 }, { n: "3" }, { n: null }, {}, { n: 5 }],
        text: "",
      },
      { upstreamOutcome: "succeeded" },
    );
    const sum = await store.scan(principal, {
      id: parent.id,
      pointer: "/data",
      spec: { operation: "sum", value: "/n" },
    });
    expect(sum).toMatchObject({
      data: 7,
      numericCount: 2,
      provenance: { coverage: { skippedTypeCount: 3 } },
    });
    const exact = await store.scan(principal, {
      id: parent.id,
      pointer: "/data",
      spec: {
        operation: "count",
        where: [{ pointer: "/n", op: "ne", value: 2 }],
      },
    });
    expect(exact).toMatchObject({
      data: 1,
      provenance: { coverage: { skippedTypeCount: 3 } },
    });
    const empty = await store.scan(principal, {
      id: parent.id,
      pointer: "/data",
      spec: { operation: "min", value: "/missing" },
    });
    expect(empty.data).toBeNull();
    await expect(
      store.scan(principal, {
        id: parent.id,
        spec: { operation: "rows", callback: "fetch('http://invalid')" },
      }),
    ).rejects.toMatchObject({ code: "scan_spec_invalid" });
    await expect(
      store.scan(principal, {
        id: parent.id,
        spec: { operation: "count" },
        limit: 100001,
      }),
    ).rejects.toMatchObject({ code: "scan_options_invalid" });
    const huge = await store.retain(
      principal,
      {
        formatVersion: 1,
        kind: "tool-response",
        upstreamOutcome: "succeeded",
        data: [1e308, 1e308],
        text: "",
      },
      { upstreamOutcome: "succeeded" },
    );
    await expect(
      store.scan(principal, {
        id: huge.id,
        pointer: "/data",
        spec: { operation: "sum", value: "" },
      }),
    ).rejects.toMatchObject({ code: "scan_numeric_overflow" });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("stops before the artifact cap without dropping the next row", async () => {
  const root = await mkdtemp(join(tmpdir(), "tack-scan-cap-"));
  const store = await createResponseStore({
    root,
    workspaceId,
    limits: { maxResponseBytes: 32768, maxReadBytes: 16384 },
  });
  try {
    const parent = await store.retain(
      principal,
      {
        formatVersion: 1,
        kind: "tool-response",
        upstreamOutcome: "succeeded",
        data: Array.from({ length: 200 }, (_, id) => ({
          id,
          text: "x".repeat(100),
        })),
        text: "",
      },
      { upstreamOutcome: "succeeded" },
    );
    const spec = {
      operation: "rows",
      select: [
        { name: "a", pointer: "/text" },
        { name: "b", pointer: "/text" },
        { name: "id", pointer: "/id" },
      ],
    };
    const first = await store.scan(principal, {
      id: parent.id,
      pointer: "/data",
      spec,
    });
    expect(first.delivery).toBe("stored");
    expect(first.provenance.coverage).toMatchObject({
      complete: false,
      stopReason: "artifact_limit",
    });
    const offset = first.provenance.coverage.nextOffset!;
    expect(offset).toBeGreaterThan(0);
    const second = await store.scan(principal, {
      id: parent.id,
      pointer: "/data",
      spec,
      offset,
      response: "store",
    });
    expect(
      first.provenance.coverage.scanned + second.provenance.coverage.scanned,
    ).toBe(200);
    expect(second.provenance.coverage).toMatchObject({
      complete: false,
      nextOffset: null,
    });
    const firstRow = await store.read(principal, {
      id: second.response!.id,
      pointer: "/data",
      offset: 0,
      limit: 1,
    });
    expect(firstRow.value).toMatchObject([{ id: offset }]);
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(
      store.scan(principal, {
        id: parent.id,
        pointer: "/data",
        spec,
        signal: cancellation.signal,
      }),
    ).rejects.toThrow();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
