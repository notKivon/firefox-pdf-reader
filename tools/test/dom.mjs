// A DOM small enough to keep in the repo. Enough of one for the outline pane
// and the confirm card, which are contracts about rendered words and about what
// a click does — neither testable against real Firefox from Node.
export class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.className = "";
    this._text = "";
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(" "); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ""; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  setAttribute(name, value) { (this.attrs ??= {})[name] = String(value); }
  getAttribute(name) { return this.attrs?.[name] ?? null; }
  // Enough for the jump guard, which asks whether a selection is inside it.
  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains?.(node));
  }
  // Enough of one for the scroll-spy's current-section marker, which is a class
  // and is therefore invisible to a test without it.
  get classList() {
    const node = this;
    const parts = () => node.className.split(" ").filter(Boolean);
    return {
      add(name) { if (!parts().includes(name)) node.className = [...parts(), name].join(" "); },
      remove(name) { node.className = parts().filter((c) => c !== name).join(" "); },
      contains(name) { return parts().includes(name); },
    };
  }
  click() { for (const fn of this.listeners.click ?? []) fn(); }
  keydown(key) {
    let defaultPrevented = false;
    const event = { key, preventDefault() { defaultPrevented = true; } };
    for (const fn of this.listeners.keydown ?? []) fn(event);
    return defaultPrevented;
  }
  find(className) {
    if (this.className.split(" ").includes(className)) return this;
    for (const child of this.children) {
      const hit = child.find(className);
      if (hit) return hit;
    }
    return null;
  }
  findAll(className, out = []) {
    if (this.className.split(" ").includes(className)) out.push(this);
    for (const child of this.children) child.findAll(className, out);
    return out;
  }
}
globalThis.document = { createElement: (tag) => new FakeNode(tag) };
