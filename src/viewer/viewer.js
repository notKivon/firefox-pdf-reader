// Viewer entry point. Boots the PDF view and the outline pane.
// Step 1: neither exists yet, so this only proves the page and bundle load.

const params = new URLSearchParams(window.location.search);
const file = params.get("file");

console.log("[scholar-reader] viewer loaded", file ? { file } : "(no file)");

const status = document.getElementById("status");
if (status) {
  status.textContent = file
    ? `Viewer not implemented yet. Requested: ${file}`
    : "Viewer not implemented yet.";
}
