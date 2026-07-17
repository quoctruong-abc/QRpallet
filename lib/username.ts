const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const INTERNAL_EMAIL_DOMAIN = "qrpallet.local";

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(normalizeUsername(value));
}

export function usernameToInternalEmail(value: string): string {
  const username = normalizeUsername(value);
  return `${username}@${INTERNAL_EMAIL_DOMAIN}`;
}
