// One request to the background router, for the pages (viewer and settings).
//
// The router answers a failure with `{error, message}` rather than throwing,
// because an Error does not survive the structured clone. This turns that back
// into a throw, so each caller's own error path — a note, a status line, an
// error state in the pane — is the one that reports it.
export async function ask(message) {
  const reply = await browser.runtime.sendMessage(message);
  if (reply === undefined) throw new Error(`the background did not answer "${message.type}".`);
  if (reply?.error) throw new Error(reply.message ?? reply.error);
  return reply;
}
