import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Conditional class names with conflict resolution.
 *
 * String concatenation does NOT work for Tailwind: `"px-2" + " px-4"` leaves both in the class
 * list and the winner depends on stylesheet order, not on the order you wrote them. twMerge
 * resolves conflicts so the last one genuinely wins.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
