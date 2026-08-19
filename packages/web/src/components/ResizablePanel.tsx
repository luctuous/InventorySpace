import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

// A side panel you can drag wider, which remembers how wide you left it.
//
// The location tree started at a fixed 15rem, which is right for `L01R02` and
// far too narrow for "Solvent Cabinet — Flammables". Rather than guess a
// better number, the width is the reader's to set: whoever uses this screen
// every day drags it once and it stays.

interface Props {
  /** localStorage key — different panels remember different widths. */
  storageKey: string;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  children: ReactNode;
  className?: string;
  /** Announced on the drag handle; the panel itself is labelled by its content. */
  label: string;
}

function readStored(key: string, fallback: number, min: number, max: number): number {
  const raw = Number(localStorage.getItem(key));
  // A stored width from before someone changed the limits must not be able to
  // leave the panel unusably narrow or off the screen.
  return Number.isFinite(raw) && raw > 0 ? Math.min(max, Math.max(min, raw)) : fallback;
}

export function ResizablePanel({
  storageKey,
  defaultWidth,
  minWidth = 160,
  maxWidth = 560,
  children,
  className,
  label,
}: Props) {
  const [width, setWidth] = useState(() => readStored(storageKey, defaultWidth, minWidth, maxWidth));
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const clamp = useCallback(
    (value: number) => Math.min(maxWidth, Math.max(minWidth, value)),
    [maxWidth, minWidth],
  );

  // The listeners go on the window, not the handle: once the drag starts the
  // pointer routinely leaves the 6px handle, and a handle-scoped mousemove
  // would drop the drag the moment it did.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: MouseEvent) => {
      const left = panelRef.current?.getBoundingClientRect().left ?? 0;
      setWidth(clamp(event.clientX - left));
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // Without this the drag selects every label it passes over.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [clamp, dragging]);

  // Written when the drag ends rather than on every mousemove — a hundred
  // localStorage writes a second is a synchronous disk hit per frame.
  useEffect(() => {
    if (dragging) return;
    localStorage.setItem(storageKey, String(width));
  }, [dragging, storageKey, width]);

  return (
    <div
      ref={panelRef}
      // The width only applies from `lg` up: on a phone the panel is a full-width
      // disclosure and a remembered 420px would push the page sideways.
      style={{ ['--panel-width' as string]: `${width}px` }}
      className={cn('relative w-full lg:w-(--panel-width) lg:shrink-0', className)}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        tabIndex={0}
        onMouseDown={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => setWidth(defaultWidth)}
        // Keyboard resizing, because a drag handle that only takes a mouse is
        // a control half the room cannot use.
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') setWidth((w) => clamp(w - 16));
          if (event.key === 'ArrowRight') setWidth((w) => clamp(w + 16));
          if (event.key === 'Home') setWidth(defaultWidth);
        }}
        className={cn(
          'absolute inset-y-0 -right-2.5 hidden w-5 cursor-col-resize lg:block',
          'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2',
          'after:bg-line after:transition-colors hover:after:bg-primary hover:after:w-0.5',
          'focus-visible:outline-none focus-visible:after:bg-primary focus-visible:after:w-0.5',
          dragging && 'after:bg-primary after:w-0.5',
        )}
      />
    </div>
  );
}
