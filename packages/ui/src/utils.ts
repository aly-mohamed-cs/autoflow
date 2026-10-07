import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge class names, letting later Tailwind classes override earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Category id from the activity catalog -> Tailwind color token suffix. */
export const CATEGORY_COLORS: Record<string, string> = {
  Control: 'control',
  Browser: 'browser',
  Desktop: 'desktop',
  Excel: 'excel',
  Files: 'files',
  Data: 'data',
  Text: 'text',
  PDF: 'pdf',
  Email: 'email',
  'Web & APIs': 'web',
  Database: 'database',
};

/** CSS color value for a category accent. */
export function categoryColor(category: string | undefined): string {
  const key = (category && CATEGORY_COLORS[category]) || 'control';
  return `var(--af-cat-${key})`;
}
