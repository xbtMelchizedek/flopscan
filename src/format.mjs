// Number formatting for people. Exact integer math: planck -> FLOP is a string split, never a float.

export const DECIMALS = 18;

/** "1234567" -> "1,234,567" (accepts a leading minus). */
export function groupDigits(s) {
  const neg = s.startsWith("-");
  const d = neg ? s.slice(1) : s;
  return (neg ? "-" : "") + d.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Planck string -> FLOP with `places` decimals, rounded down (toward zero). */
export function formatFlop(planck, places = 2) {
  if (planck === null || planck === undefined) return null;
  const s = String(planck);
  if (!/^-?\d+$/.test(s)) throw new TypeError(`not an integer: ${s}`);
  const neg = s.startsWith("-");
  const digits = (neg ? s.slice(1) : s).padStart(DECIMALS + 1, "0");
  const whole = digits.slice(0, -DECIMALS).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(-DECIMALS).slice(0, places).replace(/0+$/, "");
  // A non-zero amount below the shown precision is never printed as 0.
  if (whole === "0" && !frac && /[1-9]/.test(digits)) return `${neg ? "-" : ""}< 0.${"0".repeat(Math.max(0, places - 1))}1`;
  return `${neg ? "-" : ""}${groupDigits(whole)}${frac ? `.${frac}` : ""}`;
}

/** Exact FLOP with all 18 decimals, trailing zeros trimmed. */
export function exactFlop(planck) {
  const s = String(planck);
  const neg = s.startsWith("-");
  const digits = (neg ? s.slice(1) : s).padStart(DECIMALS + 1, "0");
  const whole = digits.slice(0, -DECIMALS).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(-DECIMALS).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export function formatValue(value, unit) {
  if (value === null || value === undefined) return null;
  if (unit === "FLOP") return formatFlop(value);
  if (unit === "count" && /^-?\d+$/.test(String(value))) return groupDigits(String(value));
  return String(value);
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
