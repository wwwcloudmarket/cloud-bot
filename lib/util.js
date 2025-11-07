import crypto from "node:crypto";

export function normalizePhone(p = "") {
  const digits = p.replace(/[^\d+]/g, "");
  // Россия: приводим 8XXXXXXXXXX -> +7XXXXXXXXXX
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("8") && digits.length === 11) return "+7" + digits.slice(1);
  return "+" + digits.replace(/^\+/, "");
}

export function randomCode6() {
  return String(Math.floor(100000 + Math.random() * 900000)); // строка, чтобы не терять ведущие нули
}

export function hashCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}
