const uniqueResponsibilityClosureArrayPropertiesV06 = new Set([
  'acceptanceChecks',
  'evidence',
  'evidenceSets',
  'records',
  'verifications',
]);

function cloneWithResponsibilityClosureUniqueItemsV06(
  value: unknown,
  propertyName?: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => cloneWithResponsibilityClosureUniqueItemsV06(child));
  }
  if (typeof value !== 'object' || value === null) return value;

  const clone = Object.fromEntries(
    Object.entries(value).map(([name, child]) => [
      name,
      cloneWithResponsibilityClosureUniqueItemsV06(child, name),
    ]),
  ) as Record<string, unknown>;
  if (
    propertyName !== undefined &&
    uniqueResponsibilityClosureArrayPropertiesV06.has(propertyName) &&
    clone.type === 'array'
  ) {
    clone.uniqueItems = true;
  }
  return clone;
}

export function addResponsibilityClosureUniqueItemsV06<T>(schema: T): T {
  return cloneWithResponsibilityClosureUniqueItemsV06(schema) as T;
}
