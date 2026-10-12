import { expect, test } from "vitest";
import { convexTest } from "../index";
import schema from "./schema";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

test("extra fields", async () => {
  const t = convexTest(schema);
  await expect(
    async () =>
      await t.run(async (ctx) => {
        await ctx.db.insert("messages", {
          author: "sarah",
          body: "hello1",
          extraField: true,
        } as any);
      }),
  ).rejects.toThrowError("Validator error");
});

test("patch", async () => {
  const t = convexTest(schema);
  await expect(
    async () =>
      await t.run(async (ctx) => {
        const id = await ctx.db.insert("messages", {
          author: "sarah",
          body: "hello",
        });
        await ctx.db.patch(id, { author: false as any });
      }),
  ).rejects.toThrowError("Validator error");
});

test("patch removes fields before validating a union", async () => {
  const t = convexTest(
    defineSchema({
      messages: defineTable(
        v.union(
          v.object({ kind: v.literal("active"), view: v.string() }),
          v.object({ kind: v.literal("idle") }),
        ),
      ),
    }),
  );
  const id = await t.run((ctx) =>
    ctx.db.insert("messages", { kind: "active", view: "before" }),
  );
  await expect(
    t.run(async (ctx) => {
      const patch = { kind: "idle" as const, view: undefined };
      await ctx.db.patch("messages", id, patch);
      return ctx.db.get("messages", id);
    }),
    "a union patch removes old fields before validation",
  ).resolves.toMatchObject({ _id: id, kind: "idle" });
  expect(await t.run((ctx) => ctx.db.get("messages", id))).not.toHaveProperty(
    "view",
  );
  await t.run((ctx) =>
    ctx.db.patch("messages", id, { kind: "active", view: "after" }),
  );
  await expect(
    t.run((ctx) => ctx.db.patch("messages", id, { view: undefined })),
  ).rejects.toThrowError("Validator error");
  expect(await t.run((ctx) => ctx.db.get("messages", id))).toMatchObject({
    _id: id,
    kind: "active",
    view: "after",
  });
});

test("replace", async () => {
  const t = convexTest(schema);
  await expect(
    async () =>
      await t.run(async (ctx) => {
        const id = await ctx.db.insert("messages", {
          author: "sarah",
          body: "hello",
        });
        await ctx.db.replace(id, { author: null as any, body: "hey" });
      }),
  ).rejects.toThrowError("Validator error");
});

test("arrays", async () => {
  const t = convexTest(
    defineSchema({
      messages: defineTable({
        values: v.array(v.number()),
      }),
    }),
  );
  await expect(
    async () =>
      await t.run(async (ctx) => {
        await ctx.db.insert("messages", {
          values: ["bad" as any],
        });
      }),
  ).rejects.toThrowError("Validator error");
});

test("ids", async () => {
  const t = convexTest(
    defineSchema({
      messages: defineTable({
        author: v.optional(v.id("users")),
      }),
    }),
  );
  await expect(
    async () =>
      await t.run(async (ctx) => {
        await ctx.db.insert("messages", {
          author: "no bueno" as any,
        });
      }),
  ).rejects.toThrowError("Validator error");
  await expect(
    async () =>
      await t.run(async (ctx) => {
        const messageId = await ctx.db.insert("messages", {});
        await ctx.db.insert("messages", {
          author: messageId as any,
        });
      }),
  ).rejects.toThrowError("Validator error");
});

test("schema validation off", async () => {
  const t = convexTest(
    defineSchema(
      {
        messages: defineTable({
          author: v.string(),
        }),
      },
      { schemaValidation: false },
    ),
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("messages", {
      author: 3,
      extraField: true,
    } as any);
  });
});

// Valid values take a fast check that throws nothing. Invalid values must
// still throw the same errors as before, also deep inside nested unions.
test("unions", async () => {
  const t = convexTest(
    defineSchema({
      messages: defineTable({
        value: v.union(
          v.object({ kind: v.literal("a"), n: v.number() }),
          v.object({ kind: v.literal("b"), s: v.optional(v.string()) }),
          v.null(),
          v.array(v.union(v.string(), v.int64())),
        ),
        nested: v.optional(
          v.union(
            v.object({
              kind: v.literal("a"),
              inner: v.union(
                v.literal("x"),
                v.literal("y"),
                v.object({ deep: v.union(v.number(), v.null()) }),
              ),
            }),
            v.union(v.string(), v.array(v.union(v.boolean(), v.int64()))),
          ),
        ),
        lit: v.optional(v.union(v.literal("p"), v.literal("q"), v.literal(3))),
      }),
    }),
  );
  await t.run(async (ctx) => {
    for (const doc of [
      { value: { kind: "a", n: 1 } },
      { value: { kind: "b" } },
      { value: { kind: "b", s: "x" } },
      { value: null },
      { value: ["x", 2n] },
      { value: null, nested: { kind: "a", inner: "x" } },
      { value: null, nested: { kind: "a", inner: { deep: null } } },
      { value: null, nested: { kind: "a", inner: { deep: 2 } } },
      { value: null, nested: "s" },
      { value: null, nested: [true, 1n] },
      { value: null, lit: "q" },
      { value: null, lit: 3 },
    ]) {
      await ctx.db.insert("messages", doc as any);
    }
  });
  // The same texts as before the fast check was added.
  const top =
    "Validator error: Expected one of object, object, null, array, got";
  const nested = "Validator error: Expected one of object, union, got";
  const lit = "Validator error: Expected one of literal, literal, literal, got";
  for (const [doc, message] of [
    [{ value: { kind: "a", n: "1" } }, `${top} \`{"kind":"a","n":"1"}\``],
    [{ value: { kind: "b", extra: 1 } }, `${top} \`{"extra":1,"kind":"b"}\``],
    [{ value: { kind: "c" } }, `${top} \`{"kind":"c"}\``],
    [{ value: [1] }, `${top} \`[1]\``],
    [{ value: "x" }, `${top} \`"x"\``],
    [{}, "Validator error: Missing required field `value` in object"],
    [
      { value: null, nested: { kind: "a", inner: "z" } },
      `${nested} \`{"inner":"z","kind":"a"}\``,
    ],
    [
      { value: null, nested: { kind: "a", inner: { deep: "1" } } },
      `${nested} \`{"inner":{"deep":"1"},"kind":"a"}\``,
    ],
    [
      { value: null, nested: { kind: "a", inner: { deep: 1, more: 1 } } },
      `${nested} \`{"inner":{"deep":1,"more":1},"kind":"a"}\``,
    ],
    [{ value: null, nested: { kind: "a" } }, `${nested} \`{"kind":"a"}\``],
    [{ value: null, nested: [true, 1] }, `${nested} \`[true,1]\``],
    [{ value: null, nested: 5 }, `${nested} \`5\``],
    [{ value: null, lit: "r" }, `${lit} \`"r"\``],
    [{ value: null, lit: "3" }, `${lit} \`"3"\``],
    [
      { value: null, other: 1 },
      "Validator error: Unexpected field `other` in object",
    ],
  ] as const) {
    let error: any = null;
    try {
      await t.run(async (ctx) => {
        await ctx.db.insert("messages", doc as any);
      });
    } catch (e) {
      error = e;
    }
    expect(error?.message).toEqual(message);
  }
});
