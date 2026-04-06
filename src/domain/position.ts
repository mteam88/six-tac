export async function positionIdForTurnsJson(turnsJson: string): Promise<string> {
  const payload = new TextEncoder().encode(turnsJson);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
