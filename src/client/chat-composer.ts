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
