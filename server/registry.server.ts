import {
  UsageProviderSchema,
  type UsageProvider,
  type UsageProviderOverride,
  type UsageProviderOverrides,
} from "../shared/limits.shared";
import { getUsagePreset } from "../shared/presets.shared";

/**
 * A config entry either resolves into a complete provider or it does not. An
 * entry naming a missing preset, or one a user has half-filled, keeps its row
 * with `provider: null` and an explanation, so the surface can show why instead
 * of the provider silently vanishing.
 */
export interface UsageProviderEntry {
  id: string;
  provider: UsageProvider | null;
  error: string | null;
}

/**
 * Stamps a user-declared ceiling onto the readings it names. A vendor that
 * publishes no allowance leaves its rows as bare counts; the user knows the
 * number from their plan page, and naming the mapping is how they hand it over
 * without restating the whole reading list.
 */
function applyLimits(
  readings: UsageProvider["readings"],
  limits: Record<string, number>,
): UsageProvider["readings"] {
  if (Object.keys(limits).length === 0) return readings;
  return readings.map((reading) => {
    if (reading.kind !== "quota") return reading;
    const limit = limits[reading.id];
    return limit === undefined ? reading : { ...reading, limit };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether every value the saved mapping states still equals the preset's. A
 * saved copy that predates a field the preset gained is a subset: it says
 * nothing about the new field and nothing that disagrees with the preset. A
 * different value, an extra field, a shorter array or a changed path is not.
 */
function isPresetSubset(value: unknown, preset: unknown): boolean {
  if (Array.isArray(value) || Array.isArray(preset)) {
    if (!Array.isArray(value) || !Array.isArray(preset) || value.length !== preset.length) {
      return false;
    }
    return value.every((entry, index) => isPresetSubset(entry, preset[index]));
  }
  if (isPlainObject(value)) {
    if (!isPlainObject(preset)) return false;
    return Object.entries(value).every(
      ([key, entry]) => key in preset && isPresetSubset(entry, preset[key]),
    );
  }
  return Object.is(value, preset);
}

/**
 * Fills a saved mapping's missing fields from the preset, keeping every value
 * the saved copy states. Nested objects (`each`, `window`) merge the same way,
 * which is what lets an older saved copy pick up `each.modelsPath` or
 * `window.durationMsPath` without losing a label or path the user edited.
 */
function mergePresetMapping(preset: unknown, saved: unknown): unknown {
  if (!isPlainObject(preset) || !isPlainObject(saved)) return saved;
  const merged: Record<string, unknown> = { ...preset };
  for (const [key, value] of Object.entries(saved)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value) ? mergePresetMapping(existing, value) : value;
  }
  return merged;
}

/**
 * The settings surface writes a preset's readings out in full, so a provider
 * saved once froze that mapping against later preset improvements. Readings
 * that still name the same id, kind and paths are the preset's own copy from
 * an older version: keep every value the file states and add the fields it
 * could not have known about. A reading that reads a different document, or
 * carries an edit the preset does not agree with, is left exactly as written.
 */
export function hydratePresetReadings(
  preset: readonly UsageProvider["readings"][number][],
  saved: readonly UsageProvider["readings"][number][],
): UsageProvider["readings"] {
  const byKey = new Map(
    preset.map((mapping) => [`${mapping.kind}\u0000${mapping.id}`, mapping] as const),
  );
  return saved.map((mapping) => {
    const match = byKey.get(`${mapping.kind}\u0000${mapping.id}`);
    if (match === undefined || !isPresetSubset(mapping, match)) return mapping;
    return mergePresetMapping(match, mapping) as UsageProvider["readings"][number];
  });
}

/**
 * A preset supplies the shape; the override supplies what the user changed.
 * `readings` and `source` replace wholesale, because a half-merged reading list
 * would describe a document neither side meant — except that a reading which
 * still reads the preset's own document is hydrated with fields the saved copy
 * predates, so a preset upgrade reaches the providers already stored.
 * `credentials` and `display` merge by key, so storing one credential, or
 * dragging one card, does not drop everything else the preset or the user
 * already had.
 */
function applyOverride(preset: UsageProvider, override: UsageProviderOverride): UsageProvider {
  return {
    ...preset,
    ...(override.label === undefined ? {} : { label: override.label }),
    ...(override.description === undefined ? {} : { description: override.description }),
    ...(override.enabled === undefined ? {} : { enabled: override.enabled }),
    ...(override.refreshIntervalMs === undefined
      ? {}
      : { refreshIntervalMs: override.refreshIntervalMs }),
    ...(override.source === undefined ? {} : { source: override.source }),
    ...(override.fallbackModelPath === undefined
      ? {}
      : { fallbackModelPath: override.fallbackModelPath }),
    ...(override.readings === undefined
      ? {}
      : { readings: hydratePresetReadings(preset.readings, override.readings) }),
    limits: override.limits === undefined ? preset.limits : override.limits,
    ...(override.icon === undefined ? {} : { icon: override.icon }),
    credentials:
      override.credentials === undefined
        ? preset.credentials
        : { ...preset.credentials, ...override.credentials },
    display:
      override.display === undefined ? preset.display : { ...preset.display, ...override.display },
  };
}

function resolveEntry(id: string, override: UsageProviderOverride): UsageProviderEntry {
  if (override.preset !== undefined) {
    const preset = getUsagePreset(override.preset);
    if (!preset) {
      return { id, provider: null, error: `Unknown preset "${override.preset}"` };
    }
    const provider = applyOverride(preset, override);
    return {
      id,
      provider: { ...provider, readings: applyLimits(provider.readings, provider.limits) },
      error: null,
    };
  }

  const parsed = UsageProviderSchema.safeParse(override);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => {
        const path = issue.path.map((part) => String(part)).join(".");
        return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
      })
      .join("; ");
    return { id, provider: null, error: detail };
  }
  const provider = parsed.data;
  return {
    id,
    provider: { ...provider, readings: applyLimits(provider.readings, provider.limits) },
    error: null,
  };
}

export function buildProviderRegistry(overrides: UsageProviderOverrides): UsageProviderEntry[] {
  return Object.entries(overrides)
    .map(([id, override]) => resolveEntry(id, override))
    .sort((left, right) => left.id.localeCompare(right.id));
}
