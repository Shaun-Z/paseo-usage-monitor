/**
 * Xiaomi MiMo bills two different products from two different hosts, and one
 * config entry should be able to answer for whichever the account has:
 *
 *   PAYG balance   GET https://api.xiaomimimo.com/v1/platform/balance
 *                  Authorization: Bearer <sk- key>
 *
 *   Token Plan     GET https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan
 *                  Authorization: Bearer <tp- key>
 *
 * The two keys are separate credentials, so the probe resolves them
 * independently. A mode whose key is absent is not requested, and a mode whose
 * request fails is left out of the merged document rather than failing the
 * whole card; `whenPath` on the preset's readings then hides that mode. Only
 * when neither mode answered does the probe raise the first failure.
 *
 * The merged document:
 *
 *   payg        the balance response, verbatim
 *   token_plan  the token-plan response, verbatim
 */

import { UsageCredentialMissingError, UsageSourceError } from "./errors.server";
import type { UsageHttpRequest } from "./source.server";

const PAYG_URL = "https://api.xiaomimimo.com/v1/platform/balance";
const TOKEN_PLAN_URL = "https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan";

export interface MimoProbeAdapters {
  fetchJson(request: UsageHttpRequest): Promise<unknown>;
  /** Resolves a credential the mimo preset declared, by name. */
  resolve(name: string): string;
}

type ModeRead =
  | { ok: true; document: Record<string, unknown> }
  | { ok: false; error: unknown }
  | null;

function optionalResolve(adapters: MimoProbeAdapters, name: string): string | null {
  try {
    return adapters.resolve(name);
  } catch (error) {
    if (error instanceof UsageCredentialMissingError) return null;
    throw error;
  }
}

async function readMode(
  url: string,
  key: string | null,
  adapters: MimoProbeAdapters,
): Promise<ModeRead> {
  if (key === null) return null;
  try {
    const document = await adapters.fetchJson({
      url,
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
      return { ok: false, error: new UsageSourceError("MiMo returned a non-object document") };
    }
    return { ok: true, document: document as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function probeMimoUsage(adapters: MimoProbeAdapters): Promise<unknown> {
  const paygKey = optionalResolve(adapters, "apiKey");
  const planKey = optionalResolve(adapters, "planKey");
  if (paygKey === null && planKey === null) {
    throw new UsageSourceError("MiMo needs MIMO_API_KEY or MIMO_TOKEN_PLAN_API_KEY");
  }

  const [payg, tokenPlan] = await Promise.all([
    readMode(PAYG_URL, paygKey, adapters),
    readMode(TOKEN_PLAN_URL, planKey, adapters),
  ]);

  const document: Record<string, unknown> = {};
  const failures: unknown[] = [];
  for (const [key, read] of [
    ["payg", payg],
    ["token_plan", tokenPlan],
  ] as const) {
    if (read === null) continue;
    if (read.ok) {
      document[key] = read.document;
    } else {
      failures.push(read.error);
    }
  }
  if (Object.keys(document).length === 0) {
    const [first] = failures;
    if (first instanceof Error) throw first;
    throw new UsageSourceError("MiMo returned no balance or token plan");
  }
  return document;
}
