import { test, expect } from "@playwright/test";
test("graph canvas, inspector and provider evidence", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Build a verified artifact" }),
  ).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await page.getByRole("button", { name: "Inspect work", exact: true }).click();
  await expect(page.locator(".inspector")).toBeVisible();
  await page.getByRole("button", { name: /^Inspect [0-9a-f]{12}$/ }).click();
  await expect(
    page.getByText("Verification result", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("button", { name: "▥ Providers & usage" }).click();
  await expect(
    page.getByRole("heading", { name: "Providers & usage", exact: true }),
  ).toBeVisible();
  await expect(page.locator("table").first()).toContainText("mock-1");
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/providers.png", fullPage: true });
  await page.getByRole("button", { name: "◈ Execution runs" }).click();
  await page.screenshot({ path: "test-results/graph.png", fullPage: true });
});

test("32 nodes, eight revisions and event resynchronization preserve selection", async ({
  page,
}) => {
  let snapshots = 0;
  await page.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args);
        window.__ralphStream = this;
      }
    };
  });
  const runs = await (await page.request.get("/api/v2/runs")).json();
  const runId = runs.runs[0].runId;
  const snapshot = await (
    await page.request.get(`/api/v2/runs/${runId}`)
  ).json();
  const graph = await (
    await page.request.get(`/api/v2/runs/${runId}/graph`)
  ).json();
  await page.route("**/api/v2/runs**", async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === "/api/v2/runs") body = structuredClone(runs);
    else if (url.pathname.endsWith("/graph")) body = structuredClone(graph);
    else if (url.pathname === `/api/v2/runs/${runId}`)
      body = structuredClone(snapshot);
    else return route.continue();
    if (body.runs) body.runs = body.runs.map((r) => ({ ...r, revision: 8 }));
    else if (url.pathname.endsWith("/graph")) {
      body.revision = Number(url.searchParams.get("revision") ?? 8);
      const worker = body.nodes[0];
      body.nodes = [
        ...body.nodes,
        ...Array.from({ length: 28 }, (_, i) => ({
          ...worker,
          nodeId: `bulk-${i}`,
          generation: 0,
        })),
      ];
      body.edges.push(
        ...Array.from({ length: 28 }, (_, i) => ({
          from: `bulk-${i}`,
          to: "integrate",
          kind: "artifact",
        })),
      );
    } else if (body.nodes) {
      snapshots++;
      body.revision = 8;
    }
    return route.fulfill({ json: body });
  });
  // Keep the actual SSE endpoint unbuffered by the response transformer above.
  await page.route("**/events?*", (route) => route.continue());
  await page.goto("/");
  await expect(page.locator(".react-flow__node")).toHaveCount(32);
  await page.getByRole("button", { name: "Inspect work", exact: true }).click();
  const firstNode = page.locator(".react-flow__node").first();
  const before = await firstNode.evaluate((element) => element.style.transform);
  await page.evaluate(() => {
    const stream = window.__ralphStream;
    stream.dispatchEvent(
      new MessageEvent("ralph", { data: JSON.stringify({ seq: 0 }) }),
    );
    stream.dispatchEvent(
      new MessageEvent("ralph", { data: JSON.stringify({ seq: 999999 }) }),
    );
    stream.close();
    stream.dispatchEvent(new Event("error"));
  });
  await expect.poll(() => snapshots).toBeGreaterThan(1);
  await expect(page.locator(".inspector")).toBeVisible();
  await expect(firstNode).toBeVisible();
  expect(await firstNode.evaluate((element) => element.style.transform)).toBe(
    before,
  );
  await page.getByRole("button", { name: "Close inspector" }).click();
  await page.getByLabel("Graph revision").selectOption("1");
  await expect(page.locator(".react-flow__node")).toHaveCount(32);
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Graph revision").selectOption("8");
  await expect(page.locator(".react-flow__node")).toHaveCount(32);
  expect(
    await page
      .locator("body")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(14);
});
test("small screens retain readable controls and a dismissible inspector", async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 850 });
  await page.goto("/");
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await page.locator(".react-flow__node").first().click();
  await expect(
    page.getByRole("button", { name: "Close inspector" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(page.locator(".inspector")).toHaveCount(0);
});

test("keyboard navigation, historical revision and bounded large diff rendering", async ({
  page,
}) => {
  await page.route("**/artifacts/*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        verifier: { ok: true },
        diff: Array.from({ length: 100000 }, (_, i) => `+line ${i + 1}`).join(
          "\n",
        ),
      }),
    }),
  );
  await page.goto("/");
  const node = page.getByRole("button", { name: "Inspect work", exact: true });
  await node.focus();
  await node.press("Enter");
  await expect(page.locator(".inspector")).toBeVisible();
  await page.getByRole("button", { name: /^Inspect [0-9a-f]{12}$/ }).click();
  await page.getByText("File diff", { exact: true }).click();
  const log = page.getByRole("region", { name: "File diff log" });
  await expect(log).toContainText("+line 1");
  expect(await log.locator("[data-log-line]").count()).toBeLessThan(40);
  await log.focus();
  await page.keyboard.press("End");
  await expect(log.locator('[data-log-line="100000"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".inspector")).toHaveCount(0);
  await page.getByLabel("Graph revision").selectOption("1");
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
});
