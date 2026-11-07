export const TIME_ZONE = 'Asia/Shanghai';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
export function today(now = Date.now()) { return dayFormat.format(new Date(now)); }
export function checkDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) throw new Error('日期必须为 YYYY-MM-DD');
  const timestamp = Date.parse(`${day}T00:00:00+08:00`);
  if (!Number.isFinite(timestamp) || today(timestamp) !== day) throw new Error('无效日期');
  return day;
}
export function bounds(day) { checkDay(day); const start = Date.parse(`${day}T00:00:00+08:00`); return { start, end: start + 86400000 }; }
export function addDays(day, count) { return today(bounds(day).start + count * 86400000); }
export function dates(start, end) { checkDay(start); checkDay(end); const result = []; for (let d = start; d <= end; d = addDays(d, 1)) { if (result.length > 3660) throw new Error('日期跨度超过十年'); result.push(d); } return result; }
export function monday(day) { const weekday = new Date(bounds(day).start + 8 * 3600000).getUTCDay(); return addDays(day, -((weekday + 6) % 7)); }
export function timestamp(value) {
  const n = typeof value === 'string' ? Date.parse(value) : value;
  if (!Number.isFinite(n) || n <= 0) throw new Error('消息缺少有效时间，不能可靠判断归属日期');
  return n < 1e11 ? n * 1000 : n;
}
