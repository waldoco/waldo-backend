import { type CSSProperties, useState } from 'react';

// Each profile section is a stack of cards, one fact per card: tap to bring the next one to the top. The depth of
// the stack behind says how many facts the section holds.
export function ProfileCards({ sections }: { sections: { title: string; lines: string[] }[] }) {
  const stacks = sections.map(section => ({ title: section.title, facts: section.lines.filter(line => line.trim()) })).filter(stack => stack.facts.length);
  return <ul className="pstacks">{stacks.map((stack, index) => <Stack key={`${stack.title}:${index}`} index={index} {...stack}/>)}</ul>;
}

function Stack({ title, facts, index }: { title: string; facts: string[]; index: number }) {
  const [at, setAt] = useState(0);
  const many = facts.length > 1, fact = facts[at]!;
  return <li className="pstack" data-depth={Math.min(facts.length - 1, 2)} style={{ '--i': index } as CSSProperties}>
    <button type="button" className="pcard" disabled={!many} aria-label={many ? `Your ${title.toLowerCase()}: ${fact}. Fact ${at + 1} of ${facts.length}. Show the next one.` : `Your ${title.toLowerCase()}: ${fact}.`} onClick={() => setAt(n => (n + 1) % facts.length)}>
      <span className="pcard-label">Your {title.toLowerCase()}</span>
      <span key={at} className="pcard-fact">{fact}</span>
      <span className="pcard-foot"><span>{title}</span>{many && <span className="pcard-count">{at + 1} of {facts.length}</span>}</span>
    </button>
  </li>;
}
