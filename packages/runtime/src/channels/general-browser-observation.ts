// Trusted observation code; page content supplies evidence, never owner authority.
export type GeneralSelectOption = Readonly<{ value: string; label: string; disabled: boolean; selected: boolean }>;
export type GeneralElement = Readonly<{ selector: string; tag: string; role: string; name: string; href: string; value: string; type: string; disabled: boolean; selected: boolean; checked: boolean; inForm: boolean; options?: readonly GeneralSelectOption[] }>;
export type GeneralPageState = Readonly<{ url: string; title: string; text: string; width: number; height: number; scrollX: number; scrollY: number; elements: readonly GeneralElement[] }>;
export type GeneralObservation = Readonly<{ revision: string; tab_ref: string; url: string; title: string; text: string; viewport: Readonly<{ width: number; height: number }>; elements: readonly Readonly<{ ref: string; role: string; name: string; tag: string; disabled: boolean; options?: readonly GeneralSelectOption[] }>[]; tabs: readonly Readonly<{ ref: string; url: string; title: string }>[] }>;
export type GeneralSnapshot = Readonly<{ ownerId: string; sessionId: string; generation: number; targetId: string; digest: string; state: GeneralPageState; observation: GeneralObservation; image: Readonly<{ mime_type: 'image/png'; bytes: Uint8Array }> }>;
export type GeneralActionSnapshot = Omit<GeneralSnapshot, 'image'>;

// Host-authored page evaluation. No script/code is accepted from a model argument.
export function generalPageState(): GeneralPageState {
  const root: any = globalThis;
  const document = root.document;
  const elements: GeneralElement[] = [];
  for (const node of document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]')) {
    const box = node.getBoundingClientRect(), style = root.getComputedStyle(node);
    if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none') continue;
    const tag = String(node.tagName).toLowerCase(), type = String(node.type ?? '');
    // Keep page evaluation self-contained after esbuild's keepNames transform;
    // a named nested function would reference a host-only __name helper.
    const parts: string[] = [];
    let ancestor = node;
    while (ancestor && ancestor.nodeType === 1) {
      const ancestorTag = String(ancestor.tagName).toLowerCase();
      const siblings = ancestor.parentElement ? Array.from(ancestor.parentElement.children).filter((item: any) => item.tagName === ancestor.tagName) : [ancestor];
      parts.unshift(`${ancestorTag}:nth-of-type(${siblings.indexOf(ancestor) + 1})`);
      ancestor = ancestor.parentElement;
    }
    const labels = node.labels ? Array.from(node.labels).map((label: any) => label.innerText).join(' ') : '';
    const labelled = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id: string) => document.getElementById(id)?.innerText ?? '').join(' ');
    const name = node.getAttribute('aria-label') || labelled || labels || node.innerText || node.getAttribute('placeholder') || node.getAttribute('title') || '';
    const role = node.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'select' ? 'combobox' : ['input', 'textarea'].includes(tag) ? 'textbox' : tag);
    const options = tag === 'select' ? Array.from(node.options).map((option: any) => ({ value: String(option.value), label: String(option.label), disabled: Boolean(option.disabled || option.parentElement?.disabled), selected: Boolean(option.selected) })) : undefined;
    elements.push({ selector: parts.join(' > '), tag, role, name, href: tag === 'a' ? node.href : '', value: type === 'password' || type === 'file' ? '' : String(node.value ?? ''), type, disabled: Boolean(node.disabled), selected: Boolean(node.selected), checked: Boolean(node.checked), inForm: Boolean(node.form), ...(options ? { options } : {}) });
  }
  return { url: root.location.href, title: document.title, text: document.body?.innerText ?? '', width: root.innerWidth, height: root.innerHeight, scrollX: root.scrollX, scrollY: root.scrollY, elements };
}

export async function generalDigest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
