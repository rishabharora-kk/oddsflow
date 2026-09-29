/** Replace every occurrence of a secret in `text`. Defence in depth for log/error output. */
export function redactSecrets(text: string, secrets: Array<string | undefined | null>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  }
  // Also scrub api_key query params in any URL that slipped into a message.
  return out.replace(/(api_key=)[^&\s"']+/gi, "$1[redacted]");
}
