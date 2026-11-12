import { describe, expect, test } from "vitest";
import { UsageProviderOverridesSchema, type UsageReadingMapping } from "../shared/limits.shared";
import { getUsagePreset } from "../shared/presets.shared";
import { buildProviderRegistry } from "./registry.server";

const PRESET = getUsagePreset("antigravity");
if (PRESET === null) throw new Error("the antigravity preset is missing");

/** What the settings surface writes: the preset's readings, materialised. */
function materialised(): UsageReadingMapping[] {
  return structuredClone(PRESET?.readings ?? []);
}

/** A copy written before the preset gained `modelsPath` and `durationMsPath`. */
function olderCopy(): UsageReadingMapping[] {
  const saved = materialised();
  for (const mapping of saved) {
    if (mapping.kind !== "quota") continue;
    if (mapping.each !== undefined) delete mapping.each.modelsPath;
    if (mapping.window !== undefined) delete mapping.window.durationMsPath;
  }
  return saved;
}

function resolve(readings: UsageReadingMapping[]): UsageReadingMapping[] {
  const entry = buildProviderRegistry(
    UsageProviderOverridesSchema.parse({
      antigravity: { preset: "antigravity", readings },
    }),
  )[0];
  if (!entry?.provider) throw new Error("the provider did not resolve");
  return entry.provider.readings;
}

function mappingOf(readings: readonly UsageReadingMapping[], id: string): UsageReadingMapping {
  const found = readings.find((reading) => reading.id === id);
  if (found === undefined) throw new Error(`no reading "${id}"`);
  return found;
}

describe("preset reading hydration", () => {
  test("a saved copy picks up fields the preset gained after it was written", () => {
    expect(resolve(olderCopy())).toEqual(PRESET?.readings);
  });

  test("an edit to one reading does not stop another from being hydrated", () => {
    const saved = olderCopy();
    mappingOf(saved, "requests").label = "Requests (edited)";

    const readings = resolve(saved);
    expect(mappingOf(readings, "requests").label).toBe("Requests (edited)");
    const bucket = mappingOf(readings, "bucket");
    expect(bucket.kind === "quota" ? bucket.each?.modelsPath : null).toBe("models");
    expect(bucket.kind === "quota" ? bucket.window?.durationMsPath : null).toBe("durationMs");
  });

  test("a reading that now reads a different document is left exactly as written", () => {
    const saved = olderCopy();
    const bucket = mappingOf(saved, "bucket");
    if (bucket.kind !== "quota") throw new Error("bucket is not a quota");
    bucket.percentPath = "used_percent";

    const resolved = mappingOf(resolve(saved), "bucket");
    if (resolved.kind !== "quota") throw new Error("bucket is not a quota");
    expect(resolved.percentPath).toBe("used_percent");
    expect(resolved.each?.modelsPath).toBeUndefined();
  });

  test("a reading the user added is kept, and the rest still hydrates", () => {
    const saved = olderCopy();
    saved.push({
      kind: "quota",
      id: "custom",
      label: "Custom",
      unit: "tokens",
      usedPath: "custom.used",
    });

    const readings = resolve(saved);
    expect(mappingOf(readings, "custom").label).toBe("Custom");
    const bucket = mappingOf(readings, "bucket");
    expect(bucket.kind === "quota" ? bucket.each?.modelsPath : null).toBe("models");
  });
});
