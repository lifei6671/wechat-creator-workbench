import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectSegments } from "./probe-zhuque.mjs";

test("probe distinguishes Unicode offset units without storing echoed text",()=>{
  const text="中😀e\u0301尾";
  const units=[[[5,6],"utf16:half-open"],[[4,5],"unicode-scalar:half-open"],[[10,13],"utf8:half-open"]];
  for(const [position,unit] of units) {
    const result=inspectSegments(text,[{text:"尾",position,label:1,conf:.8}])[0];
    assert.ok(result.offsetCandidates.includes(unit),`${JSON.stringify(position)} should match ${unit}`);
    assert.equal(Object.hasOwn(result,"text"),false);
  }
  assert.deepEqual(inspectSegments(text,[{text:"不存在",position:[0,2]}])[0].offsetCandidates,[]);
  assert.ok(inspectSegments(text,[{text:"尾",position:[4,1]}])[0].offsetCandidates.includes("unicode-scalar:start-length"));
});
