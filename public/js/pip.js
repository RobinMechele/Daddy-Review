import { patch } from './util.js';

/**
 * Always-on-top mini window using the Document Picture-in-Picture API
 * (Chrome/Edge 116+). Falls back to a small regular popup window.
 */
export function createPip({ html, bind, onClose }) {
  let win = null;

  function update() {
    if (!win) return;
    const root = win.document.getElementById('pip-root');
    patch(root, html());
    win.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
  }

  async function open() {
    if (win) {
      win.focus();
      return true;
    }
    if (!('documentPictureInPicture' in window)) {
      window.open('/?mini=1', 'daddy-mini', 'popup,width=360,height=540');
      return false;
    }
    win = await window.documentPictureInPicture.requestWindow({ width: 340, height: 500 });
    const doc = win.document;
    doc.title = 'Daddy Review';
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('/styles.css', location.href).href;
    doc.head.append(link);
    doc.body.className = 'pip-body';
    const sprite = document.getElementById('sprite');
    doc.body.innerHTML = `${sprite ? sprite.outerHTML : ''}<div id="pip-root"></div>`;
    bind(doc, win);
    win.addEventListener('pagehide', () => {
      win = null;
      onClose && onClose();
    });
    update();
    return true;
  }

  return {
    open,
    update,
    get window() {
      return win;
    },
    close() {
      if (win) win.close();
    },
  };
}
