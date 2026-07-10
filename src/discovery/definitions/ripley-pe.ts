/**
 * Ripley discovery: captures a listing page's SSR shape and a HAR so an operator
 * can author/update the reviewed runtime scraper. It NEVER promotes or registers
 * anything automatically.
 */
import { defineDiscovery } from "../define-discovery.ts";

export const ripleyDiscovery = defineDiscovery({
  scraperId: "ripley-pe-products",
  store: "ripley-pe",
  async run(ctx) {
    const tab = await ctx.browser.tab("ripley-discovery", { purpose: "discovery" });
    const target = "https://simple.ripley.com.pe/tecnologia";
    ctx.policy.assertNavigable(target);
    await tab.startHar(ctx.artifacts.dir + "/network.har").catch(() => {});
    await tab.goto(target, { waitUntil: "networkidle" });
    const html = await tab.html();
    ctx.artifacts.save("list.html", html);
    const nextData = await tab.nextData().catch(() => null);
    if (nextData) ctx.artifacts.saveJson("next-data.json", nextData);
    await tab.stopHar().catch(() => {});
    ctx.logger.info("ripley discovery captured", { dir: ctx.artifacts.dir });
    await ctx.browser.closeTab("ripley-discovery");
  },
});
