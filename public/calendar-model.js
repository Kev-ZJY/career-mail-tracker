const pad = (value) => String(value).padStart(2, '0');

export function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseDateKey(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function eventDateKeys(startValue, endValue = startValue) {
  const start = startValue instanceof Date ? new Date(startValue) : new Date(startValue);
  const end = endValue instanceof Date ? new Date(endValue) : new Date(endValue);
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const keys = [];
  for (const cursor = new Date(startDay); cursor <= endDay; cursor.setDate(cursor.getDate() + 1)) keys.push(dateKey(cursor));
  return keys;
}

export function buildMonthGrid(year, monthIndex, events = []) {
  const first = new Date(year, monthIndex, 1);
  const gridStart = new Date(year, monthIndex, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const key = dateKey(date);
    return {
      key,
      date,
      inMonth: date.getMonth() === monthIndex,
      events: events.filter((event) => event.dateKeys.includes(key)),
    };
  });
}

export function formatDateRange(startValue, endValue = null) {
  const start = new Date(startValue);
  if (!endValue || Number.isNaN(new Date(endValue).getTime())) return `${start.getMonth() + 1}月${start.getDate()}日`;
  const end = new Date(endValue);
  const startText = `${start.getMonth() + 1}月${start.getDate()}日`;
  const endText = `${end.getMonth() + 1}月${end.getDate()}日`;
  return dateKey(start) === dateKey(end) ? startText : `${startText}–${endText}`;
}

export function formatTime(value) {
  const date = new Date(value);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
