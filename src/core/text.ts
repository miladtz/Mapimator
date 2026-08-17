import type { NumberStyle, TextDirection, TextLanguage } from './project';

const persianDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
export const containsPersianOrArabic = (text: string) => /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text);
export const resolveTextDirection = (text: string, setting: TextDirection = 'auto') => setting === 'auto' ? (containsPersianOrArabic(text) ? 'rtl' : 'ltr') : setting;
export const resolveTextLanguage = (text: string, setting: TextLanguage = 'auto') => setting === 'auto' ? (containsPersianOrArabic(text) ? 'persian' : 'english') : setting;
export const formatNumbers = (text: string, style: NumberStyle = 'english') => style === 'persian' ? text.replace(/[0-9]/g, d => persianDigits[Number(d)]) : text;
