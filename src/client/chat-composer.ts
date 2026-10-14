export function shouldSubmitComposerOnKeyDown(event: {
  key: string;
  shiftKey: boolean;
  nativeEvent: {
    isComposing?: boolean;
    keyCode?: number;
  };
}) {
  return (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing &&
    event.nativeEvent.keyCode !== 229
  );
}

export function submitComposerOnEnter(
  event: Parameters<typeof shouldSubmitComposerOnKeyDown>[0] & {
    preventDefault(): void;
    currentTarget: { form?: { requestSubmit(): void } | null };
  },
  canSubmit: boolean,
) {
  if (!shouldSubmitComposerOnKeyDown(event)) return;
  event.preventDefault();
  if (canSubmit) event.currentTarget.form?.requestSubmit();
}
