const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function relativeTime(iso: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return rtf.format(months, "month");
  return rtf.format(Math.round(months / 12), "year");
}
