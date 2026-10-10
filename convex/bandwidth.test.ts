import { expect, test, vi } from "vitest";
import { getDocumentSize } from "convex/values";
import { convexTest } from "../index";
import schema from "./schema";

test("default: limits disabled, no throws", async () => {
  const t = convexTest({ schema });
  // Insert many docs without hitting limits (default is disabled)
  await t.run(async (ctx) => {
    for (let i = 0; i < 100; i++) {
      await ctx.db.insert("messages", {
        author: "sarah",
        body: "x".repeat(1000),
      });
    }
  });
  // Read them all back
  const result = await t.query(async (ctx) => {
    return await ctx.db.query("messages").collect();
  });
  expect(result.length).toEqual(100);
});

test("read byte limit exceeded throws", async () => {
  const t = convexTest({
    schema,
    transactionLimits: {
      bytesRead: 500,
      documentsRead: 100000,
      databaseQueries: 100,
    },
  });
  await t.run(async (ctx) => {
    for (let i = 0; i < 10; i++) {
      await ctx.db.insert("messages", {
        author: "sarah",
        body: "x".repeat(200),
      });
    }
  });
  await expect(
    t.query(async (ctx) => {
      return await ctx.db.query("messages").collect();
    }),
  ).rejects.toThrow(/Read too much data/);
});

const MiB = 1 << 20;

test("read document limit exceeded throws", async () => {
  const t = convexTest({
    schema,
    transactionLimits: {
      bytesRead: 16 * MiB,
      documentsRead: 5,
      databaseQueries: 100,
    },
  });
  await t.run(async (ctx) => {
    for (let i = 0; i < 10; i++) {
      await ctx.db.insert("messages", { author: "sarah", body: `msg${i}` });
    }
  });
  await expect(
    t.query(async (ctx) => {
      return await ctx.db.query("messages").collect();
    }),
  ).rejects.toThrow(/Scanned too many documents/);
});

test("write byte limit exceeded throws", async () => {
  const t = convexTest({
    schema,
    transactionLimits: {
      bytesWritten: 500,
      documentsWritten: 100000,
    },
  });
  await expect(
    t.mutation(async (ctx) => {
      for (let i = 0; i < 10; i++) {
        await ctx.db.insert("messages", {
          author: "sarah",
          body: "x".repeat(200),
        });
      }
    }),
  ).rejects.toThrow(/Wrote too much data/);
});

test("write document limit exceeded throws", async () => {
  const t = convexTest({
    schema,
    transactionLimits: {
      bytesWritten: 16 * MiB,
      documentsWritten: 3,
    },
  });
  await expect(
    t.mutation(async (ctx) => {
      for (let i = 0; i < 10; i++) {
        await ctx.db.insert("messages", { author: "sarah", body: `msg${i}` });
      }
    }),
  ).rejects.toThrow(/Wrote too many documents/);
});

test("index range limit exceeded throws", async () => {
  const t = convexTest({
    schema,
    transactionLimits: {
      bytesRead: 16 * MiB,
      documentsRead: 100000,
      databaseQueries: 2,
    },
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("messages", { author: "sarah", body: "hello" });
  });
  await expect(
    t.query(async (ctx) => {
      // Each db.get counts as one index range read
      const docs = await ctx.db.query("messages").collect();
      await ctx.db.get(docs[0]._id);
      await ctx.db.get(docs[0]._id);
      // The query itself used one range, plus two gets = 3 total, limit is 2
    }),
  ).rejects.toThrow(/Too many index ranges/);
});

test("limits accumulate within a transaction", async () => {
  const t = convexTest({
    schema,
    transactionLimits: {
      bytesRead: 16 * MiB,
      documentsRead: 5,
      databaseQueries: 2,
    },
  });
  await t.run(async (ctx) => {
    for (let i = 0; i < 10; i++) {
      await ctx.db.insert("messages", { author: "sarah", body: `msg${i}` });
    }
  });
  // A mutation that reads more docs than the limit
  await expect(
    t.mutation(async (ctx) => {
      // Reading 10 docs exceeds the limit of 5
      return await ctx.db.query("messages").collect();
    }),
  ).rejects.toThrow(/Scanned too many documents/);
});

test("getTransactionMetrics returns bandwidth stats", async () => {
  const t = convexTest({ schema });
  await t.run(async (ctx) => {
    await ctx.db.insert("messages", { author: "sarah", body: "hello" });
    await ctx.db.insert("messages", { author: "michal", body: "world" });
  });
  const { consumption, totalBytes } = await t.query(async (ctx) => {
    const docs = await ctx.db.query("messages").collect();
    const totalBytes = docs.reduce((sum, doc) => sum + getDocumentSize(doc), 0);
    const consumption = await ctx.meta.getTransactionMetrics();
    return { consumption, totalBytes };
  });
  expect(consumption.documentsRead.used).toBe(2);
  expect(consumption.bytesRead.used).toBe(totalBytes);
  expect(consumption.databaseQueries.used).toBe(1);
  expect(consumption.documentsRead.remaining).toBe(32000 - 2);
  expect(consumption.bytesRead.remaining).toBe((16 << 20) - totalBytes);
  expect(consumption.bytesWritten.used).toBe(0);
  expect(consumption.documentsWritten.used).toBe(0);
  expect(consumption.functionsScheduled.used).toBe(0);
  expect(consumption.scheduledFunctionArgsBytes.used).toBe(0);
});

test("warm native reads reuse the stored document size", async () => {
  const t = convexTest({ schema });
  const body = "size-cache-é🐒".repeat(100);
  const id = await t.mutation(async (ctx) => {
    return await ctx.db.insert("messages", { author: "sarah", body });
  });
  const doc = (await t.query(async (ctx) => await ctx.db.get(id)))!;
  const docBytes = getDocumentSize(doc);
  const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode");
  try {
    let endCursor: string | null = null;
    for (let pass = 0; pass < 2; pass++) {
      const pageOptions =
        endCursor === null ? { maximumBytesRead: docBytes } : { endCursor };
      const result = await t.query(async (ctx) => {
        const got = await ctx.db.get(id);
        const first = await ctx.db
          .query("messages")
          .withIndex("author", (q) => q.eq("author", "sarah"))
          .first();
        const page = await ctx.db
          .query("messages")
          .withIndex("author", (q) => q.eq("author", "sarah"))
          .paginate({ cursor: null, numItems: 1, ...pageOptions });
        const consumption = await ctx.meta.getTransactionMetrics();
        return { got, first, page, consumption };
      });
      expect(result.got).toEqual(doc);
      expect(result.first).toEqual(doc);
      expect(result.page.page).toEqual([doc]);
      expect(result.page.isDone).toBe(false);
      expect(result.page.continueCursor).not.toBe("_end_cursor");
      expect(result.page.pageStatus).toBe(pass === 0 ? "SplitRequired" : null);
      expect(result.page.splitCursor).toBeNull();
      if (endCursor !== null) {
        expect(result.page.continueCursor).toBe(endCursor);
      }
      expect(result.consumption.documentsRead.used).toBe(3);
      expect(result.consumption.bytesRead.used).toBe(3 * docBytes);
      expect(result.consumption.databaseQueries.used).toBe(3);
      expect(result.consumption.documentsWritten.used).toBe(0);
      expect(result.consumption.bytesWritten.used).toBe(0);
      endCursor = result.page.continueCursor;
    }
    expect(
      encodeSpy.mock.calls.filter(([value]) => value === body).length,
      "Warm native reads reuse the stored document size",
    ).toBe(0);
  } finally {
    encodeSpy.mockRestore();
  }
});

test("getTransactionMetrics tracks writes", async () => {
  const t = convexTest({ schema });
  const { consumption, docBytes } = await t.mutation(async (ctx) => {
    const id = await ctx.db.insert("messages", {
      author: "sarah",
      body: "hello",
    });
    const doc = (await ctx.db.get(id))!;
    const docBytes = getDocumentSize(doc);
    const consumption = await ctx.meta.getTransactionMetrics();
    return { consumption, docBytes };
  });
  expect(consumption.documentsWritten.used).toBe(1);
  expect(consumption.bytesWritten.used).toBe(docBytes);
});

test("document byte counts follow patch, replace and rollback", async () => {
  const t = convexTest({ schema });
  const id = await t.mutation(async (ctx) => {
    return await ctx.db.insert("messages", {
      author: "sarah",
      body: "original-é".repeat(100),
    });
  });
  let previous = (await t.query(async (ctx) => await ctx.db.get(id)))!;
  for (const operation of ["patch", "replace"] as const) {
    const body =
      operation === "patch" ? "patched-🐒".repeat(200) : "replacement-é";
    const result = await t.mutation(async (ctx) => {
      if (operation === "patch") {
        await ctx.db.patch(id, { body });
      } else {
        await ctx.db.replace(id, { author: "sarah", body });
      }
      const doc = (await ctx.db.get(id))!;
      const consumption = await ctx.meta.getTransactionMetrics();
      return { doc, consumption };
    });
    const docBytes = getDocumentSize(result.doc);
    expect(result.doc).toEqual({ ...previous, body });
    expect(result.consumption.documentsRead.used).toBe(2);
    expect(result.consumption.bytesRead.used).toBe(
      getDocumentSize(previous) + docBytes,
    );
    expect(result.consumption.documentsWritten.used).toBe(1);
    expect(result.consumption.bytesWritten.used).toBe(docBytes);
    expect(await t.query(async (ctx) => await ctx.db.get(id))).toEqual(result.doc);
    previous = result.doc;
  }
  const committedBytes = getDocumentSize(previous);
  await expect(
    t.mutation(async (ctx) => {
      const body = "rolled-back-🐒".repeat(300);
      await ctx.db.patch(id, { body });
      const doc = (await ctx.db.get(id))!;
      const docBytes = getDocumentSize(doc);
      const consumption = await ctx.meta.getTransactionMetrics();
      expect(doc).toEqual({ ...previous, body });
      expect(consumption.documentsRead.used).toBe(2);
      expect(consumption.bytesRead.used).toBe(committedBytes + docBytes);
      expect(consumption.documentsWritten.used).toBe(1);
      expect(consumption.bytesWritten.used).toBe(docBytes);
      throw new Error("Roll back the changed document");
    }),
  ).rejects.toThrow("Roll back the changed document");
  const result = await t.query(async (ctx) => {
    const doc = await ctx.db.get(id);
    const consumption = await ctx.meta.getTransactionMetrics();
    return { doc, consumption };
  });
  expect(result.doc).toEqual(previous);
  expect(result.consumption.documentsRead.used).toBe(1);
  expect(result.consumption.bytesRead.used).toBe(committedBytes);
  expect(result.consumption.documentsWritten.used).toBe(0);
  expect(result.consumption.bytesWritten.used).toBe(0);
});
