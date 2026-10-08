import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { t } from '../i18n';
export function DocumentMenu({
  items,
}: {
  items: { label: string; action: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return (
    <div
      className="document-menu"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
        if (
          open &&
          ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
        ) {
          event.preventDefault();
          const buttons = Array.from(
            root.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]',
            ) ?? [],
          );
          const current = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const index =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (current +
                    (event.key === 'ArrowDown' ? 1 : -1) +
                    buttons.length) %
                  buttons.length;
          buttons[index]?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className="document-icon"
        aria-label={t('editor.pageActions')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={20} />
      </button>
      {open && (
        <div
          className="document-dropdown"
          role="menu"
          aria-label={t('editor.pageActions')}
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                item.action();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
