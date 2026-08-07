interface IsolationOwner {
  id: symbol;
  focusTarget?: () => HTMLElement | null;
}

interface IsolationState {
  owners: IsolationOwner[];
  priorAriaHidden: string | null;
  priorInert: boolean | undefined;
  tabIndexes: Map<HTMLElement, string | null>;
  observer: MutationObserver;
  focusGuard: (event: FocusEvent) => void;
  redirectingFocus: boolean;
}

const isolationStates = new WeakMap<HTMLElement, IsolationState>();
const FOCUSABLE_CANDIDATES = 'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex], [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls], summary, iframe';
const FOCUSABILITY_ATTRIBUTES = ['href', 'tabindex', 'contenteditable', 'controls', 'disabled', 'type'];

/** Isolates a modal background, including dynamic content, on browsers without native inert support. */
export function isolateModalBackground(background: HTMLElement | null, focusTarget?: () => HTMLElement | null): () => void {
  if (!background) return () => undefined;
  const owner: IsolationOwner = { id: Symbol('modal-isolation-owner'), ...(focusTarget ? { focusTarget } : {}) };
  const active = isolationStates.get(background);
  if (active) {
    active.owners.push(owner);
    return releaseOwner(background, active, owner.id);
  }

  const state = {} as IsolationState;
  state.owners = [owner];
  state.priorAriaHidden = background.getAttribute('aria-hidden');
  state.priorInert = background.inert;
  state.tabIndexes = new Map();
  state.redirectingFocus = false;
  state.focusGuard = (event) => {
    const target = event.target;
    if (state.redirectingFocus || !(target instanceof Node) || !background.contains(target)) return;
    event.preventDefault();
    const destination = [...state.owners].reverse().map((item) => item.focusTarget?.()).find((item): item is HTMLElement => Boolean(item?.isConnected));
    if (!destination) { if (target instanceof HTMLElement) target.blur(); return; }
    state.redirectingFocus = true;
    destination.focus();
    state.redirectingFocus = false;
  };
  state.observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') for (const node of record.addedNodes) isolateTree(state, node);
      else if (record.target instanceof HTMLElement) updateCandidate(state, record.target, record.attributeName);
    }
  });

  isolationStates.set(background, state);
  isolateTree(state, background);
  state.observer.observe(background, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: FOCUSABILITY_ATTRIBUTES });
  document.addEventListener('focusin', state.focusGuard, true);
  background.inert = true;
  background.setAttribute('aria-hidden', 'true');
  return releaseOwner(background, state, owner.id);
}

function isolateTree(state: IsolationState, node: Node): void {
  if (!(node instanceof HTMLElement)) return;
  isolateCandidate(state, node);
  for (const element of node.querySelectorAll<HTMLElement>(FOCUSABLE_CANDIDATES)) isolateCandidate(state, element);
}

function isolateCandidate(state: IsolationState, element: HTMLElement): void {
  if (!element.matches(FOCUSABLE_CANDIDATES)) return;
  if (!state.tabIndexes.has(element)) state.tabIndexes.set(element, element.getAttribute('tabindex'));
  if (element.getAttribute('tabindex') !== '-1') element.setAttribute('tabindex', '-1');
}

function updateCandidate(state: IsolationState, element: HTMLElement, attributeName: string | null): void {
  if (attributeName === 'tabindex' && state.tabIndexes.has(element)) {
    const current = element.getAttribute('tabindex');
    if (current !== '-1') {
      state.tabIndexes.set(element, current);
      if (element.matches(FOCUSABLE_CANDIDATES)) element.setAttribute('tabindex', '-1');
    }
    return;
  }
  isolateCandidate(state, element);
}

function releaseOwner(background: HTMLElement, state: IsolationState, ownerId: symbol): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.owners = state.owners.filter((owner) => owner.id !== ownerId);
    if (state.owners.length > 0 || isolationStates.get(background) !== state) return;
    isolationStates.delete(background);
    state.observer.disconnect();
    document.removeEventListener('focusin', state.focusGuard, true);
    background.inert = state.priorInert ?? false;
    if (state.priorAriaHidden == null) background.removeAttribute('aria-hidden');
    else background.setAttribute('aria-hidden', state.priorAriaHidden);
    for (const [element, tabIndex] of state.tabIndexes) {
      if (tabIndex == null) element.removeAttribute('tabindex');
      else element.setAttribute('tabindex', tabIndex);
    }
  };
}
