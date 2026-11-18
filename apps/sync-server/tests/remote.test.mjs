import { test } from "node:test";
import { runContract } from "./contract.mjs";

test("HTTP contract on an isolated fresh deployment", {
  skip: !process.env.SYNC_TEST_URL || !process.env.SYNC_TEST_SECRET,
  timeout: 180_000,
}, async (t) => {
  const { pageBytes } = await runContract(process.env.SYNC_TEST_URL, process.env.SYNC_TEST_SECRET);
  t.diagnostic("UTF-8 pull response bytes: " + pageBytes);
});
