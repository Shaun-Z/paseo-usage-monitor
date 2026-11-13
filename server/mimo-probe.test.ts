import { describe, expect, test } from "vitest";
import { UsageCredentialMissingError, UsageSourceError } from "./errors.server";
import { probeMimoUsage, type MimoProbeAdapters } from "./mimo-probe.server";
import type { UsageHttpRequest } from "./source.server";

const PAYG_URL = "https://api.xiaomimimo.com/v1/platform/balance";
const TOKEN_PLAN_URL = "https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan";

function createAdapters(options: {
  keys: Record<string, string>;
  responses?: Record<string, unknown>;
  failing?: readonly string[];
  requests?: UsageHttpRequest[];
}): MimoProbeAdapters {
  const requests = options.requests ?? [];
  return {
    async fetchJson(request) {
      requests.push(request);
      if (options.failing?.includes(request.url)) {
        throw new UsageSourceError("request failed with HTTP 401", { status: 401 });
      }
      return options.responses?.[request.url] ?? {};
    },
    resolve(name) {
      const value = options.keys[name];
      if (value !== undefined) return value;
      throw new UsageCredentialMissingError(name, ["a test chain"]);
    },
  };
}

describe("mimo probe", () => {
  test("reads both billing modes with their own keys", async () => {
    const requests: UsageHttpRequest[] = [];
    const payg = { object: "balance", balance_infos: [] };
    const tokenPlan = { object: "token_plan", plan_code: "pro" };
    const adapters = createAdapters({
      keys: { apiKey: "sk-test", planKey: "tp-test" },
      responses: { [PAYG_URL]: payg, [TOKEN_PLAN_URL]: tokenPlan },
      requests,
    });

    await expect(probeMimoUsage(adapters)).resolves.toEqual({ payg, token_plan: tokenPlan });
    expect(requests).toHaveLength(2);
    expect(requests.find((request) => request.url === PAYG_URL)?.headers).toMatchObject({
      Authorization: "Bearer sk-test",
    });
    expect(requests.find((request) => request.url === TOKEN_PLAN_URL)?.headers).toMatchObject({
      Authorization: "Bearer tp-test",
    });
  });

  test("requests only the mode whose key resolved", async () => {
    const requests: UsageHttpRequest[] = [];
    const payg = createAdapters({
      keys: { apiKey: "sk-test" },
      requests,
    });
    await expect(probeMimoUsage(payg)).resolves.toEqual({ payg: {} });
    expect(requests.map((request) => request.url)).toEqual([PAYG_URL]);

    const planRequests: UsageHttpRequest[] = [];
    const plan = createAdapters({
      keys: { planKey: "tp-test" },
      requests: planRequests,
    });
    await expect(probeMimoUsage(plan)).resolves.toEqual({ token_plan: {} });
    expect(planRequests.map((request) => request.url)).toEqual([TOKEN_PLAN_URL]);
  });

  test("keeps a working mode when the other one fails", async () => {
    const adapters = createAdapters({
      keys: { apiKey: "sk-test", planKey: "tp-test" },
      responses: { [TOKEN_PLAN_URL]: { plan_code: "pro" } },
      failing: [PAYG_URL],
    });

    await expect(probeMimoUsage(adapters)).resolves.toEqual({
      token_plan: { plan_code: "pro" },
    });
  });

  test("reports the first failure when neither mode answered", async () => {
    const adapters = createAdapters({
      keys: { apiKey: "sk-test", planKey: "tp-test" },
      failing: [PAYG_URL, TOKEN_PLAN_URL],
    });

    await expect(probeMimoUsage(adapters)).rejects.toThrow("failed with HTTP 401");
  });

  test("refuses a configuration with no MiMo key at all", async () => {
    const adapters = createAdapters({ keys: {} });

    await expect(probeMimoUsage(adapters)).rejects.toThrow(
      "MiMo needs MIMO_API_KEY or MIMO_TOKEN_PLAN_API_KEY",
    );
  });

  test("treats a non-object response as that mode failing", async () => {
    const adapters = createAdapters({
      keys: { apiKey: "sk-test", planKey: "tp-test" },
      responses: { [PAYG_URL]: "not json", [TOKEN_PLAN_URL]: { plan_code: "pro" } },
    });

    await expect(probeMimoUsage(adapters)).resolves.toEqual({
      token_plan: { plan_code: "pro" },
    });
  });
});
