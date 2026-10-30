import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Check, Copy, Loader2, X } from 'lucide-react';
import { navigate } from './api';

/** A small component kit for the product app: neutral surfaces, one accent, clear states. */

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export function Link({ to, className, children, title }: { to: string; className?: string; children: React.ReactNode; title?: string }) {
  return (
    <a
      href={to}
      title={title}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm shadow-indigo-600/20 disabled:bg-indigo-300',
  secondary: 'bg-white text-zinc-800 border border-zinc-300 hover:bg-zinc-50 shadow-xs disabled:text-zinc-400',
  ghost: 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 disabled:text-zinc-300',
  danger: 'bg-white text-rose-700 border border-rose-200 hover:bg-rose-50 disabled:text-rose-300',
  success: 'bg-emerald-700 text-white hover:bg-emerald-800 shadow-sm shadow-emerald-700/20 disabled:bg-emerald-300',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean; icon?: React.ReactNode }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors cursor-pointer disabled:cursor-not-allowed whitespace-nowrap',
        size === 'sm' ? 'h-8 px-2.5 text-[0.8rem]' : 'h-9 px-3.5 text-sm',
        BUTTON[variant],
        className
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export type Tone = 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'indigo' | 'violet';
const TONE: Record<Tone, string> = {
  gray: 'bg-zinc-100 text-zinc-700 ring-zinc-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  red: 'bg-rose-50 text-rose-700 ring-rose-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  blue: 'bg-sky-50 text-sky-700 ring-sky-200',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
};
const DOT: Record<Tone, string> = { gray: 'bg-zinc-400', green: 'bg-emerald-500', red: 'bg-rose-500', amber: 'bg-amber-500', blue: 'bg-sky-500', indigo: 'bg-indigo-500', violet: 'bg-violet-500' };

export function Badge({ tone = 'gray', dot, children, className, title }: { tone?: Tone; dot?: boolean; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', TONE[tone], className)}>
      {dot && <span className={cx('size-1.5 rounded-full', DOT[tone])} aria-hidden />}
      {children}
    </span>
  );
}

export function RuleKey({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center rounded-md bg-zinc-900 px-1.5 py-0.5 font-mono text-[0.72rem] font-semibold text-white">{children}</span>;
}

export function Card({ title, description, actions, children, className, padded = true }: { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('rounded-xl border border-zinc-200 bg-white shadow-xs', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-zinc-100 px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-[0.95rem] font-semibold text-zinc-900">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-zinc-500">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; eyebrow?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-sm text-zinc-500">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-zinc-500">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, icon, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; icon?: React.ReactNode; tone?: 'red' | 'green' | 'amber' }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-xs">
      <div className="flex items-center justify-between text-sm text-zinc-500">
        <span>{label}</span>
        {icon && <span className="text-zinc-500">{icon}</span>}
      </div>
      <div className={cx('mt-2 text-2xl font-semibold tracking-tight', tone === 'red' ? 'text-rose-700' : tone === 'green' ? 'text-emerald-700' : tone === 'amber' ? 'text-amber-700' : 'text-zinc-900')}>{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: React.ReactNode; title: string; description?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && <div className="mb-3 rounded-full bg-zinc-100 p-3 text-zinc-500">{icon}</div>}
      <div className="font-medium text-zinc-900">{title}</div>
      {description && <p className="mt-1 max-w-md text-sm text-zinc-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-5 py-10 text-sm text-zinc-500" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}…
    </div>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">{children}</div>;
}

export function Notice({ tone = 'blue', icon, children, action }: { tone?: 'blue' | 'amber' | 'green' | 'gray'; icon?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  const t = { blue: 'border-sky-200 bg-sky-50 text-sky-900', amber: 'border-amber-200 bg-amber-50 text-amber-900', green: 'border-emerald-200 bg-emerald-50 text-emerald-900', gray: 'border-zinc-200 bg-zinc-50 text-zinc-700' }[tone];
  return (
    <div className={cx('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm', t)}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: React.ReactNode; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-zinc-800">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

const INPUT = 'rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 shadow-xs placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-3 focus:ring-indigo-500/15 disabled:bg-zinc-50';
/** Full width unless the caller sets a width class. */
const width = (className?: string) => (/(^|\s)(min-|max-)?w-/.test(className ?? '') ? '' : 'w-full');
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => <input ref={ref} {...rest} className={cx(INPUT, width(className), 'h-9', className)} />);
Input.displayName = 'Input';
export function Textarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(INPUT, width(className), 'py-2 leading-relaxed', className)} />;
}
export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(INPUT, width(className), 'h-9 pr-8', className)}>
      {children}
    </select>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ id: T; label: React.ReactNode; count?: number }> }) {
  return (
    <div className="mb-4 flex gap-1 border-b border-zinc-200" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx('-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium', value === t.id ? 'border-indigo-600 text-zinc-900' : 'border-transparent text-zinc-500 hover:text-zinc-800')}
        >
          {t.label}
          {t.count !== undefined && <span className={cx('rounded-full px-1.5 text-xs', value === t.id ? 'bg-indigo-100 text-indigo-700' : 'bg-zinc-100 text-zinc-600')}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, title, description, onClose, children, footer, wide }: { open: boolean; title: string; description?: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-900/40 p-4 pt-[10vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cx('w-full rounded-xl border border-zinc-200 bg-white shadow-xl', wide ? 'max-w-2xl' : 'max-w-lg')}>
        <div className="flex items-start justify-between gap-4 border-b border-zinc-100 px-5 py-4">
          <div>
            <h2 className="font-semibold text-zinc-900">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-zinc-500">{description}</p>}
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="cursor-pointer rounded-md p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700">
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-4 px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-zinc-100 bg-zinc-50/60 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={done ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

export { CodeBlock } from './dark/CodeBlock';

export function Avatar({ name, size = 'md' }: { name: string | null | undefined; size?: 'sm' | 'md' }) {
  const initials = (name || '?')
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const hue = [...(name || '?')].reduce((a, c) => a + c.charCodeAt(0), 0) % 5;
  const colors = ['bg-indigo-100 text-indigo-700', 'bg-emerald-100 text-emerald-700', 'bg-amber-100 text-amber-800', 'bg-sky-100 text-sky-700', 'bg-rose-100 text-rose-700'];
  return <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', size === 'sm' ? 'size-6 text-[0.65rem]' : 'size-8 text-xs', colors[hue])}>{initials}</span>;
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cx('font-mono text-[0.8rem]', className)}>{children}</span>;
}

export const Th = ({ children, className }: { children?: React.ReactNode; className?: string }) => <th className={cx('px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-zinc-500', className)}>{children}</th>;
export const Td = ({ children, className }: { children?: React.ReactNode; className?: string }) => <td className={cx('px-4 py-3 align-top text-sm text-zinc-700', className)}>{children}</td>;

export function Table({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead className="border-b border-zinc-200 bg-zinc-50/70">
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">{children}</tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- toasts

const ToastContext = createContext<(message: string, tone?: 'green' | 'red') => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; tone: 'green' | 'red' }>>([]);
  const push = useCallback((message: string, tone: 'green' | 'red' = 'green') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-white px-4 py-3 text-sm shadow-lg', t.tone === 'green' ? 'border-emerald-200' : 'border-rose-200')}>
            <span className={cx('mt-1 size-2 shrink-0 rounded-full', t.tone === 'green' ? 'bg-emerald-500' : 'bg-rose-500')} />
            <span className="text-zinc-800">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
