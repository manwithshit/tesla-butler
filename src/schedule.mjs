export function dueScheduledReport(now, state = {}) {
  const weekdayIndex = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[now.weekday];
  if (weekdayIndex === undefined) return null;

  const currentDate = Date.UTC(Number(now.year), Number(now.month) - 1, Number(now.day));
  const monday = new Date(currentDate - weekdayIndex * 86_400_000);
  const mondayKey = [
    monday.getUTCFullYear(),
    String(monday.getUTCMonth() + 1).padStart(2, "0"),
    String(monday.getUTCDate()).padStart(2, "0")
  ].join("-");
  const clock = `${now.hour}:${now.minute}`;
  const weeklyDue = weekdayIndex > 0 || clock >= "09:00";
  const monthlyDue = now.day > "01" || (now.day === "01" && clock >= "09:10");
  const weekly = { period: "previous_week", key: `weekly:${mondayKey}` };
  const monthly = { period: "previous_month", key: `monthly:${now.year}-${now.month}` };
  const monthlySlotIsToday = now.day === "01" && clock >= "09:10";
  const candidates = monthlySlotIsToday
    ? [monthly, ...(weeklyDue ? [weekly] : [])]
    : [...(weeklyDue ? [weekly] : []), ...(monthlyDue ? [monthly] : [])];
  return candidates.find((candidate) => !state.sent?.[candidate.key]) || null;
}
