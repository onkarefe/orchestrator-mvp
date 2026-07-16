function countPlaceholders(sql) {
  return (String(sql).match(/\?/g) ?? []).length;
}

export function assertFlatSqlParams(sql, params) {
  if (!Array.isArray(params)) {
    throw new TypeError('SQL params must be an array');
  }

  for (const [index, value] of params.entries()) {
    if (
      value === undefined ||
      Array.isArray(value) ||
      (value !== null && typeof value === 'object')
    ) {
      throw new TypeError(`SQL param at index ${index} must be a scalar or null`);
    }
  }

  const placeholderCount = countPlaceholders(sql);

  if (placeholderCount !== params.length) {
    throw new Error(
      `SQL placeholder count ${placeholderCount} does not match params length ${params.length}`
    );
  }

  return params;
}

export default {
  assertFlatSqlParams,
};
