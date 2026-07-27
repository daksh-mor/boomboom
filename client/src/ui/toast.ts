let container: HTMLDivElement | null = null;

function getContainer(): HTMLDivElement {
  if (!container || !container.isConnected) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

export function showToast(message: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  getContainer().appendChild(el);

  // Two frames so the enter transition reliably kicks in after insertion.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('toast-show'));
  });

  window.setTimeout(() => {
    el.classList.remove('toast-show');
    window.setTimeout(() => el.remove(), 350);
  }, 2800);
}
