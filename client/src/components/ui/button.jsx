import { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button-variants';

/**
 * @typedef {Object} ButtonOwnProps
 * @property {'default'|'secondary'|'ghost'|'outline'|'destructive'|'link'} [variant]
 * @property {'default'|'sm'|'lg'|'icon'} [size]
 * @property {string} [className]
 */

const Button = forwardRef(function Button(
  { className, variant, size, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
});

export { Button };
