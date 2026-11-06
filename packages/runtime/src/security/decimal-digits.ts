// Every script's decimal digits are encoded zero to nine in a row, and runs that touch (the five mathematical sets) are each
// ten long, so a digit's value is its offset from the start of its run, modulo ten.
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/gu;
const DECIMAL_DIGIT = /^\p{Nd}$/u;
const asciiDigit = (char: string): string => {
  const point = char.codePointAt(0)!;
  let zero = point;
  while (DECIMAL_DIGIT.test(String.fromCodePoint(zero - 1))) zero -= 1;
  return String((point - zero) % 10);
};

// The text with every decimal digit of any script (fullwidth, Arabic-Indic, Devanagari, mathematical) as its ASCII digit,
// so a pattern written with \d or [0-9] reads the number the text shows.
export const asciiDigits = (text: string): string => text.replace(NON_ASCII_DIGIT, asciiDigit);
