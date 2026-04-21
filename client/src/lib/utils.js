import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并 className,支持条件表达式并解决 Tailwind 冲突(后者覆盖前者)。
 * shadcn 组件约定入口。
 *
 * @param {...import('clsx').ClassValue} inputs
 * @returns {string}
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
