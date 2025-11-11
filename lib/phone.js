// lib/phone.js
export function normalizePhone(input) {
  if (!input) return null;
  // только цифры
  const digits = String(input).replace(/\D+/g, "");
  if (!digits) return null;

  // РФ: иногда приходит 8XXXXXXXXXX — приводим к 7XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith("8")) {
    return "7" + digits.slice(1);
  }
  // +7XXXXXXXXXX -> 7XXXXXXXXXX (мы уже убрали +)
  if (digits.length === 11 && digits.startsWith("7")) {
    return digits;
  }
  // Если 10 цифр (без кода), считаем что РФ
  if (digits.length === 10) {
    return "7" + digits;
  }

  // Иначе храним как есть (например, другие страны)
  return digits;
}
