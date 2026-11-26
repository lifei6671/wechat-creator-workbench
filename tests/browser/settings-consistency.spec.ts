import { expect, test } from "@playwright/test";

for (const appearance of ["light", "dark"]) test(`review settings match shared settings controls in ${appearance}`,async({page})=>{
  await page.goto(`/tests/article-review.html?settings=1${appearance==="dark"?"&dark=1":""}`);
  const review=page.locator("#settings-section-review");
  await expect(review.getByRole("button",{name:"测试连接",exact:true})).toBeEnabled();
  await expect(review.locator(".settings-card")).toHaveCount(1);
  await expect(review.locator(".settings-card")).toContainText("本机用量");
  await expect(review.locator(".settings-card")).toContainText("结果缓存");
  await expect(review.locator(".settings-group-title")).toHaveCount(0);
  await expect(review.getByRole("button",{name:"删除",exact:true})).toHaveAttribute("data-accent-color","red");
  const measure=()=>review.evaluate(section=>{
    const style=(element:Element)=>{const css=getComputedStyle(element);const box=element.getBoundingClientRect();return {font:css.fontSize,radius:css.borderRadius,shadow:css.boxShadow,height:box.height,width:box.width,weight:css.fontWeight}};
    return {field:style(section.querySelector('#review-key')!.closest('.rt-TextFieldRoot')!),
      toggle:style(section.querySelector('#review-enabled')!),button:style(section.querySelector('.settings-footer button[type="submit"]')!),
      card:style(section.querySelector('.settings-card')!),
      footerAlign:getComputedStyle(section.querySelector('.settings-footer')!).justifyContent};
  });
  const actual=await measure();
  await page.getByRole("button",{name:"S3 图床",exact:true}).click();
  const reference=page.getByTestId("reference-settings");
  await expect(reference).toBeVisible();
  const standard=await reference.evaluate(section=>{
    const css=getComputedStyle(section.querySelector('#images-endpoint')!.closest('.rt-TextFieldRoot')!);
    const field=section.querySelector('#images-endpoint')!.closest('.rt-TextFieldRoot')!.getBoundingClientRect();
    const button=section.querySelector('.settings-footer button[type="button"]:last-child')!;
    return {font:css.fontSize,radius:css.borderRadius,shadow:css.boxShadow,height:field.height,width:field.width,
      buttonHeight:button.getBoundingClientRect().height,buttonFont:getComputedStyle(button).fontSize,
      cardRadius:getComputedStyle(section).borderRadius};
  });
  expect(actual.field).toMatchObject({font:standard.font,radius:standard.radius,shadow:standard.shadow,height:standard.height,width:standard.width});
  expect(actual.button.height).toBe(standard.buttonHeight);expect(actual.button.font).toBe(standard.buttonFont);
  expect(actual.card.radius).toBe(standard.cardRadius);expect(actual.footerAlign).toBe("flex-end");
  await page.getByRole("button",{name:"通用",exact:true}).click();
  const toggle=page.getByRole("switch",{name:"显示资源导航",exact:true});
  const standardToggle=await toggle.evaluate(element=>{const css=getComputedStyle(element);const box=element.getBoundingClientRect();return {radius:css.borderRadius,height:box.height,width:box.width}});
  expect(actual.toggle).toMatchObject(standardToggle);
  await page.getByRole("button",{name:"文章审查",exact:true}).click();
  for(const width of [1000,1360]){
    await page.setViewportSize({width,height:840});
    await expect(review).toBeVisible();
    expect(await review.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  }
  await page.screenshot({path:`output/playwright/review-settings-consistent-${appearance}.png`});
});

test("connection testing uses an unsaved key with the service disabled and does not save settings",async({page})=>{
  await page.goto("/tests/article-review.html?settings=1&unconfigured=1");
  const section=page.locator("#settings-section-review");
  const button=section.getByRole("button",{name:"测试连接",exact:true});
  await expect(section.getByText("未配置",{exact:true})).toBeVisible();
  await expect(button).toBeDisabled();
  const key=section.getByLabel("API Key",{exact:true});
  await key.fill("   ");
  await expect(button).toBeDisabled();
  await key.fill("  synthetic-draft-key  ");
  await expect(button).toBeEnabled();
  await expect(section.getByRole("switch",{name:"朱雀文本检测",exact:true})).not.toBeChecked();
  await button.click();
  await expect(section.getByRole("button",{name:"连接成功",exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>window.reviewSettingsHarness)).toEqual({connectionKeys:["synthetic-draft-key"],savedSettings:[]});
  await expect(key).toHaveValue("  synthetic-draft-key  ");
  await expect(section.getByText("未配置",{exact:true})).toBeVisible();
});

test("connection testing prefers the draft over a saved key and falls back after clearing the field",async({page})=>{
  await page.goto("/tests/article-review.html?settings=1");
  const section=page.locator("#settings-section-review");
  const button=section.getByRole("button",{name:"测试连接",exact:true});
  await expect(button).toBeEnabled();
  const key=section.getByLabel("API Key",{exact:true});
  await key.fill("synthetic-replacement-key");
  await button.click();
  await expect(button).toBeEnabled();
  await key.fill("");
  await button.click();
  await expect(section.getByRole("button",{name:"连接成功",exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>window.reviewSettingsHarness)).toEqual({connectionKeys:["synthetic-replacement-key",undefined],savedSettings:[]});
});

test("review settings error replaces the hint without moving controls or usage",async({page})=>{
  await page.goto("/tests/article-review.html?settings=1&failure=1");
  const section=page.locator("#settings-section-review");
  const button=section.getByRole("button",{name:"测试连接",exact:true});
  await expect(button).toBeEnabled();
  const before=await section.locator(".review-usage").boundingBox();
  await button.click();
  await expect(section.getByRole("alert")).toHaveText("合成连接失败");
  const after=await section.locator(".review-usage").boundingBox();
  expect(after).toEqual(before);
  await expect(section.getByRole("button",{name:"连接失败",exact:true})).toBeDisabled();
});
