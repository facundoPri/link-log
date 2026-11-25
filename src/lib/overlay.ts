// Radix menus, popovers, dialogs and sheets mount into portals with these roles while open. One that is
// animating out (data-state="closed"), and anything inside it, no longer counts, so ⌘K or a paste right after
// Escape still works.
export const overlayOpen = () =>
  [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]')].some(
    (el) => !el.closest('[data-state="closed"]'),
  );

export const isInput = (target: EventTarget | null) =>
  target instanceof HTMLElement && !!target.closest('input,textarea,select,[contenteditable="true"]');
