import { expect, test } from "@playwright/test";

test.beforeEach(async ({page})=>{
  await page.goto("/tests/article-review.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready","true");
  await expect(page.getByRole("button",{name:"检测全文",exact:true})).toBeEnabled();
});

test("full review uses a live snapshot, has real pending feedback, navigates and invalidates without changing Markdown",async({page})=>{
  const markdown=await page.evaluate(()=>window.reviewHarness.markdown());
  await expect(page.getByRole("button",{name:"检测选区",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"检测全文",exact:true}).click();
  await expect(page.getByRole("button",{name:"检测全文",exact:true})).toBeDisabled();
  const calls=await page.evaluate(()=>window.reviewHarness.calls);
  expect(calls).toHaveLength(1);expect(calls[0].text).toContain("第一段中文😀");expect(calls[0].text).not.toContain("private code");expect(calls[0].text).not.toContain("ignored");
  await page.evaluate(()=>window.reviewHarness.complete());
  await expect(page.getByText("待复核内容（1）")).toBeVisible();
  await expect(page.locator(".review-mark")).toHaveCount(1);
  expect(await page.evaluate(()=>window.reviewHarness.markdown())).toBe(markdown);
  await page.locator(".review-finding").click();
  expect(await page.evaluate(()=>window.reviewHarness.selection())).toContain("正文标题");
  await page.getByRole("checkbox",{name:"正文标记"}).uncheck();
  await expect(page.locator(".review-mark")).toHaveCount(0);
  await page.getByRole("checkbox",{name:"正文标记"}).check();
  await page.locator(".ProseMirror").press("End");await page.locator(".ProseMirror").press("x");
  await expect(page.getByText("正文已修改，请重新检测。")).toBeVisible();
  await expect(page.locator(".review-mark")).toHaveCount(0);
  await expect(page.locator(".review-ratios")).toHaveCount(0);
  expect(await page.evaluate(()=>window.reviewHarness.calls.length)).toBe(1);
});

test("an edited snapshot and a switched article reject late responses",async({page})=>{
  await page.getByRole("button",{name:"检测全文",exact:true}).click();
  await page.locator(".ProseMirror").press("End");await page.locator(".ProseMirror").press("x");
  await page.evaluate(()=>window.reviewHarness.complete());
  await expect(page.getByText("正文已修改，请重新检测。")).toBeVisible();
  await expect(page.locator(".review-mark")).toHaveCount(0);
  await page.getByRole("button",{name:"检测全文",exact:true}).click();
  await page.evaluate(()=>window.reviewHarness.swap());
  await expect(page.getByRole("button",{name:"检测全文",exact:true})).toBeEnabled();
  await page.evaluate(()=>window.reviewHarness.complete());
  await expect(page.locator(".review-ratios")).toHaveCount(0);
  await expect(page.locator(".review-mark")).toHaveCount(0);
});

test("configuration changes and a closed panel cannot revive old diagnostics",async({page})=>{
  await page.getByRole("button",{name:"检测全文",exact:true}).click();
  await page.evaluate(()=>window.reviewHarness.configure());
  await page.evaluate(()=>window.reviewHarness.complete());
  await expect(page.locator(".review-ratios")).toHaveCount(0);
  await expect(page.getByRole("button",{name:"检测全文",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"检测全文",exact:true}).click();
  await page.getByRole("button",{name:"切换审查面板"}).click();
  await page.evaluate(()=>window.reviewHarness.complete());
  await expect(page.locator(".review-mark")).toHaveCount(0);
  await page.getByRole("button",{name:"切换审查面板"}).click();
  await expect(page.locator(".review-ratios")).toHaveCount(0);
});

test("selection review preserves its captured scope and forced recheck makes one explicit request",async({page})=>{
  await page.locator(".ProseMirror").focus();
  await page.locator(".ProseMirror").evaluate(host=>{
    const text=host.querySelector("p")!.firstChild!;
    const selection=window.getSelection()!;selection.setBaseAndExtent(text,0,text,7);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByRole("button",{name:"检测选区",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"检测选区",exact:true}).click();
  expect((await page.evaluate(()=>window.reviewHarness.calls))[0].text).toBe("第一段中文😀");
  await page.evaluate(()=>window.reviewHarness.complete());
  await expect(page.getByText("检测范围：选区")).toBeVisible();
  await expect(page.getByRole("button",{name:"重新检测",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"重新检测",exact:true}).click();
  expect((await page.evaluate(()=>window.reviewHarness.calls))[1].force).toBe(true);
  await page.evaluate(()=>window.reviewHarness.complete());
});

test("settings never reveal a saved key and retain usage after cache clearing",async({page})=>{
  await page.getByRole("button",{name:"审查设置",exact:true}).click();
  await expect(page.getByLabel("API Key",{exact:true})).toHaveValue("");
  await expect(page.getByText("2026-11（UTC 月）已观测扣减 60 token")).toBeVisible();
  await expect(page.locator(".review-usage")).toContainText("成功调用 3 次，其中 1 次用量未知");
  await page.getByRole("button",{name:"清理缓存",exact:true}).click();
  await expect(page.getByRole("button",{name:"已清理",exact:true})).toBeDisabled();
  await expect(page.getByText("2026-11（UTC 月）已观测扣减 60 token")).toBeVisible();
});

test("dark mode long documents build projection and decorations without network requests",async({page},testInfo)=>{
  await page.goto("/tests/article-review.html?dark=1");
  await expect(page.locator("body")).toHaveAttribute("data-ready","true");
  const samples=[];
  for(const length of [1000,5000,20000]) {
    const metrics=await page.evaluate(length=>window.reviewHarness.performance(length),length);
    expect(metrics.runs).toBe(length/100);
    expect(metrics.projectionMs).toBeLessThan(1000);
    expect(await page.evaluate(()=>window.reviewHarness.calls.length)).toBe(0);
    samples.push({length,...metrics});
  }
  console.log(`${testInfo.project.name} review performance ${JSON.stringify(samples)}`);
  await testInfo.attach("review-performance",{body:JSON.stringify(samples,null,2),contentType:"application/json"});
  await expect(page.locator(".review-mark")).toHaveCount(200);
});
