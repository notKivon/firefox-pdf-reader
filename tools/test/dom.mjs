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
  click() { for (const fn of this.listeners.click ?? []) fn(); }
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
