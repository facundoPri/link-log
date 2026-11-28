// paint-selection: select many links by dragging over their checkboxes (FAC-512). The range runs from the anchor
// to the pointer and shrinks when the pointer moves back; Escape mid-stroke restores the selection; Shift+click
// selects a range; a drag from the thumbnail paints while a plain click still opens the row.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, shot }) => {
  const urls = Array.from({ length: 8 }, (_, i) => fixture("article", `p${i}`));

  await step("Seed eight links and wait for them to settle");
  for (const url of urls) await api.send("POST", "/links", { url });
  await check(
    "API: eight links ready",
    async () => (await Promise.all(urls.map((u) => api.link(u)))).every((l) => l && !l.processing && l.status === "ready"),
    { timeout: 60_000 },
  );
  await page.reload();
  const boxes = page.getByRole("list").first().getByRole("checkbox");
  await check("Eight rows are listed", async () => (await boxes.count()) >= 8);
  const checked = () => page.getByRole("list").first().getByRole("checkbox", { checked: true }).count();
  const center = async (i: number) => {
    const b = (await boxes.nth(i).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  await step("Drag down the checkboxes from row 2 to row 6, then back to row 4");
  const from = await center(1);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (const i of [2, 3, 4, 5]) await page.mouse.move(from.x, (await center(i)).y, { steps: 6 });
  await check("Five rows checked mid-stroke", async () => (await checked()) === 5);
  await shot("01-five-painted");
  await page.mouse.move(from.x, (await center(3)).y, { steps: 6 });
  await check("Moving back shrinks the range to three", async () => (await checked()) === 3);
  await page.mouse.up();
  await check("Bar says 3 selected", () => page.getByRole("button", { name: "3 selected" }).isVisible());
  await shot("02-three-after-release");

  await step("Start a stroke on a checked row: it clears, and Escape restores");
  const mid = await center(2);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x, (await center(3)).y, { steps: 6 });
  await check("Starting on a checked row unchecks the range", async () => (await checked()) === 1);
  await page.keyboard.press("Escape");
  await check("Escape restores the three rows", async () => (await checked()) === 3);
  await page.mouse.up();
  await check("Escape kept the selection (no clear after release)", async () => (await checked()) === 3);

  await step("Shift+click selects the range from the anchor");
  await page.keyboard.press("Escape");
  await check("A bare Escape clears", async () => (await checked()) === 0);
  await boxes.nth(0).click();
  await boxes.nth(4).click({ modifiers: ["Shift"] });
  await check("Shift+click checks rows 1 to 5", async () => (await checked()) === 5);
  await shot("03-shift-range");

  await step("Drag from a thumbnail paints; a plain click on it opens the row");
  await page.keyboard.press("Escape");
  const rows = page.locator("[data-pick-thumb]");
  const t = (await rows.nth(5).boundingBox())!;
  await page.mouse.move(t.x + 30, t.y + 20);
  await page.mouse.down();
  await page.mouse.move(t.x + 30, t.y + 22, { steps: 2 });
  await check("Two pixels do not start a stroke", async () => (await checked()) === 0);
  const t2 = (await rows.nth(7).boundingBox())!;
  await page.mouse.move(t.x + 30, t2.y + 20, { steps: 8 });
  await page.mouse.up();
  await check("Thumbnail drag checks rows 6 to 8", async () => (await checked()) === 3);
  await page.keyboard.press("Escape");
  await rows.nth(2).click();
  await check("A plain thumbnail click opens the inspector", () => page.getByRole("button", { name: "Close inspector" }).isVisible());
  await check("…without selecting", async () => (await checked()) === 0);
  await shot("04-thumb-click-opens");

  await step("Keyboard: Space, then Shift+ArrowDown with Shift released between presses, then Shift+ArrowUp shrinks");
  await page.getByRole("button", { name: "Close inspector" }).click();
  await boxes.nth(7).click();
  await check("A mouse click checks row 8 once", async () => (await checked()) === 1);
  await boxes.nth(0).focus();
  await page.keyboard.press("Space");
  await check("Space checks row 1", async () => (await checked()) === 2);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await check("Shift+ArrowDown twice checks rows 1 to 3", async () => (await checked()) === 4);
  await page.keyboard.press("Shift+ArrowUp");
  await check("Shift+ArrowUp shrinks to rows 1 to 2", async () => (await checked()) === 3);
  await check("Focus follows the arrows (row 2's checkbox)", () => boxes.nth(1).evaluate((el) => el === document.activeElement));
  await check("One checkbox in the list is a tab stop", async () => (await page.getByRole("list").first().locator('[role=checkbox][tabindex="0"]').count()) === 1);

  await step("A selection change from outside starts a new key stroke");
  await page.keyboard.press("Escape");
  await check("Escape clears", async () => (await checked()) === 0);
  await page.keyboard.press("Shift+ArrowDown");
  await check("The new stroke runs from the anchor (rows 1 to 3) and row 8, cleared by Escape, stays clear", async () => (await checked()) === 3 && !(await boxes.nth(7).isChecked()));
  await shot("05-keyboard");
}) satisfies Journey;
