/**
 * Tiny DOM helpers.
 *
 * Everything user-entered goes in as a text node, never as innerHTML — promo
 * titles and notes are free text pasted out of marketing emails.
 */

/**
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {(Node|string|null|undefined)[]} [children]
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list') {
      /** @type {any} */ (node)[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** @param {string} selector @param {ParentNode} [root] */
export function $(selector, root = document) {
  const found = root.querySelector(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return /** @type {HTMLElement} */ (found);
}

/** @param {HTMLElement} node @param {(Node|null)[]} children */
export function replaceChildren(node, children) {
  node.replaceChildren(...children.filter(Boolean).map((c) => /** @type {Node} */ (c)));
}

/**
 * Briefly swap a button's label to confirm an action, then put it back.
 * @param {HTMLElement} button
 * @param {string} message
 */
export function flash(button, message) {
  if (button.dataset.flashing === '1') return;
  const original = button.textContent ?? '';
  button.dataset.flashing = '1';
  button.textContent = message;
  button.classList.add('is-confirmed');
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove('is-confirmed');
    delete button.dataset.flashing;
  }, 1200);
}
