// One DOM helper, shared by everything that draws into the pane.
//
// DOM calls rather than innerHTML throughout: every string these build is text
// that came out of a PDF or out of a model, and neither is trusted markup.
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
