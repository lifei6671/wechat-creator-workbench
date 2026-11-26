import { test, expect } from "@playwright/test";
for(const changed of [false,true]) test(`recovery comparison and version protection changed=${changed}`,async({page})=>{
  await page.goto('/tests/editor-recovery.html'+(changed?'?changed':''));
  const dialog=page.getByRole('dialog');
  await expect(dialog).toContainText('恢复正文');
  await expect(dialog).toContainText('正式正文');
  const title=await dialog.getByRole('heading',{name:'恢复未保存内容'}).boundingBox();
  const close=await dialog.getByRole('button',{name:'关闭',exact:true}).boundingBox();
  expect(Math.abs(title!.y+title!.height/2-close!.y-close!.height/2)).toBeLessThan(2);
  const restore=dialog.getByRole('button',{name:'恢复到原文档',exact:true});
  if(changed){await expect(restore).toBeDisabled();await expect(dialog.getByRole('button',{name:'另存草稿'})).toBeEnabled();}
  else{
    await page.clock.install();
    await restore.click();
    await expect(dialog.locator('.rt-Spinner')).toBeVisible();
    await expect(restore).toBeDisabled();
    expect(await page.evaluate(()=>window.editorRecoveryHarness.calls)).toBe(1);
    await page.clock.pauseAt(new Date(Date.now()+60_000));
    await expect(dialog.locator('.rt-Spinner')).toBeVisible();
    await page.evaluate(()=>window.editorRecoveryHarness.complete());
    await expect(dialog.getByRole('button',{name:'已恢复',exact:true})).toBeVisible();
    expect(await page.locator('body').getAttribute('data-closed')).toBeNull();
    await page.clock.runFor(999);
    expect(await page.locator('body').getAttribute('data-closed')).toBeNull();
    await page.clock.runFor(1);
    await expect(page.locator('body')).toHaveAttribute('data-closed','true');
    await expect(page.locator('body')).toHaveAttribute('data-recovered','true');
  }
});
