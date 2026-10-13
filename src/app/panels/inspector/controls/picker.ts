// The gesture of a drag in the color picker of a swatch (runtime.md 8.5 rule 4). The picker follows the mouse
// through listeners on the window, without capturing the pointer, and a drag across its square ends as often
// outside the popover as inside: at its edges lie the purest colors. A release there reaches no element of the
// popover, so the gesture is bracketed here, on the document: it begins with a press inside the picker of this
// swatch and ends where the button is let go, wherever that is.

import { useEffect, useRef } from 'react';

/** The picker of the shared color swatch (src/app/ui/ColorSwatch.tsx), which lies in a popover of its own. */
const PICKER = '[data-ui="color-picker"]';

export function usePickerGesture(swatchId: string, begin: () => void, end: (kept?: boolean) => void): void {
  const latest = useRef({ begin, end });
  latest.current = { begin, end };

  useEffect(() => {
    let dragging = false;
    const finish = (): void => {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      window.removeEventListener('blur', finish);
      latest.current.end(true);
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (dragging || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(PICKER) === null) return;
      // One popover is open at a time: the picker in the document is this swatch's while this swatch is the open one.
      if (document.getElementById(swatchId)?.getAttribute('aria-expanded') !== 'true') return;
      dragging = true;
      latest.current.begin();
      window.addEventListener('pointerup', finish, true);
      window.addEventListener('pointercancel', finish, true);
      // A window that loses the focus in the middle of a drag never sees the button come up.
      window.addEventListener('blur', finish);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      finish();
    };
  }, [swatchId]);
}
