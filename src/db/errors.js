export function isDuplicateKeyError(error) {
  return Boolean(
    error &&
      (error.code === 'ER_DUP_ENTRY' ||
        error.errno === 1062)
  );
}

export default {
  isDuplicateKeyError,
};
