import { useLayoutEffect, useRef } from 'react';

export function singleLineTitle(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

export function PageTitleField({
  value,
  onChange,
}: {
  value: string;
  onChange: (title: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="document-title"
      aria-label="Page title"
      placeholder="Untitled page"
      maxLength={160}
      rows={1}
      value={value}
      onChange={(event) => onChange(singleLineTitle(event.target.value))}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.preventDefault();
      }}
    />
  );
}
