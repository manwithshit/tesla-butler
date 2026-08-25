export function dueScheduledReport(now, state = {}) {
  const dateKey = `${now.year}-${now.month}-${now.day}`;
  let result = null;
  if (now.weekday === "Mon" && now.hour === "09" && now.minute === "00") {
    result = { period: "previous_week", key: `weekly:${dateKey}` };
  } else if (now.day === "01" && now.hour === "09" && now.minute === "10") {
    result = { period: "previous_month", key: `monthly:${now.year}-${now.month}` };
  }
  return result && !state.sent?.[result.key] ? result : null;
}
