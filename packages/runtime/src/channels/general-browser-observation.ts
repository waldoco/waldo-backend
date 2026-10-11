// Trusted observation code; page content supplies evidence, never owner authority.
export type GeneralSelectOption = Readonly<{ value: string; label: string; disabled: boolean; selected: boolean }>;
export type GeneralElement = Readonly<{ selector: string; tag: string; role: string; name: string; href: string; value: string; type: string; disabled: boolean; selected: boolean; checked: boolean; inForm: boolean; formAction?:string;formMethod?:string;editable?: boolean; readOnly?: boolean; secret?:boolean; options?: readonly GeneralSelectOption[] }>;
export type GeneralPageState = Readonly<{ url: string; title: string; text: string; width: number; height: number; scrollX: number; scrollY: number; elements: readonly GeneralElement[] }>;
export type GeneralObservation = Readonly<{ revision: string; tab_ref: string; url: string; title: string; text: string; viewport: Readonly<{ width: number; height: number }>; accessibility_snapshot?: string; elements: readonly Readonly<{ ref: string; role: string; name: string; tag: string; disabled: boolean; checked?: boolean; options?: readonly GeneralSelectOption[] }>[]; tabs: readonly Readonly<{ ref: string; url: string; title: string }>[] }>;
export type GeneralSnapshot = Readonly<{ ownerId: string; sessionId: string; generation: number; targetId: string; digest: string; state: GeneralPageState; observation: GeneralObservation; image: Readonly<{ mime_type: 'image/png'; bytes: Uint8Array }> }>;
export type GeneralActionSnapshot = Omit<GeneralSnapshot, 'image'>;

// Host-authored page evaluation. No script/code is accepted from a model argument.
export function generalPageState(): GeneralPageState {
  const root: any = globalThis;
  const document = root.document;
  const elements: GeneralElement[] = [];
  // Open shadow roots participate in the same trusted observation; closed roots
  // remain opaque. CSS paths follow shadow hosts for Playwright's native locator.
  const roots = [document], nodes: any[] = [];
  for (let index=0;index<roots.length;index++) for (const node of roots[index].querySelectorAll('*')) {
    if(node.shadowRoot) roots.push(node.shadowRoot);
    if(node.matches('a,button,input,textarea,select,[role],[contenteditable="true"]')) nodes.push(node);
  }
  for (const node of nodes) {
    const box = node.getBoundingClientRect(), style = root.getComputedStyle(node);
    if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none') continue;
    const tag = String(node.tagName).toLowerCase(), type = String(node.type ?? '');
    const secret=type==='password'||String(node.getAttribute('autocomplete')??'').toLowerCase().split(/\s+/).includes('one-time-code');
    // Keep page evaluation self-contained after esbuild's keepNames transform;
    // a named nested function would reference a host-only __name helper.
    const parts: string[] = [];
    let ancestor = node;
    while (ancestor && ancestor.nodeType === 1) {
      const ancestorTag = String(ancestor.tagName).toLowerCase();
      const siblings = ancestor.parentNode?.children ? Array.from(ancestor.parentNode.children).filter((item: any) => item.tagName === ancestor.tagName) : [ancestor];
      parts.unshift(`${ancestorTag}:nth-of-type(${siblings.indexOf(ancestor) + 1})`);
      ancestor = ancestor.parentElement ?? ancestor.getRootNode().host;
    }
    const labels = node.labels ? Array.from(node.labels).map((label: any) => label.innerText).join(' ') : '';
    const labelled = (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).map((id: string) => node.getRootNode().getElementById(id)?.textContent ?? '').join(' ');
    const name = node.getAttribute('aria-label') || labelled || labels || node.innerText || node.getAttribute('placeholder') || node.getAttribute('title') || '';
    let nativeRole=tag;
    if(tag==='a' && node.hasAttribute('href')) nativeRole='link';
    else if(tag==='button' || tag==='input' && ['button','submit','reset','image'].includes(type)) nativeRole='button';
    else if(tag==='select') nativeRole=node.multiple || node.size>1?'listbox':'combobox';
    else if(tag==='input' && ['checkbox','radio'].includes(type)) nativeRole=type;
    else if(tag==='input' && type==='number') nativeRole='spinbutton';
    else if(tag==='input' && type==='range') nativeRole='slider';
    else if(['input','textarea'].includes(tag) || node.isContentEditable) nativeRole='textbox';
    const role=node.getAttribute('role') || nativeRole;
    const options = tag === 'select' ? Array.from(node.options).map((option: any) => ({ value: String(option.value), label: String(option.label), disabled: Boolean(option.disabled || option.parentElement?.disabled), selected: Boolean(option.selected) })) : undefined;
    elements.push({ selector: parts.join(' > '), tag, role, name, href: tag === 'a' ? node.href : '', value: secret || type === 'file' ? '' : String(node.value ?? ''), type, ...(secret?{secret:true}:{}), disabled: Boolean(node.disabled || node.matches(':disabled') || node.getAttribute('aria-disabled')==='true'), selected: Boolean(node.selected), checked: Boolean(node.checked), inForm: Boolean(node.form), ...(type==='file'&&node.form?{formAction:String(node.form.action),formMethod:String(node.form.method)}:{}), editable:Boolean(node.isContentEditable), readOnly:Boolean(node.readOnly || node.getAttribute('aria-readonly')==='true'), ...(options ? { options } : {}) });
  }
  return { url: root.location.href, title: document.title, text: document.body?.innerText ?? '', width: root.innerWidth, height: root.innerHeight, scrollX: root.scrollX, scrollY: root.scrollY, elements };
}

export async function generalDigest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
