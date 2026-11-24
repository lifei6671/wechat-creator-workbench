import { test } from "node:test";
import assert from "node:assert/strict";
import { operation } from "../dist/protocol.js";

const request = authors => ({ operationId: "authors", mutations: [{ entityType: "wechat_publication_defaults", entityId: "default", baseRevision: 0,
  operation: "upsert", payload: { schemaVersion: 1, recommendationCount: 5, updatedAt: 1, ...(authors === undefined ? {} : { recommendationAuthors: authors }) } }] });

test("publication defaults accept legacy payloads, empty filters and multiple exact authors", () => {
  for (const authors of [undefined, [], ["李飞", "Alice", "alice"]]) assert.doesNotThrow(() => operation(request(authors)));
});

test("publication defaults reject invalid author lists", () => {
  for (const authors of [null, "李飞", [1], [""], [" 李飞"], ["李飞", "李飞"]]) {
    assert.throws(() => operation(request(authors)), /invalid_publication_defaults/);
  }
});
