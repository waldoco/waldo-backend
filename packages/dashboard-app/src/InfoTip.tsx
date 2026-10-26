import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

// A small (i) that discloses a longer explanation. A mouse hover peeks; a click, tap, Enter or Space keeps it open
// until the (i) is pressed again, Escape is pressed, or the owner presses elsewhere. The text stays in the document
// while hidden, so it is never reworded, only moved.
export function InfoTip({ about, children }: { about: string; children: ReactNode }) {
  const id = useId();
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const open = hover || pinned;
  useEffect(() => {
    if (!open) return;
    const close = () => { setHover(false); setPinned(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const focused = wrap.current?.contains(document.activeElement);
      close();
      if (focused) button.current?.focus();
    };
    const onPress = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) close(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPress); };
  }, [open]);
  // Touch and pen send enter/leave around a tap too; only a mouse hover peeks, so a tap's click is the one toggle.
  return <span ref={wrap} className="info-tip" onPointerEnter={event => { if (event.pointerType === 'mouse') setHover(true); }} onPointerLeave={event => { if (event.pointerType === 'mouse') setHover(false); }}>
    <button ref={button} type="button" className="info-button" aria-label={`About ${about}`} aria-expanded={open} aria-controls={id}
      onClick={() => { if (pinned) { setPinned(false); setHover(false); } else setPinned(true); }}/>
    <span id={id} className="info-text" hidden={!open}>{children}</span>
  </span>;
}

export const splitExplanation = (text: string): [string, string] => {
  const at = text.indexOf('. ');
  return at < 0 ? [text, ''] : [text.slice(0, at + 1), text.slice(at + 2)];
};

// The first sentence stays visible as the one-line purpose; the rest of the same text goes behind the (i).
export function Explained({ about, text }: { about: string; text: string }) {
  const [purpose, rest] = splitExplanation(text);
  return rest ? <>{purpose} <InfoTip about={about}>{rest}</InfoTip></> : <>{purpose}</>;
}
