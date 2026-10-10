import { expect, test } from "vitest";
import { convexTest } from "../index";
import { compareValues, Value } from "convex/values";
import schema from "./schema";
import { Doc, Id } from "./_generated/dataModel";

// Index reads use binary search on sorted indexes. Compare them with a plain
// filter and sort over all docs, after inserts, patches and deletes, and with
// pending writes in the current transaction.
test("index reads match a filter and sort over all docs", async () => {
  const t = convexTest(schema);
  const ids: Id<"messages">[] = [];
  const authors = ["a", "b", "c"];

  await t.run(async (ctx) => {
    for (let i = 0; i < 60; i++) {
      ids.push(
        await ctx.db.insert("messages", {
          author: authors[i % 3],
          body: `m${i % 7}`,
          score: i % 5 === 0 ? undefined : (i * 7) % 11,
        }),
      );
    }
  });

  const check = async (ctx: any) => {
    // `db.get` does not use indexes, so it gives the expected docs.
    const all: Doc<"messages">[] = (
      await Promise.all(ids.map((id) => ctx.db.get(id)))
    ).filter((doc) => doc !== null);
    const sorted = (fields: string[], docs: Doc<"messages">[]) =>
      [...docs].sort((x: any, y: any) => {
        for (const field of fields) {
          const v = compareValues(x[field] as Value, y[field] as Value);
          if (v !== 0) {
            return v;
          }
        }
        return 0;
      });
    const authorScore = ["author", "score", "_creationTime", "_id"];
    const bScores = sorted(
      authorScore,
      all.filter((doc) => doc.author === "b"),
    );
    const byIds = (docs: Doc<"messages">[]) => docs.map((doc) => doc._id);

    expect(
      byIds(
        await ctx.db
          .query("messages")
          .withIndex("author_score", (q: any) => q.eq("author", "b"))
          .collect(),
      ),
    ).toEqual(byIds(bScores));
    expect(
      byIds(
        await ctx.db
          .query("messages")
          .withIndex("author_score", (q: any) => q.eq("author", "b"))
          .order("desc")
          .collect(),
      ),
    ).toEqual(byIds(bScores).reverse());
    expect(
      byIds(
        await ctx.db
          .query("messages")
          .withIndex("author_score", (q: any) =>
            q.eq("author", "b").gt("score", 2).lte("score", 7),
          )
          .collect(),
      ),
    ).toEqual(
      byIds(
        bScores.filter(
          (doc) => doc.score !== undefined && doc.score > 2 && doc.score <= 7,
        ),
      ),
    );
    expect(
      byIds(
        await ctx.db
          .query("messages")
          .withIndex("author_score", (q: any) =>
            q.eq("author", "a").lt("score", 5),
          )
          .collect(),
      ),
    ).toEqual(
      byIds(
        sorted(
          authorScore,
          all.filter(
            (doc) =>
              doc.author === "a" && (doc.score === undefined || doc.score < 5),
          ),
        ),
      ),
    );
    expect(
      byIds(
        await ctx.db
          .query("messages")
          .withIndex("author_body", (q: any) =>
            q.eq("author", "b").eq("body", "moved"),
          )
          .take(3),
      ),
    ).toEqual(
      byIds(
        sorted(
          ["_creationTime", "_id"],
          all.filter((doc) => doc.author === "b" && doc.body === "moved"),
        ).slice(0, 3),
      ),
    );

    const byCreationTime = sorted(["_creationTime", "_id"], all);
    expect(
      byIds(await ctx.db.query("messages").order("desc").collect()),
    ).toEqual(byIds(byCreationTime).reverse());
    const middle = byCreationTime[Math.floor(byCreationTime.length / 2)];
    expect(
      byIds(
        await ctx.db
          .query("messages")
          .withIndex("by_creation_time", (q: any) =>
            q.gte("_creationTime", middle._creationTime),
          )
          .collect(),
      ),
    ).toEqual(
      byIds(
        byCreationTime.filter(
          (doc) => doc._creationTime >= middle._creationTime,
        ),
      ),
    );
    expect(
      byIds(
        await ctx.db
          .query("messages")
          .withIndex("by_id", (q: any) => q.eq("_id", middle._id))
          .collect(),
      ),
    ).toEqual([middle._id]);

    return byIds(bScores);
  };

  // Build the indexes, so the next commit must update them.
  await t.run(check);

  // Change index fields of committed docs, and delete some.
  await t.run(async (ctx) => {
    for (const id of ids.slice(0, 10)) {
      await ctx.db.patch(id, { score: 3 });
    }
    for (const id of ids.slice(10, 15)) {
      await ctx.db.delete(id);
    }
    for (const id of ids.slice(15, 20)) {
      await ctx.db.patch(id, { author: "b", body: "moved" });
    }
  });

  // Committed docs only.
  const expectedPages = await t.run(check);

  // Paginate walks the same order. Only one paginate call is allowed per
  // function, so each page runs in its own function.
  const pages: Id<"messages">[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("author_score", (q) => q.eq("author", "b"))
        .paginate({ cursor, numItems: 4 }),
    );
    pages.push(...result.page.map((doc) => doc._id));
    if (result.isDone) {
      break;
    }
    cursor = result.continueCursor;
  }
  expect(pages).toEqual(expectedPages);

  // With pending writes that move docs in and out of the ranges.
  await t.run(async (ctx) => {
    ids.push(
      await ctx.db.insert("messages", { author: "b", body: "new", score: 4 }),
    );
    await ctx.db.patch(ids[20], { score: 6 });
    await ctx.db.patch(ids[21], { author: "b", body: "moved" });
    await ctx.db.delete(ids[22]);
    await check(ctx);
  });

  // The same writes, now committed into the indexes.
  await t.run(check);
});
