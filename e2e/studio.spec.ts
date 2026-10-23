import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { WsClient, mintToken } from "@hypout/core";
import { E2E_PORT, E2E_SECRET } from "../playwright.config";

const adminToken = (): string => mintToken(E2E_SECRET, { sub: "e2e", caps: [], admin: true, ttlSeconds: 600 });
const userToken = (sub: string): string => mintToken(E2E_SECRET, { sub, name: sub, caps: [{ ch: "chat:*", ops: ["sub", "pub", "presence"] }], ttlSeconds: 600 });
const shots = process.env["SCREENSHOTS"] === "1";

async function open(page: Page): Promise<void> {
  await page.goto(`/#token=${adminToken()}`);
  await expect(page.getByRole("status").filter({ hasText: "connected" })).toBeVisible();
}
const openChannel = async (page: Page, name: string): Promise<void> => {
  await page.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first().click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
};
const noSeriousViolations = async (page: Page, label: string): Promise<void> => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
};

test("the token link connects and is removed from the address bar", async ({ page }) => {
  await open(page);
  expect(page.url()).not.toContain("token");
  await expect(page.getByRole("button", { name: /^chat\b/ }).first()).toBeVisible();
});

test("the connect form refuses a malformed token and accepts a good one", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Connect to a Hypout server" })).toBeVisible();
  await noSeriousViolations(page, "connect form");
  await page.getByLabel("Admin token").fill("nope");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("start with hpt_");
  await page.getByLabel("Admin token").fill(adminToken());
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("status").filter({ hasText: "connected" })).toBeVisible();
});

test("an expired or forged token lands back on the form with a reason", async ({ page }) => {
  const forged = mintToken("another-secret-0123456789", { sub: "x", caps: [], admin: true, ttlSeconds: 600 });
  await page.goto(`/#token=${forged}`);
  await expect(page.getByRole("heading", { name: "Connect to a Hypout server" })).toBeVisible();
  await expect(page.locator("p[role=alert]")).toContainText("refused");
});

test("publish from the Studio shows up in the live feed, with the gates beside it", async ({ page }) => {
  await open(page);
  await openChannel(page, "chat");
  await expect(page.getByText("head #0")).toBeVisible();
  await page.getByRole("textbox", { name: "Event", exact: true }).fill("message");
  await page.getByLabel("Data (JSON)").fill('{ "text": "hello e2e" }');
  const gates = page.getByLabel("Gate pre-flight");
  await expect(gates.getByText("Payload schema")).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText(/Published as #\d+/)).toBeVisible();
  await expect(page.getByRole("log", { name: "Events" })).toContainText("hello e2e");
  if (shots) await page.screenshot({ path: "docs/screens/studio-feed.png" });
});

test("the gates explain a refusal before anything is sent", async ({ page }) => {
  await open(page);
  await openChannel(page, "chat");
  await page.getByLabel("Data (JSON)").fill('{ "text": 5 }');
  const gates = page.getByLabel("Gate pre-flight");
  await expect(gates.locator("li", { hasText: "HP-102" })).toContainText("fails");
  await page.getByLabel("Data (JSON)").fill('{ "text": "ok" }');
  await expect(gates.locator("li", { hasText: "HP-102" })).toContainText("passes");
  await page.getByLabel("Check the gates as an anonymous client").check();
  await expect(gates.locator("li", { hasText: "HP-104" })).toContainText("fails");
  await page.getByLabel("Data (JSON)").fill("{ nope");
  await expect(page.locator("#json-problem")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
});

test("another client's events and presence arrive live", async ({ page }) => {
  await open(page);
  await openChannel(page, "chat");
  const other = await WsClient.connect(`ws://127.0.0.1:${E2E_PORT}/ws?token=${userToken("grace")}`);
  try {
    other.sendText(JSON.stringify({ t: "sub", ch: "chat" }));
    await expect(page.getByLabel("Online now")).toContainText("grace");
    other.sendText(JSON.stringify({ t: "pub", ch: "chat", ev: "message", data: { text: "from grace" } }));
    await expect(page.getByRole("log", { name: "Events" })).toContainText("from grace");
  } finally {
    other.destroy();
  }
  await expect(page.getByLabel("Online now").getByRole("list")).not.toContainText("grace");
});

test("chaos drops frames, the wire inspector marks them, and a replay recovers the events", async ({ page, request }) => {
  await open(page);
  await openChannel(page, "alerts");
  await page.getByRole("tab", { name: "Chaos" }).click();
  await page.getByLabel(/^Drop/).fill("100");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("status").filter({ hasText: "dropping 100%" })).toBeVisible();
  const auth = { authorization: `Bearer ${adminToken()}` };
  for (let i = 0; i < 3; i++) {
    const r = await request.post("/api/publish", { headers: auth, data: { channel: "alerts", event: "notice", data: { level: "warn", message: `n${i}` } } });
    expect(r.ok()).toBe(true);
  }
  await expect(page.getByText("Dropped").locator("xpath=following-sibling::dd")).not.toHaveText("0");
  await page.getByRole("tab", { name: "Wire frames" }).click();
  await expect(page.getByText("dropped").first()).toBeVisible();
  await page.getByRole("tab", { name: "Chaos" }).click();
  await page.getByRole("button", { name: "Clean" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Chaos off" })).toBeVisible();
  // The next event reveals the hole; the client asks for a replay and gets all four, in order.
  await request.post("/api/publish", { headers: auth, data: { channel: "alerts", event: "notice", data: { level: "info", message: "after" } } });
  await page.getByRole("tab", { name: "Live feed" }).click();
  const log = page.getByRole("log", { name: "Events" });
  await expect(log).toContainText("after");
  for (const m of ["n0", "n1", "n2"]) await expect(log).toContainText(m);
});

test("the wire inspector decodes a frame header in the browser", async ({ page }) => {
  await open(page);
  await openChannel(page, "chat");
  await page.getByRole("tab", { name: "Wire frames" }).click();
  await page.getByRole("button", { name: "TEXT" }).first().click();
  const detail = page.getByLabel("Frame detail");
  await expect(detail).toContainText("FIN");
  await expect(detail).toContainText("Opcode");
  await expect(detail).toContainText("MASK");
  if (shots) await page.screenshot({ path: "docs/screens/studio-wire.png" });
});

test("disconnecting every client makes them reconnect on their own", async ({ page, request }) => {
  await open(page);
  await openChannel(page, "chat");
  await page.getByRole("tab", { name: "Chaos" }).click();
  await page.getByRole("button", { name: "Disconnect all" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Cut \d+ connection/ })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "connected" })).toBeVisible({ timeout: 20_000 });
  const stats = await request.get("/api/stats", { headers: { authorization: `Bearer ${adminToken()}` } });
  expect((await stats.json()).connections).toBeGreaterThanOrEqual(1);
});

test("tabs follow the keyboard pattern", async ({ page }) => {
  await open(page);
  const tabs = page.getByRole("tablist", { name: "Views" });
  await tabs.getByRole("tab", { name: "Live feed" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Wire frames" })).toBeFocused();
  await expect(tabs.getByRole("tab", { name: "Wire frames" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(tabs.getByRole("tab", { name: "Chaos" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Live feed" })).toBeFocused();
});

for (const theme of ["dark", "light"] as const) {
  test(`no serious accessibility violations on any view (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => localStorage.setItem("hypout-theme", t), theme);
    await open(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await openChannel(page, "chat");
    await page.getByLabel("Data (JSON)").fill('{ "text": "axe" }');
    await expect(page.getByLabel("Gate pre-flight").getByText("Payload size")).toBeVisible();
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("log", { name: "Events" })).toContainText("axe");
    await noSeriousViolations(page, `feed/${theme}`);
    for (const tab of ["Wire frames", "Topology", "Chaos"]) {
      await page.getByRole("tab", { name: tab }).click();
      await page.waitForTimeout(300);
      await noSeriousViolations(page, `${tab}/${theme}`);
    }
    if (shots && theme === "light") await page.screenshot({ path: "docs/screens/studio-light.png" });
    if (shots && theme === "dark") {
      await page.getByRole("tab", { name: "Topology" }).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: "docs/screens/studio-topology.png" });
    }
  });
}

test("the layout fits a phone with no sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await open(page);
  await openChannel(page, "chat");
  for (const tab of ["Live feed", "Wire frames", "Topology", "Chaos"]) {
    await page.getByRole("tab", { name: tab }).click();
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${tab} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
  }
});
