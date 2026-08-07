/** Upper bound for provider-controlled text retained in catalogs or cache metadata. */
export const MAX_REMOTE_TEXT_LENGTH = 500;

export function boundedRemoteText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_REMOTE_TEXT_LENGTH) : undefined;
}

export function hasBoundedRemoteText(value: string | undefined): boolean {
  return value === undefined || value.length <= MAX_REMOTE_TEXT_LENGTH;
}
