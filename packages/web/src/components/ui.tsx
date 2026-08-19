import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import { forwardRef, useEffect } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { X } from 'lucide-react';
import type { ItemStatus } from '@inventory/shared';
import { cn } from '../lib/cn';

// Small shadcn-style primitives. They only use theme tokens (bg-primary,
// text-muted, border-line…), so they follow the user's 3 colors automatically.

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
    'focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        secondary: 'bg-secondary-tint text-secondary hover:bg-secondary/25',
        outline: 'border border-line-strong bg-transparent text-text hover:bg-surface-2',
        ghost: 'text-muted hover:bg-surface-2 hover:text-text',
        danger: 'bg-danger-tint text-danger hover:bg-danger/25',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-9 px-4 text-sm',
        lg: 'h-10 px-5',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-text',
        'placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1.5 block text-sm text-muted', className)} {...props} />;
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-1 text-xs text-danger">{message}</p>;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block h-5 w-5 animate-spin rounded-full border-2 border-line border-t-primary',
        className,
      )}
      aria-label="loading"
    />
  );
}

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'h-9 w-full rounded-md border border-line bg-surface px-2.5 text-sm text-text',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer',
        className,
      )}
      {...props}
    />
  ),
);
Select.displayName = 'Select';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-text',
        'placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      rows={3}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

// Status → tint. Semantic colors stay fixed across themes.
const STATUS_STYLE: Partial<Record<ItemStatus, string>> = {
  in_stock: 'bg-success-tint text-success',
  open: 'bg-warning-tint text-warning',
  depleted: 'bg-surface-2 text-muted',
  expired: 'bg-danger-tint text-danger',
  discarded: 'bg-danger-tint text-danger',
  lost: 'bg-danger-tint text-danger',
  quarantine: 'bg-warning-tint text-warning',
  in_service: 'bg-success-tint text-success',
  maintenance: 'bg-warning-tint text-warning',
  out_of_service: 'bg-danger-tint text-danger',
  retired: 'bg-surface-2 text-muted',
  installed: 'bg-primary-tint text-primary',
  used: 'bg-surface-2 text-muted',
  active: 'bg-success-tint text-success',
  superseded: 'bg-warning-tint text-warning',
  archived: 'bg-surface-2 text-muted',
};

export function StatusBadge({ status }: { status: ItemStatus }) {
  return (
    <span
      className={cn(
        'rounded-sm px-1.5 py-0.5 font-mono text-[0.65rem] font-medium uppercase tracking-wide whitespace-nowrap',
        STATUS_STYLE[status] ?? 'bg-surface-2 text-muted',
      )}
    >
      {status.replaceAll('_', ' ')}
    </span>
  );
}

/**
 * Escape closes whatever is on top. Without it the only way out of a dialog is
 * to find the backdrop with the mouse, which on a laptop trackpad is worse
 * than it sounds.
 */
function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

/** Right slide-over panel ( detail drawer). */
export function Drawer({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        data-ui="drawer"
        className={cn(
          // Full-width on a phone; a 400px-wide drawer with 40px of overlay
          // beside it is just a worse modal.
          'relative z-10 flex h-full w-full flex-col border-line bg-surface shadow-xl sm:border-l',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-lg',
        )}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-4 sm:px-5">
          <h2 className="text-lg font-semibold text-text">{title}</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 sm:p-5">{children}</div>
      </div>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      {/* Capped to the viewport so a long form scrolls inside the dialog
          instead of running off the bottom of a phone screen. */}
      <div
        role="dialog"
        aria-modal="true"
        data-ui="modal"
        className="relative z-10 flex max-h-[92dvh] w-full max-w-md flex-col rounded-xl border border-line bg-surface shadow-xl"
      >
        <h2 className="px-5 pb-3 pt-5 text-lg font-semibold text-text">{title}</h2>
        <div className="overflow-y-auto px-5 pb-5">{children}</div>
      </div>
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="mt-4 flex items-center justify-end gap-3">
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ←
      </Button>
      <span className="font-mono text-xs text-muted">
        {page} / {totalPages}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
      >
        →
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sortable table headers
// ---------------------------------------------------------------------------

export interface SortState<K extends string> {
  key: K | null;
  dir: 'asc' | 'desc';
}

/**
 * One click sorts ascending, a second flips it, a third goes back to the
 * table's own order.
 *
 * That third state matters here: the default order of Items is newest-first,
 * which is not reachable by any column, so without a way back you would have
 * to reload the page to see what you just added.
 */
export function nextSort<K extends string>(current: SortState<K>, key: K): SortState<K> {
  if (current.key !== key) return { key, dir: 'asc' };
  if (current.dir === 'asc') return { key, dir: 'desc' };
  return { key: null, dir: 'asc' };
}

export function SortHeader<K extends string>({
  sortKey,
  state,
  onSort,
  children,
  align = 'left',
  className,
}: {
  sortKey: K;
  state: SortState<K>;
  onSort: (key: K) => void;
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  const on = state.key === sortKey;
  return (
    <th
      // aria-sort is what a screen reader announces; the arrow is what everyone
      // else reads. Both have to say the same thing.
      aria-sort={on ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('px-4 py-2.5 font-medium', align === 'right' && 'text-right', className)}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 uppercase tracking-wide cursor-pointer hover:text-text',
          align === 'right' && 'flex-row-reverse',
          on ? 'text-text' : 'text-muted',
        )}
      >
        {children}
        {/* The inactive arrow keeps its space so headers do not jump sideways
            the moment you sort by one of them. */}
        <span aria-hidden className={cn('font-mono text-[0.7rem]', on ? 'opacity-100' : 'opacity-0')}>
          {state.dir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );
}

export function RoleBadge({ role, label }: { role: string; label: string }) {
  return (
    <span className="rounded-sm bg-secondary-tint px-1.5 py-0.5 font-mono text-[0.65rem] font-medium uppercase tracking-wide text-secondary">
      {label || role}
    </span>
  );
}
