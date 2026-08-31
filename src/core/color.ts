/** Normalize an authored CSS hex color without ever accepting malformed state. */
export const normalizeHexColor = (value: string): string | null => {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed))
    return `#${trimmed
      .slice(1)
      .split('')
      .map((digit) => `${digit}${digit}`)
      .join('')}`.toUpperCase();
  return null;
};
